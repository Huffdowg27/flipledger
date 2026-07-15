/**
 * POST /api/incoming/[id]  — actions on one incoming purchase.
 *
 * { action: 'receive', receiptKey, expectedQuantityReceived, quantityGood,
 *   quantityIssue?, issueType?, issueNote?, sku?, binLocation? }
 *   Good units become a real inventory_ledger lot (this is the moment the
 *   purchase enters FIFO/valuation). Issue units land in receiving_issues —
 *   they arrived, so they count toward quantity_received, but they create NO
 *   lot until their issue resolves (resolution decides the accounting).
 *   `sku` overrides/relinks the SKU (the receive-time mismatch fix).
 *   Writes the new received count back to Airtable's "Received" field
 *   (best-effort) so his existing views stay truthful.
 *
 * { action: 'reconcile', receiptKey, expectedQuantityReceived,
 *   inventoryLedgerId, quantity, confirmMismatch? }
 *   Attributes legacy received units to an operator-selected existing lot.
 *   This records immutable receipt identity and updates the incoming purchase,
 *   but never changes the selected lot or reruns FIFO.
 *
 * { action: 'cancel', note? }   — refunded/never coming; no lot, locked.
 * { action: 'snooze', days }    — still waiting; re-ages from today.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { createHash } from 'node:crypto';
import { recalculateFIFO } from '@/lib/fifo';
import { ReceiptConflictError, reconcileIncomingPurchase, writeBackReceived } from '@/lib/incoming-receipts';

interface IncomingPurchaseRow {
  airtable_record_id: string | null;
  asin: string | null;
  sku: string | null;
  quantity: number;
  quantity_received: number;
  unit_cost_cents: number;
  ordered_at: string | null;
  status: string;
  received_at: string | null;
  inventory_ledger_id: number | null;
  receipt_allocation_baseline: number;
  receipt_identity_started_at: string | null;
}

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const purchaseId = parseInt(id);
  if (!Number.isFinite(purchaseId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const db = getDb();
  try {
    const p = db.prepare('SELECT * FROM incoming_purchases WHERE id = ?').get(purchaseId) as any;
    if (!p) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });
    const now = new Date().toISOString();

    if (body.action === 'snooze') {
      const days = Math.max(1, parseInt(body.days) || 7);
      const until = new Date(Date.now() + days * 86400000).toISOString();
      db.prepare('UPDATE incoming_purchases SET snoozed_until = ?, updated_at = ? WHERE id = ?').run(until, now, purchaseId);
      return NextResponse.json({ success: true, snoozedUntil: until });
    }

    if (body.action === 'cancel') {
      if (p.status === 'received') return NextResponse.json({ error: 'Already received' }, { status: 400 });
      db.prepare(`
        UPDATE incoming_purchases SET status = 'cancelled', notes = COALESCE(notes || char(10), '') || ?, updated_at = ? WHERE id = ?
      `).run(`Cancelled ${now.slice(0, 10)}${body.note ? `: ${body.note}` : ''}`, now, purchaseId);
      return NextResponse.json({ success: true });
    }

    if (body.action === 'reconcile') {
      const receiptKey = typeof body.receiptKey === 'string' ? body.receiptKey.trim() : '';
      if (!receiptKey || receiptKey.length > 200) {
        return NextResponse.json({ error: 'receiptKey is required' }, { status: 400 });
      }
      const expectedQuantityReceived = Number(body.expectedQuantityReceived);
      if (!Number.isInteger(expectedQuantityReceived) || expectedQuantityReceived < 0) {
        return NextResponse.json({ error: 'expectedQuantityReceived must be a non-negative integer' }, { status: 400 });
      }
      const inventoryLedgerId = Number(body.inventoryLedgerId);
      if (!Number.isInteger(inventoryLedgerId) || inventoryLedgerId <= 0) {
        return NextResponse.json({ error: 'inventoryLedgerId must be a positive integer' }, { status: 400 });
      }
      const quantity = Number(body.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return NextResponse.json({ error: 'quantity must be a positive integer' }, { status: 400 });
      }
      if (body.confirmMismatch !== undefined && typeof body.confirmMismatch !== 'boolean') {
        return NextResponse.json({ error: 'confirmMismatch must be a boolean' }, { status: 400 });
      }
      const confirmMismatch = body.confirmMismatch === true;
      const result = await reconcileIncomingPurchase(db, {
        purchaseId,
        receiptKey,
        expectedQuantityReceived,
        inventoryLedgerId,
        quantity,
        confirmMismatch,
      });
      return NextResponse.json(result);
    }

    if (body.action !== 'receive') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

    const receiptKey = typeof body.receiptKey === 'string' ? body.receiptKey.trim() : '';
    if (!receiptKey || receiptKey.length > 200) {
      return NextResponse.json({ error: 'receiptKey is required' }, { status: 400 });
    }
    const expectedQuantityReceived = Number(body.expectedQuantityReceived);
    if (!Number.isInteger(expectedQuantityReceived) || expectedQuantityReceived < 0) {
      return NextResponse.json({ error: 'expectedQuantityReceived must be a non-negative integer' }, { status: 400 });
    }

    const good = Math.max(0, Math.floor(Number(body.quantityGood) || 0));
    const issue = Math.max(0, Math.floor(Number(body.quantityIssue) || 0));
    if (good + issue === 0) return NextResponse.json({ error: 'Nothing to receive' }, { status: 400 });
    const issueType = typeof body.issueType === 'string' ? body.issueType.trim() : '';
    if (issue > 0 && !issueType) return NextResponse.json({ error: 'issueType required when receiving issue units' }, { status: 400 });

    const requestedSku = typeof body.sku === 'string' && body.sku.trim() ? body.sku.trim() : null;
    const issueNote = typeof body.issueNote === 'string' && body.issueNote.trim() ? body.issueNote.trim() : null;
    const binLocation = typeof body.binLocation === 'string' && body.binLocation.trim() ? body.binLocation.trim() : null;
    const payloadHash = createHash('sha256').update(JSON.stringify({
      purchaseId,
      expectedQuantityReceived,
      good,
      issue,
      issueType: issueType || null,
      issueNote,
      requestedSku,
      binLocation,
    })).digest('hex');

    const tx = db.transaction(() => {
      const prior = db.prepare(`
        SELECT payload_hash, result_json
        FROM incoming_receipt_allocations
        WHERE receipt_key = ?
      `).get(receiptKey) as { payload_hash: string; result_json: string } | undefined;
      if (prior) {
        if (prior.payload_hash !== payloadHash) {
          throw new ReceiptConflictError('Receipt key was already used with different content');
        }
        return {
          response: { ...JSON.parse(prior.result_json), replayed: true },
          applied: false,
          airtableRecordId: null,
          newReceived: null,
          sku: null,
        };
      }

      const current = db.prepare('SELECT * FROM incoming_purchases WHERE id = ?').get(purchaseId) as IncomingPurchaseRow | undefined;
      if (!current) throw new Error('Purchase not found');
      if (current.quantity_received !== expectedQuantityReceived) {
        throw new ReceiptConflictError(
          `Incoming purchase changed since this receive started (expected ${expectedQuantityReceived}, current ${current.quantity_received})`
        );
      }

      const remaining = current.quantity - current.quantity_received;
      if (good + issue > remaining) {
        throw new ReceiptConflictError(`Receiving ${good + issue} but only ${remaining} outstanding`);
      }

      // SKU: explicit override (relink) > stored > adopt live SC SKU by ASIN.
      let sku: string | null = requestedSku || current.sku || null;
      if (!sku && current.asin) {
        const live = db.prepare(
          "SELECT sku FROM merchant_listings WHERE asin = ? AND marketplace = 'amazon' ORDER BY last_synced DESC"
        ).all(current.asin) as { sku: string }[];
        if (live.length === 1) sku = live[0].sku;
      }
      if (!sku && good > 0) {
        throw new Error('No SKU known for this purchase — pick a Seller Central SKU (or enter one) to receive against.');
      }
      const skuChanged = sku !== current.sku;
      let inventoryLedgerId: number | null = current.inventory_ledger_id;

      if (good > 0) {
        if (inventoryLedgerId) {
          // Subsequent partial receive: grow the existing lot.
          db.prepare(`
            UPDATE inventory_ledger SET quantity = quantity + ?, quantity_remaining = quantity_remaining + ?,
              quantity_received = COALESCE(quantity_received, 0) + ?, received_at = ?
            WHERE id = ?
          `).run(good, good, good, now, inventoryLedgerId);
        } else {
          const lot = db.prepare(`
            INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, quantity_received,
              date_purchased, received_at, bin_location, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(current.asin, sku, current.unit_cost_cents, good, good, good, current.ordered_at || now, now, binLocation, now);
          inventoryLedgerId = Number(lot.lastInsertRowid);
        }
      }

      let receivingIssueId: number | null = null;
      if (issue > 0) {
        const issueResult = db.prepare(`
          INSERT INTO receiving_issues (incoming_purchase_id, inventory_ledger_id, asin, sku, quantity, issue_type, note, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
        `).run(purchaseId, inventoryLedgerId, current.asin, sku, issue, issueType, issueNote, now, now);
        receivingIssueId = Number(issueResult.lastInsertRowid);
      }

      const newReceived = current.quantity_received + good + issue;
      const status = newReceived >= current.quantity ? 'received' : 'partial';
      const receiptAllocationBaseline = current.receipt_identity_started_at
        ? Number(current.receipt_allocation_baseline) || 0
        : current.quantity_received;
      db.prepare(`
        UPDATE incoming_purchases SET quantity_received = ?, status = ?, received_at = ?,
          inventory_ledger_id = ?, sku = ?, receipt_allocation_baseline = ?,
          receipt_identity_started_at = COALESCE(receipt_identity_started_at, ?),
          updated_at = ?
        WHERE id = ?
      `).run(
        newReceived,
        status,
        newReceived >= current.quantity ? now : current.received_at,
        inventoryLedgerId,
        sku,
        receiptAllocationBaseline,
        now,
        now,
        purchaseId
      );

      const response = {
        success: true,
        inventoryLedgerId,
        skuChanged,
        sku,
        status,
        replayed: false,
      };
      db.prepare(`
        INSERT INTO incoming_receipt_allocations (
          receipt_key, payload_hash, incoming_purchase_id, inventory_ledger_id,
          receiving_issue_id, quantity_good, quantity_issue, sku, source,
          result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'receive', ?, ?)
      `).run(
        receiptKey,
        payloadHash,
        purchaseId,
        good > 0 ? inventoryLedgerId : null,
        receivingIssueId,
        good,
        issue,
        sku,
        JSON.stringify(response),
        now,
      );

      return {
        response,
        applied: true,
        airtableRecordId: current.airtable_record_id as string | null,
        newReceived,
        sku,
      };
    });
    const outcome = tx.immediate();

    // FIFO sees the new lot (runs in-process where FIFO_IL_INFINITE is set).
    if (outcome.applied && good > 0 && outcome.sku) {
      try { recalculateFIFO({ sku: outcome.sku }); } catch (err) { console.warn('[incoming] FIFO recalc failed:', err); }
    }

    if (outcome.applied && outcome.newReceived != null) {
      const damagedTotal = (db.prepare(
        "SELECT COALESCE(SUM(quantity), 0) as q FROM receiving_issues WHERE incoming_purchase_id = ?"
      ).get(purchaseId) as any).q;
      await writeBackReceived(db, outcome.airtableRecordId, outcome.newReceived, damagedTotal);
    }

    return NextResponse.json(outcome.response);
  } catch (err) {
    if (err instanceof ReceiptConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
