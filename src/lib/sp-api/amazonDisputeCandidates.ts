/**
 * Amazon SAFE-T claim candidate detection.
 *
 * Same pattern as Walmart dispute candidates — pure SQL, no extra API
 * call. Scans the existing `refunds` table, joins to `orders` for
 * fulfillment_channel, cross-references against `reimbursements` to skip
 * already-paid items, and classifies each as eligible/maybe/not_eligible
 * for SAFE-T filing.
 *
 * SAFE-T (Seller Assurance For Every Transaction) is Amazon's mechanism
 * for sellers to dispute customer refunds and recover money from
 * customer-fault cases — 90-day filing window from the refund date.
 *
 * Notes on FBA vs MFN:
 *   - FBA: Amazon usually auto-reimburses for legitimate cases. SAFE-T
 *     is for cases where Amazon refunded the customer but didn't
 *     reimburse the seller. We surface these only if there's no matching
 *     reimbursement and the reason indicates customer fault.
 *   - MFN: seller eats the refund unless they file SAFE-T. More
 *     candidates here typically.
 */
import Database from 'better-sqlite3';
import path from 'path';

const SAFE_T_WINDOW_DAYS = 90;

// Reasons that suggest customer fault — strong SAFE-T candidates.
const HIGH_ELIGIBILITY_REASONS = new Set([
  'NEVER_ARRIVED',           // Customer claims didn't receive (carrier shows delivered = strong dispute)
  'ORDERED_WRONG_ITEM',      // Customer ordered wrong thing, claims it as our error
  'MISSING_PARTS',           // Item shipped sealed = customer probably broke seal
]);

// Reasons that may win SAFE-T with evidence
const MEDIUM_ELIGIBILITY_REASONS = new Set([
  'NOT_AS_DESCRIBED',         // Disputable if listing matches product
  'DEFECTIVE',                // Disputable if QC verified at receipt
  'NOT_COMPATIBLE',           // Customer's compatibility error, not seller's
  'QUALITY_UNACCEPTABLE',     // Subjective — sometimes wins
  'UNDELIVERABLE_UNKNOWN',    // Carrier issue, sometimes recoverable
]);

// Customer's right to return — never wins SAFE-T
const NOT_ELIGIBLE_REASONS = new Set([
  'UNWANTED_ITEM',
  'NO_LONGER_NEEDED',
  'BETTER_PRICE',
  'LOWER_PRICE',
  'CHANGED_MIND',
  'ARRIVED_LATE',             // Generally seller eats this
  'DAMAGED_BY_FC',            // This is YOUR claim against Amazon (FBA reimbursement), NOT customer dispute
  'CUSTOMER_RETURN',          // Generic placeholder — can't dispute without specific reason
]);

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Classify which recovery path to use:
 *   - 'safet': SAFE-T claim (only for non-FBA orders — SFP, MFN with
 *     prepaid return label, Easy Ship, VAS). Filed via /safet-claims.
 *   - 'fba_reimbursement_case': FBA reimbursement claim. For FBA orders
 *     where Amazon refunded the customer but didn't auto-reimburse the
 *     seller. Filed via Help → Get Support → "Submit a reimbursement
 *     claim dispute".
 */
function recoveryPathFor(fulfillmentChannel: string | null): 'safet' | 'fba_reimbursement_case' {
  const c = (fulfillmentChannel || '').toUpperCase();
  return (c === 'AFN' || c === 'FBA') ? 'fba_reimbursement_case' : 'safet';
}

