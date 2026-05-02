/**
 * Amazon reimbursement re-evaluation candidate detection.
 *
 * For each Amazon reimbursement Amazon paid, compare the amount paid to
 * the seller's expected value (18-month avg sale price × quantity).
 * When Amazon paid significantly less, the seller can file a
 * "Submit a reimbursement claim dispute" case to request re-evaluation.
 *
 * That form requires a reimbursement_id, so this only surfaces records
 * that have one (skips synthetic SETTLEMENT-* and ADJ-* derived IDs
 * that Amazon's UI won't accept).
 */
import Database from 'better-sqlite3';
import path from 'path';

const UNDERPAID_THRESHOLD_PCT = 0.15; // gap must be at least 15% of expected
const MIN_GAP_CENTS = 1000;            // at least $10 gap to surface
const REIMBURSEMENT_DISPUTE_WINDOW_DAYS = 365; // ~12 months Amazon dispute window

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export interface ReevaluationSyncResult {
  scanned: number;
  newCandidates: number;
  updated: number;
  totalGapCents: number;
}

export function syncReimbursementReevaluations(): ReevaluationSyncResult {
  const db = getDb();

  // Reimbursements with a real numeric reimbursement_id (excludes synthetic
  // SETTLEMENT-* and ADJ-* IDs that Amazon's dispute form won't accept).
  // Joined to avg sale price per ASIN over the last 18 months. The
  // reimbursements table stores the MSKU in `sku`, which links to
  // order_items.sku, which gives us the real ASIN.
  const rows = db.prepare(`
    SELECT
      r.id as id,
      r.reimbursement_id as reimbursementId,
      r.reimbursement_date as reimbursementDate,
      r.sku as sku,
      r.quantity as quantity,
      r.amount as paidCents,
      r.reason as reason,
      COALESCE(oi_match.real_asin, r.asin) as asin,
      COALESCE(p.name, oi_match.product_name) as productName,
      avg_prices.avg_sale_price_cents as avgSalePriceCents
    FROM reimbursements r
    LEFT JOIN (
      SELECT oi.sku, oi.asin as real_asin, p.name as product_name
      FROM order_items oi
      LEFT JOIN products p ON p.asin = oi.asin
      WHERE oi.asin LIKE 'B%' AND length(oi.asin) = 10
      GROUP BY oi.sku
    ) oi_match ON oi_match.sku = r.sku
    LEFT JOIN products p ON p.asin = oi_match.real_asin
    LEFT JOIN (
      SELECT oi.asin, AVG(oi.price_per_unit) as avg_sale_price_cents
      FROM order_items oi
      INNER JOIN orders o ON o.order_id = oi.order_id
      WHERE oi.asin LIKE 'B%' AND length(oi.asin) = 10
        AND o.purchase_date >= date('now','-18 months')
      GROUP BY oi.asin
    ) avg_prices ON avg_prices.asin = oi_match.real_asin
    WHERE r.marketplace = 'amazon'
      AND r.reimbursement_id GLOB '[0-9]*'
      AND length(r.reimbursement_id) >= 8
  `).all() as Array<{
    id: number;
    reimbursementId: string;
    reimbursementDate: string;
    sku: string | null;
    quantity: number;
    paidCents: number;
    reason: string | null;
    asin: string | null;
    productName: string | null;
    avgSalePriceCents: number | null;
  }>;

  const upsert = db.prepare(`
    INSERT INTO amazon_reimbursement_reevaluations (
      reimbursement_id, reimbursement_date, asin, sku, product_name,
      quantity, paid_cents, expected_cents, gap_cents, reason, status, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    ON CONFLICT(reimbursement_id) DO UPDATE SET
      asin = excluded.asin,
      product_name = excluded.product_name,
      paid_cents = excluded.paid_cents,
      expected_cents = excluded.expected_cents,
      gap_cents = excluded.gap_cents,
      reason = excluded.reason,
      status = CASE
        WHEN amazon_reimbursement_reevaluations.status IN ('filed', 'received', 'dismissed') THEN amazon_reimbursement_reevaluations.status
        ELSE excluded.status
      END,
      updated_at = datetime('now')
  `);

  let newCandidates = 0;
  let updated = 0;
  let totalGap = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.avgSalePriceCents || r.quantity <= 0) continue;

      const expected = Math.round(r.avgSalePriceCents * r.quantity);
      const gap = expected - r.paidCents;

      // Only surface meaningful gaps
      if (gap < MIN_GAP_CENTS) continue;
      if (gap < expected * UNDERPAID_THRESHOLD_PCT) continue;

      // Also skip if outside the dispute window (12 months from reimbursement date)
      const ageDays = (Date.now() - new Date(r.reimbursementDate).getTime()) / 86400000;
      if (ageDays > REIMBURSEMENT_DISPUTE_WINDOW_DAYS) continue;

      const result = upsert.run(
        r.reimbursementId,
        r.reimbursementDate,
        r.asin,
        r.sku,
        r.productName,
        r.quantity,
        r.paidCents,
        expected,
        gap,
        r.reason
      );
      if (result.changes === 1) {
        newCandidates++;
        totalGap += gap;
      } else {
        updated++;
      }
    }
  });
  tx();

  db.close();
  return {
    scanned: rows.length,
    newCandidates,
    updated,
    totalGapCents: totalGap,
  };
}
