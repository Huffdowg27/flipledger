import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { recalculateFIFO } from '@/lib/fifo';
import { writeBackReceived } from '@/lib/incoming-receipts';

const ISSUE_TYPES = new Set(['damaged', 'wrong_item', 'not_as_described', 'other']);

interface InventoryLotRow {
  id: number;
  asin: string | null;
  sku: string | null;
  buy_price: number;
  quantity: number;
  quantity_remaining: number;
  quantity_received: number | null;
}

// Thrown inside the write transaction when the lot no longer matches the
// state this request was validated against; maps to HTTP 409.
class LotConflictError extends Error {}

interface IncomingPurchaseRow {
  id: number;
  airtable_record_id: string | null;
  quantity: number;
  quantity_received: number;
  status: string;
  received_at: string | null;
  receipt_allocation_baseline: number;
  receipt_identity_started_at: string | null;
}

interface ReportIssueBody {
  ilId?: unknown;
  quantity?: unknown;
  issueType?: unknown;
  note?: unknown;
  expectedLotQuantity?: unknown;
}

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function jsonError(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

function linkedIncomingPurchase(db: Database.Database, inventoryLedgerId: number): IncomingPurchaseRow | null {
  const candidates = db.prepare(`
    WITH candidates AS (
      SELECT id FROM incoming_purchases WHERE inventory_ledger_id = ?
      UNION
      SELECT incoming_purchase_id AS id
      FROM incoming_receipt_allocations
      WHERE inventory_ledger_id = ?
    )
    SELECT ip.*
    FROM incoming_purchases ip
    JOIN candidates c ON c.id = ip.id
    ORDER BY ip.id
  `).all(inventoryLedgerId, inventoryLedgerId) as IncomingPurchaseRow[];
  return candidates.length === 1 ? candidates[0] : null;
}

export async function POST(request: NextRequest) {
  let body: ReportIssueBody;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON');
  }

  const ilId = Number(body.ilId);
  if (!Number.isInteger(ilId) || ilId <= 0) {
    return jsonError('ilId must be a positive integer');
  }
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return jsonError('quantity must be an integer >= 1');
  }
  const issueType = typeof body.issueType === 'string' ? body.issueType.trim() : '';
  if (!ISSUE_TYPES.has(issueType)) {
    return jsonError('issueType must be one of: damaged, wrong_item, not_as_described, other');
  }
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
  // Expected-state check (same invariant as /incoming's receive path): the
  // client states what it believes the lot quantity is. A retry after a lost
  // response, or a stale tab, fails this check instead of shrinking twice.
  const expectedLotQuantity = Number(body.expectedLotQuantity);
  if (!Number.isInteger(expectedLotQuantity) || expectedLotQuantity < 0) {
    return jsonError('expectedLotQuantity must be a non-negative integer (the lot quantity this action was based on)');
  }
  const normalizedBody = { ilId, quantity, issueType, note };
  const payloadHash = createHash('sha256').update(JSON.stringify(normalizedBody)).digest('hex');

  const db = getDb();
  try {
    const lot = db.prepare(`
      SELECT id, asin, sku, buy_price, quantity, quantity_remaining, quantity_received
      FROM inventory_ledger
      WHERE id = ?
    `).get(ilId) as InventoryLotRow | undefined;
    if (!lot) return jsonError('Lot not found', 404);
    if (lot.quantity !== expectedLotQuantity) {
      return jsonError(
        `Lot changed since this form was opened (expected quantity ${expectedLotQuantity}, current ${lot.quantity}). Refresh and retry — the issue may already be logged.`,
        409,
      );
    }
    if (lot.quantity_remaining < quantity) {
      return jsonError(`Issue quantity ${quantity} exceeds lot quantity remaining ${lot.quantity_remaining}`);
    }
    const unreceived = lot.quantity - Number(lot.quantity_received ?? 0);
    if (unreceived < quantity) {
      return jsonError(`Issue quantity ${quantity} exceeds unreceived lot units ${unreceived}`);
    }

    const linkedIncoming = linkedIncomingPurchase(db, ilId);
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      // removed_unit_cost_cents snapshots the basis this shrink removes —
      // resolutions price from it even if the lot's buy_price is edited later.
      const issueResult = db.prepare(`
        INSERT INTO receiving_issues (
          incoming_purchase_id, inventory_ledger_id, asin, sku, quantity,
          issue_type, note, status, lot_shrunk, removed_unit_cost_cents,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?)
      `).run(
        linkedIncoming?.id ?? null,
        ilId,
        lot.asin,
        lot.sku,
        quantity,
        issueType,
        note,
        lot.buy_price,
        now,
        now,
      );
      const issueId = Number(issueResult.lastInsertRowid);

      // Conditional shrink: re-asserts the validated state inside the write
      // transaction, so even a request racing a cross-process writer (sync
      // worker, second tab) cannot double-shrink.
      const shrink = db.prepare(`
        UPDATE inventory_ledger
        SET quantity = quantity - ?, quantity_remaining = quantity_remaining - ?
        WHERE id = ? AND quantity = ? AND quantity_remaining >= ?
      `).run(quantity, quantity, ilId, expectedLotQuantity, quantity);
      if (shrink.changes !== 1) {
        throw new LotConflictError(
          `Lot changed while logging this issue (expected quantity ${expectedLotQuantity}). Refresh and retry — the issue may already be logged.`,
        );
      }

      // Only bump the incoming row's received count when it is still
      // receivable (same guards as /incoming's receive + reconcile paths):
      // enough outstanding units, and not cancelled/closed — a cancelled
      // purchase must never be resurrected to partial/received. The issue
      // stays linked either way so resolutions price from the purchase's
      // unit cost.
      const incomingBumpable = linkedIncoming
        && ['on_order', 'partial'].includes(linkedIncoming.status)
        && (linkedIncoming.quantity - linkedIncoming.quantity_received) >= quantity;
      let newReceived: number | null = null;
      if (linkedIncoming && incomingBumpable) {
        newReceived = linkedIncoming.quantity_received + quantity;
        const status = newReceived >= linkedIncoming.quantity ? 'received' : 'partial';
        const receiptAllocationBaseline = linkedIncoming.receipt_identity_started_at
          ? Number(linkedIncoming.receipt_allocation_baseline) || 0
          : linkedIncoming.quantity_received;
        db.prepare(`
          UPDATE incoming_purchases
          SET quantity_received = ?, status = ?, received_at = ?,
            inventory_ledger_id = ?, receipt_allocation_baseline = ?,
            receipt_identity_started_at = COALESCE(receipt_identity_started_at, ?),
            updated_at = ?
          WHERE id = ?
        `).run(
          newReceived,
          status,
          newReceived >= linkedIncoming.quantity ? now : linkedIncoming.received_at,
          ilId,
          receiptAllocationBaseline,
          now,
          now,
          linkedIncoming.id,
        );

        const responsePreview = {
          success: true,
          issueId,
          lotQuantity: lot.quantity - quantity,
          lotQuantityRemaining: lot.quantity_remaining - quantity,
          linkedIncomingId: linkedIncoming.id,
        };
        db.prepare(`
          INSERT INTO incoming_receipt_allocations (
            receipt_key, payload_hash, incoming_purchase_id, inventory_ledger_id,
            receiving_issue_id, quantity_good, quantity_issue, sku, source,
            result_json, created_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'receive', ?, ?)
        `).run(
          `batch-issue:${randomUUID()}`,
          payloadHash,
          linkedIncoming.id,
          ilId,
          issueId,
          quantity,
          lot.sku,
          JSON.stringify(responsePreview),
          now,
        );
      }

      return {
        success: true,
        issueId,
        lotQuantity: lot.quantity - quantity,
        lotQuantityRemaining: lot.quantity_remaining - quantity,
        linkedIncomingId: linkedIncoming?.id ?? null,
        linkedIncomingAirtableId: linkedIncoming?.airtable_record_id ?? null,
        linkedIncomingReceived: newReceived ?? linkedIncoming?.quantity_received ?? null,
      };
    });

    const outcome = tx.immediate();

    if (lot.sku) {
      try { recalculateFIFO({ sku: lot.sku }); } catch (err) { console.warn('[batch-issue] FIFO recalc failed:', err); }
    }

    // No Airtable write-back for cancelled purchases — the checkbook row is
    // closed and must not be touched from here.
    if (outcome.linkedIncomingId != null && outcome.linkedIncomingReceived != null && linkedIncoming?.status !== 'cancelled') {
      const damagedTotal = (db.prepare(
        'SELECT COALESCE(SUM(quantity), 0) as q FROM receiving_issues WHERE incoming_purchase_id = ?',
      ).get(outcome.linkedIncomingId) as { q: number }).q;
      await writeBackReceived(db, outcome.linkedIncomingAirtableId, outcome.linkedIncomingReceived, damagedTotal);
    }

    return NextResponse.json({
      success: true,
      issueId: outcome.issueId,
      lotQuantity: outcome.lotQuantity,
      lotQuantityRemaining: outcome.lotQuantityRemaining,
      linkedIncomingId: outcome.linkedIncomingId,
    });
  } catch (err) {
    if (err instanceof LotConflictError) {
      return jsonError(err.message, 409);
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