function classifyEligibility(
  reason: string,
  fulfillmentChannel: string | null,
  refundDate: string,
  alreadyReimbursed: boolean
): { eligibility: 'eligible' | 'maybe' | 'not_eligible'; reasons: string[] } {
  const tags: string[] = [];

  // If Amazon already reimbursed the seller, no dispute needed
  if (alreadyReimbursed) {
    tags.push('Amazon already reimbursed this refund — no dispute needed');
    tags.push('If the reimbursement amount looks low, see "Reimbursement Re-Evaluations" instead');
    return { eligibility: 'not_eligible', reasons: tags };
  }

  // FBA orders without reimbursement: no real dispute path exists. SAFE-T
  // doesn't apply (FBA-ineligible), and "Submit a reimbursement claim
  // dispute" requires a reimbursement_id (for re-evaluating already-paid
  // reimbursements). Amazon's policy is that FBA customer refunds are
  // generally absorbed by the seller unless Amazon's automatic reimbursement
  // rules trigger. Mark as not_eligible to avoid surfacing false-hope claims.
  const path = recoveryPathFor(fulfillmentChannel);
  if (path === 'fba_reimbursement_case') {
    tags.push('FBA refund without auto-reimbursement — no standard dispute path');
    tags.push('SAFE-T does not apply to FBA. "Submit a reimbursement claim dispute" requires an existing reimbursement ID.');
    tags.push('If the unit was lost/damaged in the FC, file via "Claims to File". Otherwise, this is generally not recoverable.');
    return { eligibility: 'not_eligible', reasons: tags };
  }

  if (NOT_ELIGIBLE_REASONS.has(reason)) {
    if (reason === 'DAMAGED_BY_FC') {
      tags.push('FC-damaged is reimbursable via Claims to File, not a customer dispute');
    } else if (reason === 'CUSTOMER_RETURN') {
      tags.push('Generic placeholder — re-sync customer returns to get specific reason');
    } else {
      tags.push(`Reason ${reason} is customer's right to return`);
    }
    return { eligibility: 'not_eligible', reasons: tags };
  }

  // Window check — 90 days for SAFE-T
  const refundTime = new Date(refundDate).getTime();
  const ageDays = (Date.now() - refundTime) / 86400000;
  if (ageDays > SAFE_T_WINDOW_DAYS) {
    tags.push(`Past ${SAFE_T_WINDOW_DAYS}-day SAFE-T window (${Math.floor(ageDays)} days old)`);
    return { eligibility: 'not_eligible', reasons: tags };
  }

  // From here we know it's MFN/SFP and a disputable reason
  if (HIGH_ELIGIBILITY_REASONS.has(reason)) {
    tags.push(`Reason ${reason} typically wins SAFE-T claims`);
    tags.push('MFN/SFP — file via SAFE-T claim');
    return { eligibility: 'eligible', reasons: tags };
  }

  if (MEDIUM_ELIGIBILITY_REASONS.has(reason)) {
    tags.push(`Reason ${reason} may win SAFE-T with evidence`);
    tags.push('MFN/SFP — file via SAFE-T claim');
    return { eligibility: 'maybe', reasons: tags };
  }

  tags.push(`Reason ${reason} not classified — review manually`);
  tags.push('MFN/SFP — file via SAFE-T claim');
  return { eligibility: 'maybe', reasons: tags };
}

export interface AmazonDisputeSyncResult {
  scanned: number;
  newEligible: number;
  newMaybe: number;
  newNotEligible: number;
  expired: number;
  totalEligibleValueCents: number;
}

/**
 * Scan Amazon refunds, classify each, upsert into amazon_dispute_candidates.
 * Pure SQL — runs in ms.
 */
export function syncAmazonDisputeCandidates(): AmazonDisputeSyncResult {
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
      WHERE r.marketplace = 'amazon'
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

  // Pre-load orders that have a matching reimbursement within ±14 days.
  // For each Amazon refund, if there's a reimbursement on the same ASIN/SKU
  // within 14 days of the refund, we treat it as already-paid (Amazon's
  // auto-reimbursement processed). This skips a separate query per row.
  const reimbursedRefundIds = new Set<number>();
  const reimbCheck = db.prepare(`
    SELECT id FROM reimbursements
    WHERE marketplace = 'amazon'
      AND ABS(julianday(reimbursement_date) - julianday(?)) <= 14
      AND ((? != '' AND asin = ?) OR (? != '' AND sku = ?))
    LIMIT 1
  `);
  for (const r of refunds) {
    const match = reimbCheck.get(r.refundDate, r.asin || '', r.asin || '', r.sku || '', r.sku || '') as { id: number } | undefined;
    if (match) reimbursedRefundIds.add(r.refundId);
  }

  const upsert = db.prepare(`
    INSERT INTO amazon_dispute_candidates (
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
      status = CASE
        WHEN amazon_dispute_candidates.status IN ('filed', 'received', 'dismissed') THEN amazon_dispute_candidates.status
        ELSE excluded.status
      END,
      updated_at = datetime('now')
  `);

  let newEligible = 0, newMaybe = 0, newNotEligible = 0;
  let totalEligibleValue = 0;

  const tx = db.transaction(() => {
    for (const r of refunds) {
      const alreadyReimbursed = reimbursedRefundIds.has(r.refundId);
      const { eligibility, reasons } = classifyEligibility(r.reason, r.fulfillmentChannel, r.refundDate, alreadyReimbursed);
      const windowEnd = new Date(new Date(r.refundDate).getTime() + SAFE_T_WINDOW_DAYS * 86400000)
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

  // Expire pending candidates past the SAFE-T window
  const expiredResult = db.prepare(`
    UPDATE amazon_dispute_candidates
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
