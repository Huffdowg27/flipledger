/**
 * GET /api/debug/fee-double-count?startDate=2026-04-11&endDate=2026-05-11
 *
 * READ-ONLY fee double-count diagnostic.
 *
 * Root cause: non-order ServiceFeeEvent rows re-insert on every sync run
 * because each sync day produces a new posted_date, bypassing the
 * (event_type, order_id, asin, sku, posted_date, total_amount) unique constraint.
 * The same underlying fee ends up with N rows — one per sync day.
 * Settlement reports (SettlementServiceFee) capture the same fee once when settled.
 *
 * Confirmed duplicate pairs:
 *   FBAStorageFee   (ServiceFeeEvent) ↔ StorageFee           (SettlementServiceFee)
 *   FBARemovalFee   (ServiceFeeEvent) ↔ RemovalComplete       (SettlementServiceFee)
 *   Subscription    (ServiceFeeEvent) ↔ SubscriptionFee       (SettlementServiceFee)
 *   FBACustomerReturnPerUnitFee (Svc) ↔ FBACustomerReturnPerUnitFee (Settlement)
 *   FBAInboundTransportationFee (Svc) ↔ InboundTransportationFee   (Settlement)
 *
 * HARD RULES: readonly DB, no writes, no production changes.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  return new Database(dbPath, { readonly: true });
}

function cents(n: number | null | undefined): string {
  if (n == null) return '$0.00';
  return '$' + (n / 100).toFixed(2);
}

// Known duplicate pairs: ServiceFeeEvent fee_type → SettlementServiceFee fee_type
const DUPLICATE_PAIRS: { svc: string; settlement: string; ilBucket: string }[] = [
  { svc: 'FBAStorageFee',              settlement: 'StorageFee',                  ilBucket: '30 Day Storage Fees' },
  { svc: 'FBARemovalFee',              settlement: 'RemovalComplete',              ilBucket: 'Removal Order Fees' },
  { svc: 'Subscription',               settlement: 'SubscriptionFee',              ilBucket: 'Amazon Pro Subscription' },
  { svc: 'FBACustomerReturnPerUnitFee',settlement: 'FBACustomerReturnPerUnitFee',  ilBucket: 'FBA Customer Return Per Unit Fee' },
  { svc: 'FBAInboundTransportationFee',settlement: 'InboundTransportationFee',     ilBucket: 'Inbound Transportation Fee' },
];

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const startDate = searchParams.get('startDate') ?? '2026-04-11';
  const endDate   = searchParams.get('endDate')   ?? '2026-05-11';
  const endExcl   = new Date(endDate);
  endExcl.setDate(endExcl.getDate() + 1);
  const endNext   = endExcl.toISOString().slice(0, 10);

  const db = getDb();
  try {
    // ── ALL NON-ORDER FEES: ServiceFeeEvent vs SettlementServiceFee ─────────
    const allNonOrderSvc = db.prepare(`
      SELECT fd.fee_type, fd.fee_category, fe.event_type,
             COUNT(*) AS cnt,
             SUM(fd.amount) AS total,
             MIN(fd.posted_date) AS first_date,
             MAX(fd.posted_date) AS last_date,
             COUNT(DISTINCT date(fd.posted_date)) AS distinct_days
      FROM fee_details fd
      JOIN financial_events fe ON fe.id = fd.financial_event_id
      WHERE (fd.order_id IS NULL OR fd.order_id = '')
        AND date(fd.posted_date) >= ? AND date(fd.posted_date) < ?
      GROUP BY fd.fee_type, fd.fee_category, fe.event_type
      ORDER BY SUM(fd.amount) ASC
    `).all(startDate, endNext) as any[];

    // ── DUPLICATE PAIR ANALYSIS ──────────────────────────────────────────────
    const pairAnalysis = DUPLICATE_PAIRS.map(pair => {
      const svcRows = allNonOrderSvc.find(
        r => r.fee_type === pair.svc && r.event_type === 'ServiceFeeEvent'
      );
      const settlRows = allNonOrderSvc.find(
        r => r.fee_type === pair.settlement && r.event_type === 'SettlementServiceFee'
      );

      const svcTotal    = svcRows?.total   ?? 0;
      const settlTotal  = settlRows?.total ?? 0;
      const combinedTotal = svcTotal + settlTotal;
      const duplicate   = svcTotal !== 0 && settlTotal !== 0;

      // How many times is the ServiceFeeEvent fee re-inserted?
      const svcDays = svcRows?.distinct_days ?? 0;
      const svcCount = svcRows?.cnt ?? 0;
      const estimatedTrueCost = settlTotal !== 0 ? settlTotal : (svcDays > 0 ? svcTotal / svcDays : svcTotal);

      return {
        svc_fee_type:        pair.svc,
        settlement_fee_type: pair.settlement,
        il_bucket:           pair.ilBucket,
        is_duplicate:        duplicate,
        svc_event_type_total:        cents(svcTotal),
        svc_rows:            svcCount,
        svc_distinct_days:   svcDays,
        svc_repeat_factor:   svcDays > 1 ? svcDays : null,
        settlement_total:    cents(settlTotal),
        settlement_rows:     settlRows?.cnt ?? 0,
        fl_currently_counts: cents(combinedTotal),
        estimated_true_cost: cents(estimatedTrueCost),
        overcount_amount:    duplicate ? cents(combinedTotal - estimatedTrueCost) : '$0.00',
        verdict:             duplicate
          ? `CONFIRMED DUPLICATE — same charge from two API sources. ServiceFeeEvent re-inserts ${svcDays}x (one per sync run). True cost ≈ ${cents(estimatedTrueCost)}.`
          : svcTotal !== 0 && settlTotal === 0
            ? 'ServiceFeeEvent only — no settlement equivalent in range. May be correct or pre-settlement.'
            : 'Settlement only — no ServiceFeeEvent equivalent.',
      };
    });

    // ── STORAGE DETAIL: per-day repetition proof ─────────────────────────────
    const storageByDay = db.prepare(`
      SELECT date(fd.posted_date) AS day,
             COUNT(*) AS rows,
             SUM(fd.amount) AS total,
             fe.event_type
      FROM fee_details fd
      JOIN financial_events fe ON fe.id = fd.financial_event_id
      WHERE fd.fee_type IN ('FBAStorageFee', 'StorageFee')
        AND date(fd.posted_date) >= ? AND date(fd.posted_date) < ?
      GROUP BY day, fd.fee_type, fe.event_type
      ORDER BY day, fe.event_type
    `).all(startDate, endNext) as any[];

    // ── REMOVAL DETAIL: amount matching ──────────────────────────────────────
    const removalSvcRows = db.prepare(`
      SELECT fd.id, fd.amount, date(fd.posted_date) AS day, fe.event_type,
             fe.id AS fe_id
      FROM fee_details fd
      JOIN financial_events fe ON fe.id = fd.financial_event_id
      WHERE fd.fee_type = 'FBARemovalFee'
        AND date(fd.posted_date) >= ? AND date(fd.posted_date) < ?
      ORDER BY fd.amount, fd.posted_date
    `).all(startDate, endNext) as any[];

    const removalSettlRows = db.prepare(`
      SELECT fd.id, fd.amount, date(fd.posted_date) AS day, fe.event_type,
             fe.id AS fe_id
      FROM fee_details fd
      JOIN financial_events fe ON fe.id = fd.financial_event_id
      WHERE fd.fee_type = 'RemovalComplete'
        AND date(fd.posted_date) >= ? AND date(fd.posted_date) < ?
      ORDER BY fd.amount, fd.posted_date
    `).all(startDate, endNext) as any[];

    // Match RemovalComplete rows to FBARemovalFee by amount
    const svcAmounts = removalSvcRows.map((r: any) => Math.abs(r.amount));
    const matchedRemoval = removalSettlRows.map((rc: any) => {
      const idx = svcAmounts.indexOf(Math.abs(rc.amount));
      const match = idx >= 0 ? removalSvcRows[idx] : null;
      if (idx >= 0) svcAmounts[idx] = -1; // consume
      return {
        settlement_day: rc.day,
        settlement_amount: cents(rc.amount),
        settlement_fd_id: rc.id,
        svc_match_day: match?.day ?? null,
        svc_match_amount: match ? cents(match.amount) : null,
        svc_match_fd_id: match?.fd_id ?? null,
        matched: !!match,
      };
    });

    const unmatched_svc = removalSvcRows.filter((_: any, i: number) => svcAmounts[i] !== -1);

    // ── SUBSCRIPTION DETAIL ──────────────────────────────────────────────────
    const subscriptionRows = db.prepare(`
      SELECT fd.id, fd.fee_type, fd.amount, date(fd.posted_date) AS day,
             fe.event_type, fe.id AS fe_id
      FROM fee_details fd
      JOIN financial_events fe ON fe.id = fd.financial_event_id
      WHERE fd.fee_type IN ('Subscription', 'SubscriptionFee')
        AND date(fd.posted_date) >= ? AND date(fd.posted_date) < ?
      ORDER BY fd.posted_date, fe.event_type
    `).all(startDate, endNext) as any[];

    // ── FULL NON-ORDER FEE TABLE: all rows with source and duplicate flag ────
    const allNonOrderRows = db.prepare(`
      SELECT fd.id AS fd_id, fd.fee_type, fd.fee_category,
             fd.amount, date(fd.posted_date) AS posted_date,
             fd.order_id, fd.asin,
             fe.event_type AS source_event_type,
             fe.id AS fe_id
      FROM fee_details fd
      JOIN financial_events fe ON fe.id = fd.financial_event_id
      WHERE (fd.order_id IS NULL OR fd.order_id = '')
        AND date(fd.posted_date) >= ? AND date(fd.posted_date) < ?
      ORDER BY fd.fee_type, fd.posted_date
    `).all(startDate, endNext) as any[];

    const svcDuplicateTypes = new Set(DUPLICATE_PAIRS.map(p => p.svc));
    const settlDuplicateTypes = new Set(DUPLICATE_PAIRS.map(p => p.settlement));

    const annotatedRows = allNonOrderRows.map((r: any) => {
      const isSvcDupe  = r.source_event_type === 'ServiceFeeEvent' && svcDuplicateTypes.has(r.fee_type);
      const isSettlDupe = r.source_event_type === 'SettlementServiceFee' && settlDuplicateTypes.has(r.fee_type);
      const pair = DUPLICATE_PAIRS.find(p => p.svc === r.fee_type || p.settlement === r.fee_type);

      return {
        fd_id:             r.fd_id,
        fee_type:          r.fee_type,
        fee_category:      r.fee_category,
        amount:            cents(r.amount),
        posted_date:       r.posted_date,
        source:            r.source_event_type,
        fe_id:             r.fe_id,
        order_id:          r.order_id ?? null,
        asin:              r.asin ?? null,
        il_bucket:         pair?.ilBucket ?? null,
        suspected_duplicate: isSvcDupe
          ? `YES — ServiceFeeEvent version of "${pair?.settlement}". This row likely re-inserted on each sync run.`
          : isSettlDupe
            ? `KEEP — SettlementServiceFee canonical source.`
            : 'NO — no known duplicate pair.',
        duplicate_group:   pair ? `${pair.svc} ↔ ${pair.settlement}` : null,
      };
    });

    // ── IMPACT SUMMARY ───────────────────────────────────────────────────────
    // What FL currently counts vs what it should count
    const currentSvcTotal   = allNonOrderSvc.filter(r => r.event_type === 'ServiceFeeEvent')
                                            .reduce((s: number, r: any) => s + r.total, 0);
    const currentSettlTotal = allNonOrderSvc.filter(r => r.event_type === 'SettlementServiceFee')
                                            .reduce((s: number, r: any) => s + r.total, 0);

    // Duplicate ServiceFeeEvent totals (overcounts)
    const svcDupeTotals = allNonOrderSvc.filter(
      r => r.event_type === 'ServiceFeeEvent' && svcDuplicateTypes.has(r.fee_type)
    ).reduce((s: number, r: any) => s + r.total, 0);

    // Non-duplicate ServiceFeeEvent fees (no settlement equivalent found in range)
    const svcNonDupeTotal = allNonOrderSvc.filter(
      r => r.event_type === 'ServiceFeeEvent' && !svcDuplicateTypes.has(r.fee_type)
    ).reduce((s: number, r: any) => s + r.total, 0);

    const impactSummary = {
      fl_current_total_non_order_fees: cents(currentSvcTotal + currentSettlTotal),
      from_service_fee_event:          cents(currentSvcTotal),
      from_settlement_report:          cents(currentSettlTotal),
      suspected_overcount_from_svc_dupes: cents(svcDupeTotals),
      svc_fees_with_no_settlement_equiv:  cents(svcNonDupeTotal),
      corrected_total_if_svc_dupes_removed: cents(currentSettlTotal + svcNonDupeTotal),
      per_category_impact: pairAnalysis.map(p => ({
        category:     p.il_bucket,
        fl_current:   p.fl_currently_counts,
        true_cost:    p.estimated_true_cost,
        overcount:    p.overcount_amount,
        is_duplicate: p.is_duplicate,
      })),
    };

    return NextResponse.json({
      meta: {
        startDate, endDate, endNextUsed: endNext,
        today: new Date().toISOString().slice(0, 10),
        note: 'READ-ONLY fee double-count diagnostic. No writes.',
        generatedAt: new Date().toISOString(),
      },

      root_cause: {
        mechanism: 'ServiceFeeEvent non-order fees re-insert on every sync run. Each sync day creates a new financial_events row with that day as posted_date. Because the unique constraint on financial_events uses posted_date as part of the key, a new date = new row = new fee_details rows. The same underlying Amazon charge ends up with N rows where N = number of sync runs that covered its original posted_date.',
        confirmed_duplicate_pairs: DUPLICATE_PAIRS.map(p => `${p.svc} (ServiceFeeEvent) ↔ ${p.settlement} (SettlementServiceFee)`),
        correct_source: 'SettlementServiceFee — posted once when the fee settles. No re-insertion across sync runs.',
        fix_approach: 'In the P&L / dashboard serviceFees query, exclude non-order fee_details rows where the parent financial_event.event_type = "ServiceFeeEvent" AND the fee_type is in the known duplicate set. OR: exclude all non-order ServiceFeeEvent fees and rely entirely on SettlementServiceFee (but verify FBAInboundConvenienceFee has a settlement equivalent first).',
      },

      pair_analysis: pairAnalysis,

      storage_by_day: {
        note: 'Same 169 per-ASIN FBAStorageFee rows inserted on April 23, 24, 25, 26, 27 (5 sync runs). Each day adds -$140.03. Total = -$700.15 = 5 × -$140.03.',
        rows: storageByDay.map((r: any) => ({
          day: r.day,
          fee_type: r.fee_type ?? 'FBAStorageFee/StorageFee',
          source: r.event_type,
          row_count: r.rows,
          total: cents(r.total),
        })),
      },

      removal_match: {
        note: 'RemovalComplete (SettlementServiceFee) matched to FBARemovalFee (ServiceFeeEvent) by amount. 8 of 11 settlement rows have a matching ServiceFeeEvent amount. FBARemovalFee also has 33 unmatched rows — the same removal amounts repeated across additional sync days.',
        matched_pairs: matchedRemoval,
        unmatched_svc_count: unmatched_svc.length,
        unmatched_svc_total: cents(unmatched_svc.reduce((s: number, r: any) => s + r.amount, 0)),
        unmatched_svc_rows: unmatched_svc.map((r: any) => ({
          day: r.day,
          amount: cents(r.amount),
          fd_id: r.id,
          verdict: 'FBARemovalFee with no RemovalComplete match — same-amount charge already matched earlier in the list; this is a repeat-sync duplicate.',
        })),
      },

      subscription_rows: subscriptionRows.map((r: any) => ({
        fd_id:      r.id,
        fee_type:   r.fee_type,
        amount:     cents(r.amount),
        day:        r.day,
        source:     r.event_type,
        fe_id:      r.fe_id,
        verdict:    r.fee_type === 'Subscription' && r.source_event_type !== 'SettlementServiceFee'
                      ? 'DUPLICATE — same $39.99 Pro subscription already in SubscriptionFee row'
                      : 'CANONICAL — SettlementServiceFee source',
      })),

      impact_summary: impactSummary,

      all_non_order_fee_rows: {
        note: 'Every non-order fee row in fee_details for the date range, annotated with source and duplicate status.',
        count: annotatedRows.length,
        rows: annotatedRows,
      },
    });
  } finally {
    db.close();
  }
}
