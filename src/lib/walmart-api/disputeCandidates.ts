/**
 * Walmart dispute candidate detection.
 *
 * Walmart auto-refunds customers when a return is initiated. For WFS-fulfilled
 * items, the seller can DISPUTE that refund within ~30 days if the return
 * reason indicates customer-caused damage, theft (LOST_AFTER_DELIVERY), wrong
 * item returned (INCORRECT_ITEM), or carrier-side issues. Successful disputes
 * result in Walmart reimbursing the seller for the refund amount.
 *
 * This module scans the existing `refunds` table (no new API call needed —
 * we already sync Walmart returns), classifies each refund as eligible /
 * maybe / not_eligible for dispute, and stores candidates in
 * `walmart_dispute_candidates`.
 *
 * NOTE: This is detection only. Filing the dispute itself happens via
 * Seller Center deeplink — Walmart's dispute API is undocumented and
 * inconsistent across seller accounts.
 */
import Database from 'better-sqlite3';
import path from 'path';

const DISPUTE_WINDOW_DAYS = 30;

// Reasons that strongly suggest a customer-fault or carrier-fault return.
// These are the bread-and-butter dispute targets.
const HIGH_ELIGIBILITY_REASONS = new Set([
  'LOST_AFTER_DELIVERY',     // Customer claims package never arrived (porch piracy or fraud)
  'LOST_IN_TRANSIT',         // Carrier lost it
  'INCORRECT_ITEM',          // Customer claims wrong item received
  'DAMAGED',                 // Could be customer-caused; depends on photos
]);

// Reasons that MAY be disputable depending on circumstances. Lower confidence.
const MEDIUM_ELIGIBILITY_REASONS = new Set([
  'ARRIVED_LATE',            // Sometimes carrier-side
  'DEFECTIVE',               // Rarely disputable but worth flagging
  'NOT_AS_DESCRIBED_PICTURED',// Sometimes disputable with listing screenshots
  'MISSING_PARTS',
]);

// Reasons that essentially never win disputes
const NOT_ELIGIBLE_REASONS = new Set([
  'NO_LONGER_WANTED',
  'LOWER_PRICE',
  'BETTER_PRICE',
  'CHANGED_MIND',
  'FOUND_ELSEWHERE',
  'DIFFICULT_TO_SETUP_NOT_COMPATIBLE',
]);

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

// How long Walmart's recon reports typically take to settle a return.
// If a refund is younger than this and we don't see a financial event yet,
// classify as "pending settlement" rather than "no deduction" — the recon
// row may simply not exist yet.
const RECON_SETTLEMENT_LAG_DAYS = 14;

function classifyEligibility(
  reason: string,
  fulfillmentChannel: string | null,
  refundDate: string,
  hasRefundEvent: boolean
): { eligibility: 'eligible' | 'maybe' | 'not_eligible'; reasons: string[] } {
  const tags: string[] = [];

  const refundTime = new Date(refundDate).getTime();
  const ageDays = (Date.now() - refundTime) / 86400000;

  // No financial deduction detected
  if (!hasRefundEvent) {
    if (ageDays <= RECON_SETTLEMENT_LAG_DAYS) {
      // Recent — Walmart's recon may not have caught up yet. Surface as
      // "maybe" with a wait-and-see note. User can check back in 1-2 weeks.
      tags.push(`Refund posted ${Math.floor(ageDays)} days ago — Walmart's recon settlement may take 1-3 weeks to confirm a deduction`);
      tags.push('Check back later — re-running the Walmart sync will update this if Walmart settles the deduction');
      // Still gate on the other eligibility criteria below
      if (fulfillmentChannel !== 'WFS') {
        return { eligibility: 'not_eligible', reasons: ['Not WFS-fulfilled'] };
      }
      if (NOT_ELIGIBLE_REASONS.has(reason)) {
        return { eligibility: 'not_eligible', reasons: [`Reason ${reason} is customer's right to return`] };
      }
      // Settlement-pending eligible refund — flag as 'maybe' so user knows to verify
      return { eligibility: 'maybe', reasons: tags };
    }
    // Old enough that recon should have settled by now → genuinely no charge
    tags.push('No financial deduction detected — Walmart likely never charged you for this return');
    return { eligibility: 'not_eligible', reasons: tags };
  }
  if (fulfillmentChannel !== 'WFS') {
    tags.push('Not WFS-fulfilled (Walmart only reimburses WFS returns)');
    return { eligibility: 'not_eligible', reasons: tags };
  }
  if (NOT_ELIGIBLE_REASONS.has(reason)) {
    tags.push(`Reason ${reason} is customer's right to return`);
    return { eligibility: 'not_eligible', reasons: tags };
  }

  // Window check
  if (ageDays > DISPUTE_WINDOW_DAYS) {
    tags.push(`Past ${DISPUTE_WINDOW_DAYS}-day dispute window (${Math.floor(ageDays)} days old)`);
    return { eligibility: 'not_eligible', reasons: tags };
  }

  if (HIGH_ELIGIBILITY_REASONS.has(reason)) {
    tags.push(`Reason ${reason} typically wins disputes`);
    tags.push('WFS-fulfilled — Walmart liability');
    return { eligibility: 'eligible', reasons: tags };
  }

  if (MEDIUM_ELIGIBILITY_REASONS.has(reason)) {
    tags.push(`Reason ${reason} may win with evidence`);
    tags.push('WFS-fulfilled — Walmart liability');
    return { eligibility: 'maybe', reasons: tags };
  }

  // Unknown reason code — surface as maybe so the user can decide
  tags.push(`Reason ${reason} not classified — review manually`);
  return { eligibility: 'maybe', reasons: tags };
}

