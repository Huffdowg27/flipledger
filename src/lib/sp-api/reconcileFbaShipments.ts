/**
 * Auto-close FBA batches once Amazon is done with their shipments.
 *
 * A batch reaches 'shipping' when transportation is confirmed, but nothing
 * previously moved it past that — every FBA batch ever sent sat in 'shipping'
 * forever. This sweep (run from auto-sync) checks each shipping batch's
 * shipments and closes the batch when all of them are terminal
 * (CLOSED = fully received; CANCELLED/DELETED = never happening).
 *
 * Tracking uses the v0 shipments API keyed by FBA confirmation IDs — the
 * v2024 inboundPlans endpoints 403 once the plan's workflow is over, so the
 * confirmationId captured at transportation-confirm time is the only durable
 * handle. Batches confirmed before confirmation IDs were stored can't be
 * tracked and are left for a manual close.
 *
 * Closing matters beyond tidiness: the Informed repricer cost push fires on
 * close, and batch History treats closed as done.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { getV0ShipmentStatuses } from './inboundPlansV2';
import { pushBatchCostToInformed } from '../informed';
import type { SPAPICredentials } from './types';

const TERMINAL_STATUSES = new Set(['CLOSED', 'CANCELLED', 'DELETED']);

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export interface FbaShipmentReconcileResult {
  checked: number;
  closed: number;
  untrackable: number;
  errors: number;
}

export async function reconcileFbaShipments(
  creds: SPAPICredentials
): Promise<FbaShipmentReconcileResult> {
  const db = getDb();
  try {
    const batches = db.prepare(`
      SELECT id, name, confirmed_shipments as confirmedShipments
      FROM listing_batches
      WHERE channel = 'FBA' AND status = 'shipping'
    `).all() as { id: number; name: string; confirmedShipments: string | null }[];

    let closed = 0;
    let untrackable = 0;
    let errors = 0;

    for (const batch of batches) {
      try {
        let confirmed: any[] = [];
        try {
          confirmed = JSON.parse(batch.confirmedShipments || '[]');
        } catch {
          confirmed = [];
        }
        const confirmationIds: string[] = confirmed
          .map((cs: any) => cs?.confirmationId)
          .filter((id: any): id is string => typeof id === 'string' && id.length > 0);

        if (confirmationIds.length === 0) {
          untrackable++;
          continue;
        }

        const statusById = await getV0ShipmentStatuses(creds, confirmationIds);
        const statuses = confirmationIds.map((id) => statusById.get(id) || 'UNKNOWN');

        // Annotate the latest per-shipment status onto confirmed_shipments so
        // the batch page can show receive progress.
        let changed = false;
        for (const cs of confirmed) {
          const status = cs?.confirmationId ? statusById.get(cs.confirmationId) : undefined;
          if (status && cs.amazonStatus !== status) {
            cs.amazonStatus = status;
            changed = true;
          }
        }
        if (changed) {
          db.prepare('UPDATE listing_batches SET confirmed_shipments = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(confirmed), new Date().toISOString(), batch.id);
        }

        if (!statuses.every((s) => TERMINAL_STATUSES.has(s))) continue;

        const now = new Date().toISOString();
        db.prepare(`
          UPDATE listing_batches SET status = 'closed', closed_at = COALESCE(closed_at, ?), updated_at = ?
          WHERE id = ?
        `).run(now, now, batch.id);
        closed++;
        console.log(`[fba-reconcile] batch ${batch.id} (${batch.name}) auto-closed — shipments: ${statuses.join(', ')}`);

        // Same side effect as a manual close: push per-unit buy cost to Informed.
        const informed = await pushBatchCostToInformed(db, batch.id);
        if (!informed.ok && !informed.skipped) {
          console.error(`[fba-reconcile] Informed cost push failed for batch ${batch.id}:`, informed.error);
        }
      } catch (err) {
        errors++;
        console.warn(`[fba-reconcile] batch ${batch.id} (${batch.name}) check failed:`, err);
      }
    }

    return { checked: batches.length, closed, untrackable, errors };
  } finally {
    db.close();
  }
}
