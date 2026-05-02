/**
 * Self-healing reimbursements deduplication.
 *
 * The Amazon `reimbursements` table is fed by THREE sync paths that each assign
 * a different ID for the same logical event:
 *   1. Financial Events `AdjustmentEvent` → `ADJ-{numeric}`
 *   2. Settlement Reports                  → `SETTLEMENT-{reason}-{date}-{amount}`
 *   3. FBA Reimbursements Report (canonical) → `{numeric}` IDs
 *
 * The first two run hourly. The third runs weekly. So even with insert-time
 * prevention (which can race), placeholders can briefly exist before the
 * canonical lands. This sweep removes any ADJ-* / SETTLEMENT-* row that's
 * already covered by a canonical numeric row matching (date, amount, sku-or-asin).
 *
 * Idempotent — safe to run after every sync.
 */

import Database from 'better-sqlite3';
import path from 'path';

export interface DedupResult {
  rowsRemoved: number;
  candidatePointersRepointed: number;
}

export function dedupAmazonReimbursements(): DedupResult {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  let rowsRemoved = 0;
  let pointersRepointed = 0;

  try {
    const tx = db.transaction(() => {
      db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS dedup_dup_map AS SELECT 0 dup_id, 0 canon_id WHERE 0;
        DELETE FROM dedup_dup_map;
        INSERT INTO dedup_dup_map
        SELECT
          dup.id AS dup_id,
          canon.id AS canon_id
        FROM reimbursements dup
        JOIN reimbursements canon
          ON canon.reimbursement_id GLOB '[0-9]*'
          AND canon.marketplace = 'amazon'
          AND date(canon.reimbursement_date) = date(dup.reimbursement_date)
          AND canon.amount = dup.amount
          AND (
               (dup.sku IS NOT NULL AND canon.sku = dup.sku)
            OR (dup.asin IS NOT NULL AND canon.asin = dup.asin)
            OR (dup.sku IS NULL AND dup.asin IS NULL)
          )
        WHERE (dup.reimbursement_id LIKE 'ADJ-%' OR dup.reimbursement_id LIKE 'SETTLEMENT-%')
          AND dup.marketplace = 'amazon';
      `);

      const repoint = db.prepare(`
        UPDATE reimbursement_candidates
        SET matched_reimbursement_id = (SELECT MIN(canon_id) FROM dedup_dup_map WHERE dup_id = reimbursement_candidates.matched_reimbursement_id)
        WHERE matched_reimbursement_id IN (SELECT dup_id FROM dedup_dup_map)
      `).run();
      pointersRepointed = repoint.changes;

      const del = db.prepare(`DELETE FROM reimbursements WHERE id IN (SELECT dup_id FROM dedup_dup_map)`).run();
      rowsRemoved = del.changes;
    });
    tx();

    if (rowsRemoved > 0) {
      console.log(`[dedupAmazonReimbursements] removed ${rowsRemoved} ADJ/SETTLEMENT placeholders covered by canonical numeric rows (${pointersRepointed} candidate FKs repointed)`);
    }
  } finally {
    db.close();
  }

  return { rowsRemoved, candidatePointersRepointed: pointersRepointed };
}
