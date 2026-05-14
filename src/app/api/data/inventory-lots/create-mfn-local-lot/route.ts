import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { recalculateFIFO } from '@/lib/fifo';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
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

  const db = getDb();
  try {
    const now = new Date().toISOString();

    // --- Guard: return existing lot if one already exists ---
    const existing = db.prepare(`
      SELECT
        id, sku, asin, buy_price, quantity, quantity_remaining,
        bin_location, condition, list_price_cents,
        merchant_shipping_group_name, received_at, inspected_at,
        date_purchased, created_at
      FROM inventory_ledger
      WHERE sku = ? AND quantity_remaining > 0
      ORDER BY date_purchased DESC
      LIMIT 1
    `).get(sku) as Record<string, unknown> | undefined;

    if (existing) {
      return NextResponse.json({
        created: false,
        existingLotUsed: true,
        lot: existing,
        message: 'An existing lot with remaining quantity was found — no new lot created.',
      });
    }

    // --- Insert new lot ---
    const dateP       = datePurchased ?? now;
    const receivedAt  = markReceived ? now : null;
    const inspectedAt = (markReceived && markInspected) ? now : null;

    const lpCents = listPriceCents != null && Number.isFinite(listPriceCents) && listPriceCents >= 0
      ? Math.round(listPriceCents)
      : null;

    const result = db.prepare(`
      INSERT INTO inventory_ledger (
        asin, sku, buy_price, quantity, quantity_remaining,
        date_purchased, bin_location, condition, list_price_cents,
        merchant_shipping_group_name, received_at, inspected_at,
        quantity_received, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asin ?? sku,
      sku,
      Math.round(buyCents),
      Math.round(quantity),
      Math.round(quantity),       // quantity_remaining = quantity for a fresh lot
      dateP,
      binLocation,
      condition,
      lpCents,
      shippingTemplate,
      receivedAt,
      inspectedAt,
      markReceived ? Math.round(quantity) : null,  // quantity_received
      now
    );

    const newId = Number(result.lastInsertRowid);

    // Read back the inserted row to return to the client
    const lot = db.prepare(`
      SELECT
        id, sku, asin, buy_price, quantity, quantity_remaining,
        bin_location, condition, list_price_cents,
        merchant_shipping_group_name, received_at, inspected_at,
        quantity_received, date_purchased, created_at
      FROM inventory_ledger WHERE id = ?
    `).get(newId) as Record<string, unknown>;

    db.close();

    // Recalculate FIFO for this SKU so any past sales pick up the new lot
    recalculateFIFO({ sku, asin: asin ?? undefined });

    return NextResponse.json({ created: true, existingLotUsed: false, lot });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
