/**
 * Pure settlement parser / reconciler.
 *
 * Extracted from the settlement-line backbone of
 * `parseSettlementReport` in `reports.ts` so that Amazon settlement ingestion
 * can be proven without touching the live database. Everything here is pure
 * except `replaceSettlementLines`, which performs the persistence step as a
 * single atomic transaction.
 *
 * Money is always integer cents. Float math only appears at the TSV boundary
 * (`parseFloat` of the report's decimal `amount` column), immediately rounded
 * to cents — identical to the production path.
 *
 * NOTE: This module is the test-proven extraction. `reports.ts` still contains
 * its own inline copy of this logic; wiring production over to this module
 * (which would also give production the atomic replace it currently lacks) is a
 * deliberate, separately-reviewed follow-up, not part of this read-only harness.
 */

import type Database from 'better-sqlite3';

export interface SettlementLine {
  settlementId: string;
  orderId: string | null;
  sku: string | null;
  postedDate: string | null;
  transactionType: string | null;
  amountType: string | null;
  amountDescription: string | null;
  /** Integer cents. Always an integer; never a float. */
  amountCents: number;
}

export interface ParsedSettlement {
  /** The settlement-id resolved from the first parseable row, or null. */
  settlementId: string | null;
  /** Every preserved settlement line, in file order. */
  lines: SettlementLine[];
}

export type SettlementCategory =
  | 'reserve'
  | 'shipping-label'
  | 'tax-withholding'
  | 'refund'
  | 'fee'
  | 'order'
  | 'other';

const RESERVE_DESCRIPTIONS = new Set([
  'Current Reserve Amount',
  'Previous Reserve Amount Balance',
]);

/**
 * Classify a single settlement line into exactly one bucket.
 *
 * This function is TOTAL: it always returns a category, so the union of all
 * classified lines equals the full set of parsed lines. No line can disappear
 * during classification. Duplicate-identical lines classify identically and
 * are each preserved as their own line elsewhere (they are never collapsed).
 *
 * Precedence is deliberate: reserve and shipping-label descriptions are checked
 * first (they ride the generic `other-transaction` type), then tax-withholding,
 * then refund (so refund-internal fee rows count as refund, not fee).
 */
export function classifySettlementLine(line: SettlementLine): SettlementCategory {
  const tt = line.transactionType || '';
  const at = line.amountType || '';
  const ad = line.amountDescription || '';

  if (RESERVE_DESCRIPTIONS.has(ad)) return 'reserve';
  if (tt === 'other-transaction' && ad === 'Shipping label purchase') return 'shipping-label';
  if (at === 'ItemWithheldTax') return 'tax-withholding';
  if (tt === 'Refund') return 'refund';
  if (at === 'ItemFees' || tt === 'other-transaction') return 'fee';
  if (tt === 'Order') return 'order';
  return 'other';
}

/**
 * Reconciled payout = the integer-cent sum of every preserved settlement line.
 * Amazon's deposit equals the sum of all rows on the statement.
 */
export function reconcilePayout(lines: SettlementLine[]): number {
  return lines.reduce((sum, l) => sum + l.amountCents, 0);
}

/**
 * Parse a settlement report TSV into the canonical settlement-line backbone.
 *
 * Faithful mirror of the per-row record construction in
 * `parseSettlementReport` (reports.ts): same column lookups, same skip rules
 * (short rows and non-numeric amounts are dropped), same `Math.round(amount*100)`
 * cents conversion, and the same metadata rule — only the FIRST length-passing
 * row is consulted for settlement-id/start/end. If that row's metadata is blank
 * (or the settlement columns are absent), no settlement-id is resolved and no
 * lines are emitted, exactly as production's `currentSettlementId` guard does.
 *
 * Pure: reads only its arguments. `now` is injectable so the rare missing
 * posted-date fallback stays deterministic under test.
 */
