import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { recalculateFIFO } from '@/lib/fifo';
import { ReceiptConflictError, reconcileIncomingPurchase } from '@/lib/incoming-receipts';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

interface IncomingPurchaseForReceipt {
  id: number;
  asin: string | null;
  sku: string | null;
  quantity: number;
  quantity_received: number;
  ordered_at: string | null;
  status: string;
}

function receiptKeyForMfnReceive(input: {
  receiptKeyInput: string;
  incomingPurchaseId: number;
  sku: string;
  batchId: number | null;
  quantity: number;
  expectedQuantityReceived: number;
}) {
  if (input.receiptKeyInput) return input.receiptKeyInput;
  return [
    'mfn-batch-receive',
    input.incomingPurchaseId,
    input.sku,
    input.batchId ?? 'standalone',
    input.quantity,
    input.expectedQuantityReceived,
  ].join(':');
}

// POST /api/data/inventory-lots/create-mfn-local-lot
//
// Creates a local inventory_ledger lot for an MFN SKU that has no local lot.
//
// Guard: if a lot already exists for this SKU with quantity_remaining > 0,
// returns the existing lot without creating a duplicate.
//
// Input: {
//   sku: string               -- required
//   asin?: string
//   quantity: number          -- physical qty on hand (required, > 0)
//   buyCents: number          -- cost in integer cents (required, >= 0)
//   listPriceCents?: number   -- selling price in integer cents
//   condition?: string
//   binLocation?: string
//   merchantShippingGroupName?: string
//   markReceived?: boolean    -- if true, sets received_at = now
//   markInspected?: boolean   -- if true (and markReceived), sets inspected_at = now
//   datePurchased?: string    -- ISO date string, defaults to now
//   batchId?: number          -- if provided, associates this lot with a listing_batches row.
//                                For the existing-lot path: claims the lot into this batch
//                                only when its current batch_id IS NULL (never re-assigns).
//                                Setting batch_id does not touch buy_price, quantity,
//                                quantity_remaining, or date_purchased — FIFO is unaffected.
//   incomingPurchaseId?: number
//   expectedQuantityReceived?: number
//   receiptKey?: string        -- optional operator-confirmed buy-sheet
//                                reconciliation; never auto-selected.
// }
//
// Output: {
//   created: boolean
//   existingLotUsed: boolean
//   lot: { id, sku, asin, buy_price, quantity, quantity_remaining,
//          bin_location, condition, list_price_cents,
//          merchant_shipping_group_name, received_at, inspected_at,
//          date_purchased, created_at }
// }
export async function POST(request: NextRequest) {
  const t0 = Date.now();
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const sku = typeof body.sku === 'string' ? body.sku.trim() : '';
  if (!sku) {
    return NextResponse.json({ error: 'sku is required' }, { status: 400 });
  }

  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: 'quantity must be a positive number' }, { status: 400 });
  }

  const buyCents = Number(body.buyCents);
  if (!Number.isFinite(buyCents) || buyCents < 0) {
    return NextResponse.json({ error: 'buyCents must be a non-negative integer' }, { status: 400 });
  }

  const asin              = typeof body.asin === 'string' ? body.asin.trim() || null : null;
  const listPriceCents    = body.listPriceCents != null ? Number(body.listPriceCents) : null;
  const condition         = typeof body.condition === 'string' ? body.condition.trim() || null : null;
  const binLocation       = typeof body.binLocation === 'string' ? body.binLocation.trim() || null : null;
  const shippingTemplate  = typeof body.merchantShippingGroupName === 'string' ? body.merchantShippingGroupName.trim() || null : null;
  const markReceived      = body.markReceived === true;
  const markInspected     = body.markInspected === true;
  const datePurchased     = typeof body.datePurchased === 'string' && body.datePurchased.trim()
    ? body.datePurchased.trim()
    : null;
  const batchIdRaw        = body.batchId;
  const batchId           = batchIdRaw != null && Number.isFinite(Number(batchIdRaw)) && Number(batchIdRaw) > 0
    ? Math.round(Number(batchIdRaw))
    : null;
  const incomingPurchaseIdRaw = body.incomingPurchaseId;
  const incomingPurchaseId = incomingPurchaseIdRaw != null ? Number(incomingPurchaseIdRaw) : null;
  if (incomingPurchaseId != null && (!Number.isInteger(incomingPurchaseId) || incomingPurchaseId <= 0)) {
    return NextResponse.json({ error: 'incomingPurchaseId must be a positive integer' }, { status: 400 });
  }
  const expectedQuantityReceivedRaw = body.expectedQuantityReceived;
  const expectedQuantityReceived = expectedQuantityReceivedRaw != null ? Number(expectedQuantityReceivedRaw) : null;
  if (incomingPurchaseId != null && (expectedQuantityReceived == null || !Number.isInteger(expectedQuantityReceived) || expectedQuantityReceived < 0)) {
    return NextResponse.json({ error: 'expectedQuantityReceived must be a non-negative integer when incomingPurchaseId is provided' }, { status: 400 });
  }
  const receiptKeyInput = typeof body.receiptKey === 'string' ? body.receiptKey.trim() : '';
  if (receiptKeyInput.length > 200) {
    return NextResponse.json({ error: 'receiptKey must be 200 characters or fewer' }, { status: 400 });
  }
  const receiptQuantity = Math.round(quantity);

  const db = getDb();
  let createdLotIdForCleanup: number | null = null;
  try {
    const now = new Date().toISOString();
    const reconcileReceiptKey = incomingPurchaseId != null
      ? receiptKeyForMfnReceive({
          receiptKeyInput,
          incomingPurchaseId,
          sku,
          batchId,
          quantity: receiptQuantity,
          expectedQuantityReceived: expectedQuantityReceived as number,
        })
      : null;
    const incoming = incomingPurchaseId != null
      ? db.prepare(`
          SELECT id, asin, sku, quantity, quantity_received, ordered_at, status
          FROM incoming_purchases
          WHERE id = ?
        `).get(incomingPurchaseId) as IncomingPurchaseForReceipt | undefined
      : undefined;
    if (incomingPurchaseId != null) {
      if (!incoming) {
        db.close();
        return NextResponse.json({ error: 'Incoming purchase not found' }, { status: 404 });
      }
      const isReceiptReplay = !!db.prepare(`
        SELECT 1 FROM incoming_receipt_allocations
        WHERE receipt_key = ?
      `).get(reconcileReceiptKey);
      if (!isReceiptReplay) {
        if (incoming.status !== 'on_order' && incoming.status !== 'partial') {
          db.close();
          return NextResponse.json({ error: `Only open incoming purchases can be reconciled (current status: ${incoming.status})` }, { status: 409 });
        }
        if (incoming.quantity_received !== expectedQuantityReceived) {
          db.close();
          return NextResponse.json({
            error: `Incoming purchase changed since this reconciliation started (expected ${expectedQuantityReceived}, current ${incoming.quantity_received})`,
          }, { status: 409 });
        }
        if (receiptQuantity > incoming.quantity - incoming.quantity_received) {
          db.close();
          return NextResponse.json({
            error: `Reconciling ${receiptQuantity} but only ${incoming.quantity - incoming.quantity_received} units are outstanding`,
          }, { status: 409 });
        }
        if (!asin || !incoming.asin || incoming.asin !== asin) {
          db.close();
          return NextResponse.json({ error: 'Incoming purchase ASIN does not match this MFN receipt' }, { status: 409 });
        }
      }
    }

    // --- Guard: return existing lot if one already exists ---
    const tGuard = Date.now();
    const existing = db.prepare(`
      SELECT
        id, sku, asin, buy_price, quantity, quantity_remaining,
        bin_location, condition, list_price_cents,
        merchant_shipping_group_name, received_at, inspected_at,
        date_purchased, batch_id, created_at
      FROM inventory_ledger
      WHERE sku = ? AND quantity_remaining > 0
      ORDER BY date_purchased DESC
      LIMIT 1
    `).get(sku) as Record<string, unknown> | undefined;
    const guardMs = Date.now() - tGuard;

    if (existing) {
      // Claim into batch only when the existing lot is unclaimed (batch_id IS NULL).
      // Never re-assigns a lot already belonging to another batch — that protects
      // batch boundaries and prevents accidental cross-batch theft of stock.
      let claimedNow = false;
      if (batchId != null && existing.batch_id == null) {
        db.prepare(`UPDATE inventory_ledger SET batch_id = ? WHERE id = ? AND batch_id IS NULL`)
          .run(batchId, existing.id);
        existing.batch_id = batchId;
        claimedNow = true;
      }
      let incomingReconcile: Awaited<ReturnType<typeof reconcileIncomingPurchase>> | null = null;
      if (incomingPurchaseId != null && incoming) {
        incomingReconcile = await reconcileIncomingPurchase(db, {
          purchaseId: incomingPurchaseId,
          receiptKey: reconcileReceiptKey as string,
          expectedQuantityReceived: expectedQuantityReceived as number,
          inventoryLedgerId: Number(existing.id),
          quantity: receiptQuantity,
          confirmMismatch: true,
        });
        if (incoming.ordered_at && existing.date_purchased !== incoming.ordered_at) {
          db.prepare('UPDATE inventory_ledger SET date_purchased = ? WHERE id = ?')
            .run(incoming.ordered_at, existing.id);
          existing.date_purchased = incoming.ordered_at;
        }
      }
      const totalMs = Date.now() - t0;
      console.log(`[create-mfn-local-lot] sku=${sku} existing-lot-returned batch_id=${existing.batch_id ?? 'null'} claimed=${claimedNow} total=${totalMs}ms guard=${guardMs}ms`);
      db.close();
      if (incomingReconcile) {
        try {
          recalculateFIFO({ sku, asin: asin ?? (typeof existing.asin === 'string' ? existing.asin : undefined) });
        } catch (err) {
          console.warn('[create-mfn-local-lot] FIFO recalc failed after reconcile:', err);
        }
      }
      return NextResponse.json({
        created: false,
        existingLotUsed: true,
        claimedIntoBatch: claimedNow,
        lot: existing,
        incomingReconcile,
        message: 'An existing lot with remaining quantity was found — no new lot created.',
      });
    }

    // --- Insert new lot ---
    const dateP       = incoming?.ordered_at ?? datePurchased ?? now;
    const receivedAt  = markReceived ? now : null;
    const inspectedAt = (markReceived && markInspected) ? now : null;

    const lpCents = listPriceCents != null && Number.isFinite(listPriceCents) && listPriceCents >= 0
      ? Math.round(listPriceCents)
      : null;

    const tInsert = Date.now();
    const result = db.prepare(`
      INSERT INTO inventory_ledger (
        asin, sku, buy_price, quantity, quantity_remaining,
        date_purchased, bin_location, condition, list_price_cents,
        merchant_shipping_group_name, received_at, inspected_at,
        quantity_received, batch_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asin ?? sku,
      sku,
      Math.round(buyCents),
      receiptQuantity,
      receiptQuantity,       // quantity_remaining = quantity for a fresh lot
      dateP,
      binLocation,
      condition,
      lpCents,
      shippingTemplate,
      receivedAt,
      inspectedAt,
      markReceived ? receiptQuantity : null,  // quantity_received
      batchId,
      now
    );
    const insertMs = Date.now() - tInsert;

    const newId = Number(result.lastInsertRowid);
    createdLotIdForCleanup = newId;

    // Read back the inserted row to return to the client
    const tReadback = Date.now();
    const lot = db.prepare(`
      SELECT
        id, sku, asin, buy_price, quantity, quantity_remaining,
        bin_location, condition, list_price_cents,
        merchant_shipping_group_name, received_at, inspected_at,
        quantity_received, batch_id, date_purchased, created_at
      FROM inventory_ledger WHERE id = ?
    `).get(newId) as Record<string, unknown>;
    const readbackMs = Date.now() - tReadback;

    let incomingReconcile: Awaited<ReturnType<typeof reconcileIncomingPurchase>> | null = null;
    if (incomingPurchaseId != null && incoming) {
      try {
        incomingReconcile = await reconcileIncomingPurchase(db, {
          purchaseId: incomingPurchaseId,
          receiptKey: reconcileReceiptKey as string,
          expectedQuantityReceived: expectedQuantityReceived as number,
          inventoryLedgerId: newId,
          quantity: receiptQuantity,
          confirmMismatch: true,
        });
      } catch (err) {
        db.prepare(`
          DELETE FROM inventory_ledger
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM incoming_receipt_allocations
              WHERE inventory_ledger_id = ?
            )
        `).run(newId, newId);
        throw err;
      }
    }

    db.close();

    // Recalculate FIFO for this SKU so any past sales pick up the new lot/date.
    const tFifo = Date.now();
    recalculateFIFO({ sku, asin: asin ?? undefined });
    const fifoMs = Date.now() - tFifo;

    const totalMs = Date.now() - t0;
    console.log(`[create-mfn-local-lot] sku=${sku} created lot_id=${newId} total=${totalMs}ms (guard=${guardMs}ms insert=${insertMs}ms readback=${readbackMs}ms fifo=${fifoMs}ms)`);

    return NextResponse.json({ created: true, existingLotUsed: false, lot, incomingReconcile });
  } catch (err) {
    if (db.open) db.close();
    const totalMs = Date.now() - t0;
    console.error(`[create-mfn-local-lot] sku=${sku} error total=${totalMs}ms err=${String(err)}`);
    const status = err instanceof ReceiptConflictError ? 409 : 500;
    return NextResponse.json({
      error: err instanceof Error ? err.message : String(err),
      createdLotCleanedUp: createdLotIdForCleanup != null,
    }, { status });
  }
}