export interface WalmartDisputeSyncResult {
  scanned: number;
  newEligible: number;
  newMaybe: number;
  newNotEligible: number;
  expired: number;
  totalEligibleValueCents: number;
}

/**
 * Scan the refunds table, classify each Walmart refund, upsert into
 * walmart_dispute_candidates. Cheap (pure SQL) — runs in ms.
 */
export function syncWalmartDisputeCandidates(): WalmartDisputeSyncResult {
  const db = getDb();

  const refunds = db
    .prepare(
      `
      SELECT
        r.id as refundId, r.order_id as orderId, r.refund_date as refundDate,
        r.asin, r.sku, r.refund_amount as refundAmount, r.reason,
        o.fulfillment_channel as fulfillmentChannel,
        COALESCE(p.name, p2.name, p3.name, r.asin, r.sku) as productName
      FROM refunds r
      LEFT JOIN orders o ON o.order_id = r.order_id
      LEFT JOIN products p ON p.asin = r.asin
      LEFT JOIN products p2 ON p2.asin = r.sku
      LEFT JOIN order_items oi ON oi.order_id = r.order_id AND (oi.asin = r.asin OR oi.sku = r.sku)
      LEFT JOIN products p3 ON p3.asin = oi.asin
      WHERE r.marketplace = 'walmart'
      GROUP BY r.id
    `
    )
    .all() as Array<{
      refundId: number;
      orderId: string;
      refundDate: string;
      asin: string | null;
      sku: string | null;
      refundAmount: number;
      reason: string;
      fulfillmentChannel: string | null;
      productName: string | null;
    }>;

  // Pre-load the set of order IDs that have an actual WalmartRefundEvent in
  // financial_events. These are refunds where Walmart actually deducted
  // money from the seller's payout (verified via recon report). Refunds
  // NOT in this set are "ghosts" — the customer initiated a return but
  // Walmart never settled it. Don't surface those as disputable.
  const settledOrderIds = new Set(
    (db.prepare(`
      SELECT DISTINCT order_id FROM financial_events
      WHERE event_type = 'WalmartRefundEvent' AND order_id IS NOT NULL
    `).all() as Array<{ order_id: string }>).map((r) => r.order_id)
  );

  const upsert = db.prepare(`
    INSERT INTO walmart_dispute_candidates (
      refund_id, order_id, refund_date, return_reason, asin, sku, product_name,
      refund_amount_cents, fulfillment_channel, eligibility, eligibility_reasons,
      dispute_window_until, status, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(refund_id) DO UPDATE SET
      eligibility = excluded.eligibility,
      eligibility_reasons = excluded.eligibility_reasons,
      dispute_window_until = excluded.dispute_window_until,
      product_name = excluded.product_name,
      fulfillment_channel = excluded.fulfillment_channel,
      -- Don't overwrite filed/received/dismissed states
      status = CASE
        WHEN walmart_dispute_candidates.status IN ('filed', 'received', 'dismissed') THEN walmart_dispute_candidates.status
        ELSE excluded.status
      END,
      updated_at = datetime('now')
  `);

  let newEligible = 0, newMaybe = 0, newNotEligible = 0;
  let totalEligibleValue = 0;

  const tx = db.transaction(() => {
    for (const r of refunds) {
      const hasRefundEvent = settledOrderIds.has(r.orderId);
      const { eligibility, reasons } = classifyEligibility(r.reason, r.fulfillmentChannel, r.refundDate, hasRefundEvent);
      const windowEnd = new Date(new Date(r.refundDate).getTime() + DISPUTE_WINDOW_DAYS * 86400000)
        .toISOString().slice(0, 10);

      const status = eligibility === 'not_eligible' ? 'expired' : 'pending';

      const result = upsert.run(
        r.refundId, r.orderId, r.refundDate, r.reason,
        r.asin, r.sku, r.productName,
        r.refundAmount, r.fulfillmentChannel,
        eligibility, JSON.stringify(reasons),
        windowEnd, status
      );

      if (result.changes === 1) {
        if (eligibility === 'eligible') { newEligible++; totalEligibleValue += r.refundAmount; }
        else if (eligibility === 'maybe') newMaybe++;
        else newNotEligible++;
      }
    }
  });
  tx();

  // Auto-expire pending candidates past their dispute window
  const expiredResult = db.prepare(`
    UPDATE walmart_dispute_candidates
    SET status = 'expired', updated_at = datetime('now')
    WHERE status = 'pending' AND date(dispute_window_until) < date('now')
  `).run();

  db.close();

  return {
    scanned: refunds.length,
    newEligible,
    newMaybe,
    newNotEligible,
    expired: expiredResult.changes,
    totalEligibleValueCents: totalEligibleValue,
  };
}
