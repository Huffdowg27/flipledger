import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export class ReceiptConflictError extends Error {}

interface IncomingPurchaseRow {
  airtable_record_id: string | null;
  asin: string | null;
  sku: string | null;
  quantity: number;
  quantity_received: number;
  status: string;
  received_at: string | null;
  receipt_allocation_baseline: number;
  receipt_identity_started_at: string | null;
}

export interface ReconcileIncomingPurchaseInput {
  purchaseId: number;
  receiptKey: string;
  expectedQuantityReceived: number;
  inventoryLedgerId: number;
  quantity: number;
  confirmMismatch?: boolean;
}

export interface ReconcileIncomingPurchaseResponse {
  success: true;
  inventoryLedgerId: number;
  quantityReconciled: number;
  status: string;
  mismatchConfirmed: boolean;
  replayed: boolean;
  /** Whether the received count was mirrored back to Airtable. undefined = not attempted (replay). */
  airtableSynced?: boolean;
}

export interface WriteBackResult {
  attempted: boolean; // false when there's nothing to push (no record id / no key)
  ok: boolean;        // true only when Airtable accepted the update
  status?: number;
  error?: string;
}

/**
 * Push the received (and damaged) count for one purchase back to Airtable.
 *
 * Airtable allows ~5 requests/sec per base, so bulk receiving can burst past the
 * limit. `fetch` does NOT throw on a 429/4xx, so we must check `res.ok`
 * ourselves — otherwise a rate-limited write silently vanishes. On 429 we honor
 * Retry-After and back off. A failure is reported to the caller and logged, but
 * never thrown: a valid receipt must not be rolled back because the Airtable
 * mirror was rate-limited.
 */