export function parseSettlementLines(
  content: string,
  now: () => string = () => new Date().toISOString(),
): ParsedSettlement {
  const lines = content.split('\n');
  if (lines.length < 2) return { settlementId: null, lines: [] };

  const headers = lines[0].split('\t').map(h => h.trim().replace(/"/g, ''));
  const colIndex = (name: string) => headers.indexOf(name);

  const orderIdIdx = colIndex('order-id');
  const transactionTypeIdx = colIndex('transaction-type');
  const amountTypeIdx = colIndex('amount-type');
  const amountDescriptionIdx = colIndex('amount-description');
  const amountIdx = colIndex('amount');
  const postedDateColIdx = colIndex('posted-date') >= 0 ? colIndex('posted-date') : colIndex('posted-date-time');
  const settlementIdIdx = colIndex('settlement-id');
  const settlementStartIdx = colIndex('settlement-start-date');
  const settlementEndIdx = colIndex('settlement-end-date');
  const skuIdx = colIndex('sku');

  // V1 / unrecognized layout: the backbone needs order-id + amount columns.
  if (orderIdIdx === -1 || amountIdx === -1) return { settlementId: null, lines: [] };

  let settlementId: string | null = null;
  let metaResolved = false;
  const out: SettlementLine[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t').map(c => c.trim().replace(/"/g, ''));
    if (cols.length < Math.max(orderIdIdx, amountIdx) + 1) continue;

    // Metadata is taken from the first length-passing row only. If its id/start/
    // end are blank, resolution is abandoned and no lines are emitted.
    if (!metaResolved && settlementIdIdx >= 0 && settlementStartIdx >= 0 && settlementEndIdx >= 0) {
      const sid = cols[settlementIdIdx] || '';
      const sStart = cols[settlementStartIdx] || '';
      const sEnd = cols[settlementEndIdx] || '';
      metaResolved = true;
      if (sid && sStart && sEnd) settlementId = sid;
    }

    const orderId = cols[orderIdIdx];
    const transactionType = transactionTypeIdx >= 0 ? cols[transactionTypeIdx] : '';
    const amountType = amountTypeIdx >= 0 ? cols[amountTypeIdx] : '';
    const amountDescription = amountDescriptionIdx >= 0 ? cols[amountDescriptionIdx] : '';
    // A blank amount cell is not a financial transaction — it carries no type,
    // description, or value. Skip it rather than coercing "" → 0 and stamping
    // now() as posted_date, which produced a nondeterministic zero-cent row that
    // drifted on every re-ingest. An explicit "0"/"0.00" IS a real, deterministic
    // zero and is preserved; non-numeric amounts are still rejected.
    const rawAmount = cols[amountIdx] ?? '';
    if (rawAmount.trim() === '') continue;
    const amount = parseFloat(rawAmount);
    if (isNaN(amount)) continue;

    const postedDate = postedDateColIdx >= 0 && cols[postedDateColIdx] ? cols[postedDateColIdx] : now();

    if (settlementId) {
      out.push({
        settlementId,
        orderId: orderId || null,
        sku: skuIdx >= 0 ? (cols[skuIdx] || null) : null,
        postedDate: postedDate || null,
        transactionType: transactionType || null,
        amountType: amountType || null,
        amountDescription: amountDescription || null,
        amountCents: Math.round(amount * 100),
      });
    }
  }

  return { settlementId, lines: out };
}

/**
 * Schema for the settlement-line backbone — byte-identical to the table
 * `parseSettlementReport` creates, so the reconciler and production agree.
 */
export const SETTLEMENT_TRANSACTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS settlement_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_id TEXT NOT NULL,
    order_id TEXT,
    sku TEXT,
    posted_date TEXT,
    transaction_type TEXT,
    amount_type TEXT,
    amount_description TEXT,
    amount_cents INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

export function ensureSettlementTransactionsTable(db: Database.Database): void {
  db.prepare(SETTLEMENT_TRANSACTIONS_DDL).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_settlement_txn_sid ON settlement_transactions(settlement_id)`).run();
}

/**
 * Atomically replace one settlement's stored lines.
 *
 * The DELETE of the prior rows and the INSERT of the new rows run inside a
 * single better-sqlite3 transaction. If any insert fails the whole replace
 * rolls back and the previously valid settlement is left exactly as it was.
 *
 * Three guards stand BEFORE the DELETE — a rejected replace never touches the
 * prior rows at all:
 *   1. A null/empty settlement-id is a clean no-op (it never deletes), matching
 *      production's "no id resolved → no write".
 *   2. A valid settlement-id with ZERO lines is rejected. This is not an empty
 *      settlement — it means the parse extracted nothing (e.g. every `amount`
 *      cell was non-numeric). Replacing with zero rows would erase the prior
 *      valid settlement and commit nothing, i.e. silent data loss.
 *   3. Every row must belong to the target settlement and carry a safe-integer
 *      cent amount. SQLite's INTEGER affinity will otherwise silently store a
 *      fractional REAL; a mismatched settlement-id would smuggle foreign rows in
 *      under the target's id.
 *
 * Returns the number of rows inserted.
 */
export function replaceSettlementLines(
  db: Database.Database,
  settlementId: string | null,
  lines: SettlementLine[],
): number {
  // Guard 1: nothing resolved → never delete.
  if (!settlementId) return 0;

  // Guard 2: a resolved id with no lines must NOT erase the prior settlement.
  if (lines.length === 0) {
    throw new Error(
      `replaceSettlementLines: refusing to replace settlement ${settlementId} with zero parsed lines (would erase existing rows)`,
    );
  }

  // Guard 3: validate the COMPLETE input before any DELETE, so a bad row can
  // never leave the prior settlement half-replaced or erased.
  for (const r of lines) {
    if (r.settlementId !== settlementId) {
      throw new Error(
        `replaceSettlementLines: row settlement-id ${JSON.stringify(r.settlementId)} does not match target ${settlementId}`,
      );
    }
    if (!Number.isSafeInteger(r.amountCents)) {
      throw new Error(
        `replaceSettlementLines: amountCents must be a safe integer, got ${r.amountCents} (settlement ${settlementId})`,
      );
    }
  }

  ensureSettlementTransactionsTable(db);

  const insert = db.prepare(`
    INSERT INTO settlement_transactions
      (settlement_id, order_id, sku, posted_date, transaction_type, amount_type, amount_description, amount_cents)
    VALUES
      (@settlementId, @orderId, @sku, @postedDate, @transactionType, @amountType, @amountDescription, @amountCents)
  `);

  const run = db.transaction((rows: SettlementLine[]) => {
    db.prepare('DELETE FROM settlement_transactions WHERE settlement_id = ?').run(settlementId);
    for (const r of rows) insert.run(r);
    return rows.length;
  });

  return run(lines);
}

/**
 * Parse a settlement report's TSV and atomically replace that settlement's
 * stored transaction lines — the SINGLE shared entry point used by BOTH
 * production (`parseSettlementReport` in reports.ts) and the test harness, so
 * there is no mirror copy of the persistence logic.
 *
 * Behavior:
 *   - Ensures the `settlement_transactions` table/index exist. Production
 *     historically created them unconditionally on every settlement report, and
 *     readers (settlement-periods route, settlement-transactions sync route)
 *     assume the table exists; doing it here preserves that guarantee.
 *   - Resolves the settlement-id and lines via `parseSettlementLines`.
 *   - Atomically replaces that settlement's rows via `replaceSettlementLines`:
 *       • no settlement-id resolved → no-op (nothing persisted)
 *       • valid id, zero valid rows → THROWS, prior rows preserved
 *       • valid id, N rows          → that settlement's prior rows replaced by N
 *
 * Returns the resolved settlement-id, the parsed lines, and rows persisted.
 */
export function replaceSettlementReport(
  db: Database.Database,
  content: string,
): { settlementId: string | null; lines: SettlementLine[]; replaced: number } {
  ensureSettlementTransactionsTable(db);
  const { settlementId, lines } = parseSettlementLines(content);
  const replaced = replaceSettlementLines(db, settlementId, lines);
  return { settlementId, lines, replaced };
}
