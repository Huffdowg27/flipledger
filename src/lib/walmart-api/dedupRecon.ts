/**
 * Self-healing Walmart recon dedup.
 *
 * The recon parser routes rows by Transaction Type:
 *   - 'Refund'             → WalmartRefundEvent (preserves raw sign)
 *   - 'Dispute Settlement' → WalmartDisputeSettlement + reimbursements row
 *   - others               → WalmartReconEvent (default fee path)
 *
 * Older code paths (pre-May 1, 2026) routed everything through the default
 * fee path, which sign-flipped credits and silently dropped most line items.
 * If any zombie WalmartReconEvent rows survive whose raw_data shows a
 * Transaction Type of 'Refund' or 'Dispute Settlement', delete them — the
 * proper-typed rows will be created by the next sync.
 *
 * Idempotent.
 */

import Database from 'better-sqlite3';
import path from 'path';

export function dedupWalmartReconEvents(): { rowsRemoved: number } {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  let removed = 0;
  try {
    const tx = db.transaction(() => {
      // Identify zombies: WalmartReconEvent with raw Transaction Type that should
      // route to a different event type
      db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS wm_recon_zombies AS SELECT 0 id WHERE 0;
        DELETE FROM wm_recon_zombies;
        INSERT INTO wm_recon_zombies
        SELECT id FROM financial_events
        WHERE event_type = 'WalmartReconEvent'
          AND json_extract(raw_data, '$."Transaction Type"') IN ('Refund', 'Dispute Settlement');
      `);

      db.prepare(`DELETE FROM fee_details WHERE financial_event_id IN (SELECT id FROM wm_recon_zombies)`).run();
      const del = db.prepare(`DELETE FROM financial_events WHERE id IN (SELECT id FROM wm_recon_zombies)`).run();
      removed = del.changes;
    });
    tx();

    if (removed > 0) {
      console.log(`[dedupWalmartReconEvents] removed ${removed} stale WalmartReconEvent rows that should be Refund/DisputeSettlement events`);
    }
  } finally {
    db.close();
  }

  return { rowsRemoved: removed };
}