export async function writeBackReceived(
  db: Database.Database,
  airtableRecordId: string | null,
  received: number,
  damaged: number,
): Promise<WriteBackResult> {
  if (!airtableRecordId) return { attempted: false, ok: false };
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('airtable_api_key','airtable_purchases_base','airtable_purchases_table')").all() as { key: string; value: string }[];
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  if (!s.airtable_api_key) {
    console.error('[incoming] Airtable write-back skipped: airtable_api_key not configured');
    return { attempted: false, ok: false, error: 'airtable_api_key not configured' };
  }
  const baseId = s.airtable_purchases_base || 'app1G29Xd3K6S5swV';
  const table = s.airtable_purchases_table || '💳 Orders';
  const fields: Record<string, number> = { Received: received };
  if (damaged > 0) fields.Damaged = damaged;
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${airtableRecordId}`;

  const MAX_ATTEMPTS = 5;
  let lastStatus = 0;
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${s.airtable_api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      lastStatus = res.status;
      if (res.ok) return { attempted: true, ok: true, status: res.status };
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000, 250 * 2 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      lastError = (await res.text().catch(() => '')).slice(0, 300);
      console.error(`[incoming] Airtable write-back failed for ${airtableRecordId}: HTTP ${res.status} ${lastError}`);
      return { attempted: true, ok: false, status: res.status, error: lastError || `HTTP ${res.status}` };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, Math.min(2000, 250 * 2 ** (attempt - 1))));
        continue;
      }
      console.error(`[incoming] Airtable write-back network error for ${airtableRecordId}:`, lastError);
      return { attempted: true, ok: false, status: lastStatus, error: lastError };
    }
  }
  return { attempted: true, ok: false, status: lastStatus, error: lastError || 'exhausted retries' };
}

export async function reconcileIncomingPurchase(
  db: Database.Database,
  input: ReconcileIncomingPurchaseInput,
): Promise<ReconcileIncomingPurchaseResponse> {
  const {
    purchaseId,
    receiptKey,
    expectedQuantityReceived,
    inventoryLedgerId,
    quantity,
  } = input;
  const confirmMismatch = input.confirmMismatch === true;
  const now = new Date().toISOString();
  const payloadHash = createHash('sha256').update(JSON.stringify({
    purchaseId,
    expectedQuantityReceived,
    inventoryLedgerId,
    quantity,
    confirmMismatch,
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
        response: { ...JSON.parse(prior.result_json), replayed: true } as ReconcileIncomingPurchaseResponse,
        applied: false,
        airtableRecordId: null,
        newReceived: null,
      };
    }

    const current = db.prepare('SELECT * FROM incoming_purchases WHERE id = ?').get(purchaseId) as IncomingPurchaseRow | undefined;
    if (!current) throw new Error('Purchase not found');
    if (current.quantity_received !== expectedQuantityReceived) {
      throw new ReceiptConflictError(
        `Incoming purchase changed since this reconciliation started (expected ${expectedQuantityReceived}, current ${current.quantity_received})`,
      );
    }
    if (current.status !== 'on_order' && current.status !== 'partial') {
      throw new ReceiptConflictError(`Only open incoming purchases can be reconciled (current status: ${current.status})`);
    }

    const remaining = current.quantity - current.quantity_received;
    if (quantity > remaining) {
      throw new ReceiptConflictError(`Reconciling ${quantity} but only ${remaining} units are outstanding`);
    }

    const lot = db.prepare(`
      SELECT id, asin, sku, quantity, quantity_received
      FROM inventory_ledger
      WHERE id = ?
    `).get(inventoryLedgerId) as {
      id: number;
      asin: string | null;
      sku: string | null;
      quantity: number;
      quantity_received: number | null;
    } | undefined;
    if (!lot) throw new ReceiptConflictError('Selected inventory lot no longer exists');

    const skuMatches = !!current.sku && !!lot.sku && current.sku === lot.sku;
    const asinMatches = !!current.asin && !!lot.asin && current.asin === lot.asin;
    const skuConflicts = !!current.sku && !!lot.sku && current.sku !== lot.sku;
    const asinConflicts = !!current.asin && !!lot.asin && current.asin !== lot.asin;
    const mismatch = skuConflicts || asinConflicts || (!skuMatches && !asinMatches);
    if (mismatch && !confirmMismatch) {
      throw new ReceiptConflictError('Selected lot SKU/ASIN mismatch requires explicit operator confirmation');
    }

    const lotReceived = Math.max(0, Number(lot.quantity_received ?? lot.quantity) || 0);
    const alreadyAttributed = Number((db.prepare(`
      SELECT COALESCE(SUM(quantity_good), 0) attributed
      FROM incoming_receipt_allocations
      WHERE inventory_ledger_id = ?
    `).get(inventoryLedgerId) as { attributed: number }).attributed) || 0;
    if (alreadyAttributed + quantity > lotReceived) {
      throw new ReceiptConflictError(
        `Selected lot received ${lotReceived} units but ${alreadyAttributed + quantity} would be allocated`,
      );
    }

    const newReceived = current.quantity_received + quantity;
    const status = newReceived >= current.quantity ? 'received' : 'partial';
    const receiptAllocationBaseline = current.receipt_identity_started_at
      ? Number(current.receipt_allocation_baseline) || 0
      : current.quantity_received;
    db.prepare(`
      UPDATE incoming_purchases SET quantity_received = ?, status = ?, received_at = ?,
        inventory_ledger_id = ?, receipt_allocation_baseline = ?,
        receipt_identity_started_at = COALESCE(receipt_identity_started_at, ?),
        updated_at = ?
      WHERE id = ?
    `).run(
      newReceived,
      status,
      newReceived >= current.quantity ? now : current.received_at,
      inventoryLedgerId,
      receiptAllocationBaseline,
      now,
      now,
      purchaseId,
    );

    const response: ReconcileIncomingPurchaseResponse = {
      success: true,
      inventoryLedgerId,
      quantityReconciled: quantity,
      status,
      mismatchConfirmed: mismatch && confirmMismatch,
      replayed: false,
    };
    db.prepare(`
      INSERT INTO incoming_receipt_allocations (
        receipt_key, payload_hash, incoming_purchase_id, inventory_ledger_id,
        receiving_issue_id, quantity_good, quantity_issue, sku, source,
        result_json, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?, 0, ?, 'operator_reconciliation', ?, ?)
    `).run(
      receiptKey,
      payloadHash,
      purchaseId,
      inventoryLedgerId,
      quantity,
      lot.sku,
      JSON.stringify(response),
      now,
    );

    return {
      response,
      applied: true,
      airtableRecordId: current.airtable_record_id,
      newReceived,
    };
  });
  const outcome = tx.immediate();

  if (outcome.applied && outcome.newReceived != null) {
    const damagedTotal = (db.prepare(
      'SELECT COALESCE(SUM(quantity), 0) as q FROM receiving_issues WHERE incoming_purchase_id = ?',
    ).get(purchaseId) as { q: number }).q;
    const wb = await writeBackReceived(db, outcome.airtableRecordId, outcome.newReceived, damagedTotal);
    outcome.response.airtableSynced = wb.ok;
  }

  return outcome.response;
}
