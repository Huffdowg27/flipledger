import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { recognizedCogsExpr, sellableReturnJoin } from '@/lib/cogs-reversal';
import {
  orderFeeAllocationCtes,
  productNameExpr,
} from '@/lib/order-fee-allocation';
import { isIsoCalendarDate, parseMarketplaceFilter } from '@/lib/request-filters';
import { HISTORY_CUTOVER } from '@/lib/accounting-cutover';
import { localDayRangeToUtcBounds } from '@/lib/local-day-boundaries';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

// Subquery to get each order's date — cash basis (posted_date) or accrual (purchase_date)
const ORDER_POSTED_DATE = `(
  SELECT scoped.order_id, scoped.posted_date
  FROM financial_events scoped INDEXED BY idx_financial_events_posted
  WHERE scoped.event_type = 'ShipmentEvent'
    AND scoped.order_id IS NOT NULL
    AND scoped.id = (
      SELECT earliest.id
      FROM financial_events earliest
      WHERE earliest.event_type = 'ShipmentEvent'
        AND earliest.order_id = scoped.order_id
      ORDER BY earliest.posted_date, earliest.id
      LIMIT 1
    )
)`;

const ORDER_PURCHASE_DATE = `(
  SELECT order_id, purchase_date as posted_date FROM orders
)`;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const rawStartDate = searchParams.get('startDate');
  const rawEndDate = searchParams.get('endDate');
  if (
    (rawStartDate !== null && !isIsoCalendarDate(rawStartDate))
    || (rawEndDate !== null && !isIsoCalendarDate(rawEndDate))
    || (rawStartDate !== null && rawEndDate !== null && rawStartDate > rawEndDate)
  ) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  }

  let startDate: string;
  if (rawStartDate) {
    startDate = rawStartDate;
  } else {
    const rawDays = searchParams.get('days') || '30';
    if (!/^\d+$/.test(rawDays)) {
      return NextResponse.json({ error: 'Invalid days' }, { status: 400 });
    }
    const days = Number(rawDays);
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
      return NextResponse.json({ error: 'Invalid days' }, { status: 400 });
    }
    startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  }

  const endDate = rawEndDate || new Date().toISOString().split('T')[0];

  const marketplaceResult = parseMarketplaceFilter(searchParams.get('marketplace'));
  if (!marketplaceResult.ok) {
    return NextResponse.json({ error: 'Invalid marketplace' }, { status: 400 });
  }
  const marketplace = marketplaceResult.marketplace;

  const dateBasis = searchParams.get('dateBasis') || 'posted';
  if (!['posted', 'purchase', 'reconciled'].includes(dateBasis)) {
    return NextResponse.json({ error: 'Invalid date basis' }, { status: 400 });
  }

  const summaryOnly = searchParams.get('summaryOnly') === '1';
  const MF_ORDER = marketplace ? 'AND o.marketplace = ?' : '';
  const MF_INCOME = marketplace ? 'AND inc.marketplace = ?' : '';
  const MF_EVENT = marketplace ? 'AND fe.marketplace = ?' : '';
  const MF_REFUND = marketplace ? 'AND r.marketplace = ?' : '';
  const MF_REIMBURSEMENT = marketplace ? 'AND rb.marketplace = ?' : '';
  const MF_TAX = marketplace ? 'AND st.marketplace = ?' : '';
  const withMarketplace = (...values: string[]): string[] => (
    marketplace ? [...values, marketplace] : values
  );

  // ── Fulfillment-channel filter (FBA vs merchant-fulfilled) ──────────────
  // A channel view shows ORDER-LEVEL economics only (sales, COGS, order fees,
  // refunds, MFN shipping). Business-wide costs that can't be attributed to a
  // single order — ads, storage, subscription, reimbursements, the pre-2026
  // historical segment, manual expenses — are EXCLUDED when a channel is set
  // (they belong to the "All channels" view). This matches the way Sellerboard
  // splits its per-channel table and keeps every channel number tied to the
  // same recognized-COGS engine as the All view.
  //
  // 'fba'/'mfn' is a closed server-side enum, so the fragment is a constant
  // literal (never user text) — it does NOT consume a bound parameter and so
  // never disturbs the positional withMarketplace(...) argument order.
  // INVARIANT: channel === null ⇒ CF_ORDER/CF_REFUND are '' ⇒ output is
  // byte-identical to the all-channels P&L.
  const channelParam = searchParams.get('channel');
  if (channelParam !== null && channelParam !== 'fba' && channelParam !== 'mfn') {
    return NextResponse.json({ error: 'Invalid channel' }, { status: 400 });
  }
  const channel = channelParam as 'fba' | 'mfn' | null;
  const channelView = channel !== null;

  // ── Local-day bucketing (opt-in) ────────────────────────────────────────
  // Stored dates are UTC timestamps (e.g. 2026-07-02T00:23:39Z). Comparing them
  // to a local YYYY-MM-DD boundary buckets by UTC day, so an order placed
  // 5-11pm Pacific spills into the next day — which is why the dashboard "Today"
  // card disagreed with Amazon Seller Central (Pacific). When localDays=1,
  // convert the requested local-day boundaries to UTC instants in JS and keep
  // the indexed timestamp columns raw in WHERE. Wrapping those columns with
  // datetime(..., 'localtime') forced a full scan for every snapshot query.
  // Only the daily display grouping still converts timestamps to local time.
  // Date-only columns are never shifted.
  const localDays = searchParams.get('localDays') === '1';
  const dayBucket = (col: string) => (
    localDays ? `datetime(${col}, 'localtime')` : col
  );
  const CF_ORDER =
    channel === 'fba' ? "AND o.fulfillment_channel NOT IN ('MFN', 'Seller')"
    : channel === 'mfn' ? "AND o.fulfillment_channel IN ('MFN', 'Seller')"
    : '';
  const CF_REFUND =
    channel === 'fba'
      ? "AND EXISTS (SELECT 1 FROM orders och WHERE och.order_id = r.order_id AND och.fulfillment_channel NOT IN ('MFN', 'Seller'))"
      : channel === 'mfn'
      ? "AND EXISTS (SELECT 1 FROM orders och WHERE och.order_id = r.order_id AND och.fulfillment_channel IN ('MFN', 'Seller'))"
      : '';

  // 'reconciled' uses posted_date basis but requires real fee rows (financial_event_id != 0),
  // excluding estimated fees written by estimateAndBackfillFees() for unreconciled orders.
  const DATE_SUB = dateBasis === 'purchase' ? ORDER_PURCHASE_DATE : ORDER_POSTED_DATE;
  const REAL_FEES_ONLY = dateBasis === 'reconciled' ? 'AND fd.financial_event_id != 0' : '';
  // Operating/purchase basis represents placed-order performance, so canceled
  // orders are excluded from every order-derived metric. Settled and Accounting
  // retain their existing ShipmentEvent-gated populations, preserving the
  // audited posted-basis baseline.
  const OPERATING_ORDER_FILTER = dateBasis === 'purchase'
    ? "AND o.status NOT IN ('Canceled', 'Cancelled')"
    : '';

  const endDateNext = new Date(new Date(endDate).getTime() + 86400000).toISOString().split('T')[0];

  // ── History cutover ──────────────────────────────────────────────────
  // Synced SP-API coverage starts 2024-06-29; before that, settlement truth
  // lives in historical_transactions / historical_cogs (imported from Amazon
  // Date Range Transaction Reports + InventoryLab exports). The two sources
  // must never overlap: synced queries are clamped to >= CUTOVER and the
  // historical segment covers < CUTOVER. May–June 2024 partial synced data is
  // deliberately superseded by the (complete) historical ledger.
  // 2026-01-01, not the sync-coverage start (2024-06-29): synced order-level
  // data is penny-exact from mid-2024, but NON-order fees (storage, inbound
  // transport, subscription, MFN labels, ads) come from settlement reports,
  // which Amazon only serves ~90 days back — all of 2025's are unreachable
  // (~$25K of expenses missing vs IL). The imported transaction reports have
  // them complete through 2025-12-31, so the report era owns everything
  // before 2026.
  // Historical data is Amazon-only — skip the segment when filtering to
  // another marketplace. User-entered tables (expenses, other_income) are not
  // marketplace syncs and keep the full requested range.
  const histActive = startDate < HISTORY_CUTOVER && (!marketplace || marketplace === 'amazon');
  const histEnd = endDateNext < HISTORY_CUTOVER ? endDateNext : HISTORY_CUTOVER;
  const syncedStart = startDate < HISTORY_CUTOVER ? HISTORY_CUTOVER : startDate;
  const timestampRange = localDays
    ? localDayRangeToUtcBounds(syncedStart, endDateNext)
    : { startUtc: syncedStart, endUtc: endDateNext };
  const withTimestampRange = () => withMarketplace(
    timestampRange.startUtc,
    timestampRange.endUtc,
  );
  const db = getDb();

  try {
    // Income (by posted_date — cash basis)
    const salesIncome = db.prepare(`
      SELECT COALESCE(SUM(oi.total_price), 0) as total
      FROM order_items oi
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
    `).get(...withTimestampRange()) as any;

    // MFN shipping credits (income — seller charges buyer for shipping)
    const mfnShippingCredits = db.prepare(`
      SELECT COALESCE(SUM(oi.shipping_charged), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
        AND o.fulfillment_channel IN ('MFN', 'Seller')
    `).get(...withTimestampRange()) as any;

    // FBA/WFS shipping credits (Amazon/Walmart charges buyer, passes to seller)
    const fbaShippingCredits = db.prepare(`
      SELECT COALESCE(SUM(oi.shipping_charged), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
        AND o.fulfillment_channel NOT IN ('MFN', 'Seller')
    `).get(...withTimestampRange()) as any;

    // FBA shipping credits ARE income: Amazon's settlement shows
    // ShippingCharge credit − free-shipping promo − ShippingChargeback = 0,
    // so the credit must be counted alongside promo rebates and the chargeback
    // fee for the three to net out (verified against IL 6/1-6/6: 56.81 − 47.11 − 9.70 = 0).
    const shippingCredits = { total: mfnShippingCredits.total };

    // Promotional rebates (negative — reduces income)
    const promoRebates = db.prepare(`
      SELECT COALESCE(SUM(oi.promotional_rebate), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
    `).get(...withTimestampRange()) as any;

    // other_income is business-wide (not per-order) → excluded from channel views.
    const otherIncomeTotal = channelView ? { total: 0 } : db.prepare(`
      SELECT COALESCE(SUM(inc.amount), 0) as total
      FROM other_income inc
      WHERE inc.date >= ? AND inc.date < ? ${MF_INCOME}
    `).get(...withMarketplace(startDate, endDateNext)) as any;

    // COGS (FIFO) — two exclusions, both matching IL:
    //  1. items returned as SELLABLE (unit is back in inventory; COGS will be
    //     charged again when it resells). QUANTITY-AWARE: reverse only the
    //     confirmed-returned units, not the whole order line (a multi-unit order
    //     with a partial sellable return keeps COGS on the units sold for good).
    //  2. amzn.gr.* (Amazon-graded) resales → $0. A regraded SKU is the second
    //     life of a unit whose buy cost was already expensed on its first sale;
    //     the customer return that produced the regrade was not sellable, so
    //     that COGS was never reversed. FL would otherwise re-expense the cost
    //     embedded in the regrade SKU (a double-count). IL carries every
    //     amzn.gr unit at $0 — we match it. (See historical era: IL's own
    //     export already books these at $0.)
    // Both exclusions live in the shared recognizedCogsExpr fragment so the
    // summary and sales-detail lines can never diverge.
    const cogsTotal = db.prepare(`
      SELECT COALESCE(SUM(${recognizedCogsExpr('oi')}), 0) as total
      FROM order_items oi
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      ${sellableReturnJoin('oi')}
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
    `).get(...withTimestampRange()) as any;

    // Gross COGS (synced era): FIFO COGS of all sold units BEFORE any return
    // adjustment (no sellable-return exclusion, no restock reversal). Lets the
    // Profit First report apply Jamie's own return-rate factor — replaces the
    // "Gross COGS from IL" manual input so we don't depend on InventoryLab.
    let cogsGrossTotal = (db.prepare(`
      SELECT COALESCE(SUM(
        CASE WHEN oi.sku NOT LIKE 'amzn.gr%' THEN oi.cogs_per_unit * oi.quantity ELSE 0 END
      ), 0) as total
      FROM order_items oi
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
    `).get(...withTimestampRange()) as any).total;

    // ── Disposition adjustments (synced era, ≥ 2026) ───────────────────────
    // Twin of the historical_dispositions write-offs, fed from InventoryLab's
    // Disposition Management export (table: dispositions). Two levers, both
    // bucketed by the disposition date (matching IL's report dating):
    //   buy_cost_adj > 0  → MFN Return sellable: unit restocked → REVERSE COGS
    //   buy_cost_adj < 0  → Removal/Liquidate/Disposal unsellable → WRITE-OFF
    // Amazon-only; skip when filtered to another marketplace. No overlap with
    // the SELLABLE customer-refund reversal above (verified: MFN-return order
    // ids never appear as disposition='SELLABLE' refunds).
    // Dispositions (removals/write-offs/restocks) are inventory-level, not
    // per-order → business-wide, excluded from channel views.
    const dispActive = (!marketplace || marketplace === 'amazon') && !channelView;
    const dispRestockReversal = dispActive ? (db.prepare(`
      SELECT COALESCE(SUM(buy_cost_adj), 0) as total FROM dispositions
      WHERE buy_cost_adj > 0 AND disp_date >= ? AND disp_date < ?
    `).get(syncedStart, endDateNext) as any).total : 0;
    const dispWriteoff = dispActive ? (db.prepare(`
      SELECT COALESCE(SUM(-buy_cost_adj), 0) as total FROM dispositions
      WHERE buy_cost_adj < 0 AND disp_date >= ? AND disp_date < ?
    `).get(syncedStart, endDateNext) as any).total : 0;
    // Restocked units' COGS reverses (they're back in sellable inventory and
    // will be charged COGS again on resale). Reduce the COGS line.
    cogsTotal.total -= dispRestockReversal;

    // Order-linked fees (by order's posted_date)
    // Use -SUM(amount) instead of SUM(ABS(amount)) so the fee total stays sign-correct.
    // Positive fee rows attached to RefundEvents are commission clawbacks — those are
    // already counted once via refunds.fee_clawback in netProfit, so they must NOT
    // also reduce the fee lines here (that double-counts the credit). Excluding them
    // keeps Selling Fees gross, matching IL's "Referral Fee" + "Selling Fee Refunds" split.
    // Negative RefundEvent fees (RefundCommission = refund admin fee) remain expenses.
    // In reconciled mode: REAL_FEES_ONLY excludes financial_event_id=0 estimated fee rows.
    const orderFees = db.prepare(`
      SELECT
        COALESCE(fd.fee_category, 'Other Fees') as category,
        fd.fee_type,
        COALESCE(-SUM(fd.amount), 0) as total
      FROM fee_details fd
      JOIN ${DATE_SUB} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      LEFT JOIN financial_events src ON fd.financial_event_id = src.id
      WHERE fd.order_id IS NOT NULL AND fd.order_id != ''
        AND fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
        AND NOT (src.event_type = 'RefundEvent' AND fd.amount > 0)
        ${REAL_FEES_ONLY}
      GROUP BY fd.fee_category, fd.fee_type
    `).all(...withTimestampRange()) as any[];

    // Non-order fees (service fees like storage, inbound shipping, subscriptions)
    // These are marketplace-specific — filter by marketplace when one is selected
    // Exclude ServiceFeeEvent rows for fee types that also appear in SettlementServiceFee.
    // ServiceFeeEvent is re-inserted every sync day (new posted_date bypasses unique constraint),
    // creating N duplicate rows. SettlementServiceFee posts once and is canonical.
    // Safe-to-keep ServiceFeeEvent-only types: FBAInboundConvenienceFee, ReCommerceGradingAndListingCharge.
    // Non-order service fees (storage, subscription, inbound, ads) have no order
    // to attribute to a channel → business-wide, excluded from channel views.
    const serviceFees = channelView ? [] : db.prepare(`
      SELECT
        COALESCE(fd.fee_category, 'Other Fees') as category,
        fd.fee_type,
        COALESCE(-SUM(fd.amount), 0) as total
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE (fd.order_id IS NULL OR fd.order_id = '')
        AND date(fd.posted_date) >= ?
        AND date(fd.posted_date) < ?
        ${MF_EVENT}
        AND NOT (
          fe.event_type = 'ServiceFeeEvent'
          AND fd.fee_type IN (
            'FBAStorageFee',
            'FBALongTermStorageFee',
            'FBARemovalFee',
            'Subscription',
            'FBACustomerReturnPerUnitFee',
            'FBAInboundTransportationFee'
          )
        )
      GROUP BY fd.fee_category, fd.fee_type
    `).all(...withMarketplace(syncedStart, endDateNext)) as any[];

    const feesByCategory = [...orderFees, ...serviceFees]
      .sort((a, b) => (a.category || '').localeCompare(b.category || '') || b.total - a.total);

    // Other expenses — business-wide (not marketplace- or channel-specific), so
    // only included in the All view.
    const expensesByCategory = (marketplace || channelView) ? [] : db.prepare(`
      SELECT category, COALESCE(SUM(amount), 0) as total
      FROM expenses WHERE date >= ? AND date < ?
      GROUP BY category ORDER BY total DESC
    `).all(startDate, endDateNext) as any[];

    const totalExpenses = (marketplace || channelView) ? { total: 0 } : db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ? AND date < ?
    `).get(startDate, endDateNext) as any;

    // Shipping costs
    const shippingCosts = db.prepare(`
      SELECT COALESCE(SUM(oi.shipping_cost), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
        AND o.fulfillment_channel = 'MFN'
    `).get(...withTimestampRange()) as any;

    // Refunds — for Walmart, only count refunds that have a corresponding
    // WalmartRefundEvent in the recon report (i.e., Walmart has actually
    // deducted the seller). Walmart's Returns API surfaces refunds at customer-
    // initiation time, but the seller debit lags by 1-3 weeks. Counting at
    // initiation overstates expenses; matching to recon settlement gives true
    // cash basis matching Walmart's Net Payable view.
    const refundTotal = db.prepare(`
      SELECT COALESCE(SUM(refund_amount), 0) as total, COALESCE(SUM(fee_clawback), 0) as clawback,
             COALESCE(SUM(restocking_fee), 0) as restocking
      FROM refunds r
      WHERE r.refund_date >= ? AND r.refund_date < ? ${MF_REFUND} ${CF_REFUND}
        AND (
          r.marketplace != 'walmart'
          OR EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.event_type = 'WalmartRefundEvent'
              AND fe.order_id = r.order_id
              AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
          )
        )
    `).get(...withTimestampRange()) as any;

    // Reimbursements (lost/damaged inventory credits) are business-wide, not
    // per-order → excluded from channel views. Exclude SETTLEMENT- rows
    // (duplicates of ADJ- rows from settlement report re-import).
    const reimbTotal = channelView ? { total: 0 } : db.prepare(`
      SELECT COALESCE(SUM(rb.amount), 0) as total
      FROM reimbursements rb
      WHERE rb.reimbursement_date >= ? AND rb.reimbursement_date < ? ${MF_REIMBURSEMENT}
        AND rb.reimbursement_id NOT LIKE 'SETTLEMENT-%'
    `).get(...withMarketplace(syncedStart, endDateNext)) as any;

    // Sales tax — stored as negative (Amazon reports withheld tax as a deduction);
    // negate so the P&L surfaces tax collected/remitted as a positive figure.
    // sales_tax has no order/channel identity. Like other unassignable
    // business-wide values, it belongs only to the All-channel response.
    const taxTotal: { collected: number; facilitator: number } = channelView
      ? { collected: 0, facilitator: 0 }
      : db.prepare(`
      SELECT COALESCE(SUM(-st.tax_collected), 0) as collected,
             COALESCE(SUM(-st.marketplace_facilitator_tax), 0) as facilitator
      FROM sales_tax st
      WHERE st.posted_date >= ? AND st.posted_date < ? ${MF_TAX}
    `).get(...withTimestampRange()) as { collected: number; facilitator: number };

    // ── Historical segment (< HISTORY_CUTOVER) ─────────────────────────
    // Settlement-truth buckets from Amazon's Date Range Transaction Reports
    // plus per-order InventoryLab buy costs. Transfer / loan / debt rows are
    // cash movements, not P&L, and are excluded.
    if (histActive && !channelView) {
      const h = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN type='Order' THEN product_sales + gift_wrap_credits END), 0) AS sales,
          COALESCE(SUM(CASE WHEN type='Order' AND fulfillment='Amazon' THEN shipping_credits END), 0) AS shipFba,
          COALESCE(SUM(CASE WHEN type='Order' AND COALESCE(fulfillment,'') != 'Amazon' THEN shipping_credits END), 0) AS shipMfn,
          COALESCE(SUM(CASE WHEN type='Order' THEN promotional_rebates END), 0) AS promo,
          COALESCE(SUM(CASE WHEN type='Order' THEN selling_fees END), 0) AS sellingFees,
          COALESCE(SUM(CASE WHEN type='Order' THEN fba_fees END), 0)
            + COALESCE(SUM(CASE WHEN type='FBA Customer Return Fee' THEN total END), 0) AS fbaFees,
          COALESCE(SUM(CASE WHEN type='Order' THEN other_transaction_fees + other END), 0) AS orderOtherFees,
          COALESCE(SUM(CASE WHEN type='Refund' THEN -(product_sales + shipping_credits + gift_wrap_credits + promotional_rebates) END), 0) AS refunds,
          COALESCE(SUM(CASE WHEN type='Refund' THEN selling_fees + fba_fees + other_transaction_fees + other END), 0) AS clawback,
          COALESCE(SUM(CASE WHEN type IN ('Adjustment','SAFE-T reimbursement') THEN total END), 0) AS reimb,
          COALESCE(SUM(CASE WHEN type='Shipping Services' THEN total END), 0) AS shippingServices,
          COALESCE(SUM(CASE WHEN type IN ('FBA Inventory Fee','FBA Inventory Fee - Reversal') THEN total END), 0) AS fbaInventoryFees,
          COALESCE(SUM(CASE WHEN type='Service Fee' THEN total END), 0) AS serviceFees,
          COALESCE(SUM(CASE WHEN type LIKE 'Liquidations%' THEN total END), 0) AS liquidations,
          COALESCE(SUM(CASE WHEN type NOT IN ('Order','Refund','Transfer','Automated Loan Repayment','Debt',
            'Adjustment','SAFE-T reimbursement','Shipping Services','FBA Inventory Fee','FBA Inventory Fee - Reversal',
            'Service Fee','FBA Customer Return Fee') AND type NOT LIKE 'Liquidations%' THEN total END), 0) AS otherMisc
        FROM historical_transactions
        WHERE txn_date >= ? AND txn_date < ?
      `).get(startDate, histEnd) as any;
      const hCogsGross = (db.prepare(
        'SELECT COALESCE(SUM(buy_cost), 0) AS t FROM historical_cogs WHERE date_posted >= ? AND date_posted < ?'
      ).get(startDate, histEnd) as any).t;

      // Return-COGS reversal (disposition-based, matching IL/Amazon's model):
      // refunded units restock and their COGS reverses — but only when the
      // item actually comes back. The restock rate is measured from 2025, the
      // one report-era year with full ground truth (IL COGS 224,686.67 vs
      // mechanical full reversal): ~10.8% of refunds are returnless.
      const RETURN_RESTOCK_RATE = 0.8915;
      const hReversal = (db.prepare(`
        WITH unit_costs AS (
          SELECT order_id, msku, SUM(buy_cost) * 1.0 / NULLIF(SUM(quantity), 0) AS unit_cost
          FROM historical_cogs GROUP BY order_id, msku
        )
        SELECT COALESCE(SUM(COALESCE(t.quantity, 1) * COALESCE(u.unit_cost, 0)), 0) AS t
        FROM historical_transactions t
        LEFT JOIN unit_costs u ON u.order_id = t.order_id AND u.msku = t.sku
        WHERE t.type = 'Refund' AND t.txn_date >= ? AND t.txn_date < ?
      `).get(startDate, histEnd) as any).t;

      // Write-offs from IL's disposition ledger: unsellable removals,
      // disposals, liquidations — buy cost goes INTO COGS. Positive
      // adjustments (MFN restocks) are deliberately ignored here: those
      // refunds already reverse through the refund-row reversal above.
      const hWriteoffs = (db.prepare(`
        SELECT COALESCE(SUM(-buy_cost_adj), 0) AS t FROM historical_dispositions
        WHERE buy_cost_adj < 0 AND disp_date >= ? AND disp_date < ?
      `).get(startDate, histEnd) as any).t;

      const hCogs = Math.round(hCogsGross - RETURN_RESTOCK_RATE * hReversal + hWriteoffs);

      salesIncome.total += h.sales;
      mfnShippingCredits.total += h.shipMfn;
      fbaShippingCredits.total += h.shipFba;
      shippingCredits.total += h.shipMfn;
      promoRebates.total += h.promo;
      otherIncomeTotal.total += h.liquidations;
      cogsTotal.total += hCogs;
      cogsGrossTotal += hCogsGross;
      refundTotal.total += h.refunds;
      refundTotal.clawback += h.clawback;
      reimbTotal.total += h.reimb;
      shippingCosts.total += -h.shippingServices; // stored negative; cost is positive

      // Fee buckets are pre-aggregated in the reports — surface them as
      // explicit "Historical" children so they're distinguishable in the UI.
      const histFees: { category: string; fee_type: string; total: number }[] = [
        { category: 'Selling Fees', fee_type: 'Historical Selling Fees', total: -h.sellingFees },
        { category: 'FBA Transaction Fees', fee_type: 'Historical FBA Fees', total: -h.fbaFees },
        { category: 'FBA Inventory and Inbound Service Fees', fee_type: 'Historical FBA Inventory Fees', total: -h.fbaInventoryFees },
        { category: 'Other Fees', fee_type: 'Historical Service & Other Fees', total: -(h.serviceFees + h.orderOtherFees + h.otherMisc) },
      ];
      for (const f of histFees) {
        if (f.total !== 0) feesByCategory.push(f);
      }
    }

    // Group fees into hierarchy
    const feeHierarchy: Record<string, { total: number; children: { name: string; amount: number }[] }> = {};
    for (const fee of feesByCategory) {
      if (!feeHierarchy[fee.category]) {
        feeHierarchy[fee.category] = { total: 0, children: [] };
      }
      feeHierarchy[fee.category].total += fee.total;
      feeHierarchy[fee.category].children.push({ name: fee.fee_type, amount: fee.total });
    }

    // promoRebates is negative (reduces income); restocking fees are kept by the
    // seller on partial refunds (income, matching IL's "Restocking Fee" line).
    const totalIncome = salesIncome.total + shippingCredits.total + fbaShippingCredits.total
      + promoRebates.total + refundTotal.restocking + otherIncomeTotal.total;
    const totalFees = Object.values(feeHierarchy).reduce((sum: number, cat: any) => sum + cat.total, 0);
    const totalAllExpenses = cogsTotal.total + totalFees + shippingCosts.total + totalExpenses.total + dispWriteoff;
    const netProfit = totalIncome - totalAllExpenses - refundTotal.total + refundTotal.clawback + reimbTotal.total;

    // Dashboard Operating sales mirrors Sellerboard's gross order total
    // (including customer-paid shipping/tax). Keep it separate from recognized
    // P&L fields so the accounting math remains internally consistent.
    const operatingSales = dateBasis === 'purchase' ? (db.prepare(`
      SELECT COALESCE(SUM(o.order_total), 0) as total
      FROM orders o
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
        ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
    `).get(...withTimestampRange()) as { total: number }).total : null;

    const unitSummary = summaryOnly ? db.prepare(`
      SELECT
        COALESCE(SUM(oi.quantity), 0) as units,
        COUNT(DISTINCT oi.order_id) as orders
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
    `).get(...withTimestampRange()) as { orders: number; units: number } : null;

    const dailySummary = summaryOnly ? db.prepare(`
      SELECT
        substr(${dayBucket('fe.posted_date')}, 1, 10) as day,
        COALESCE(SUM(oi.total_price), 0) as revenue,
        0 as profit
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
      GROUP BY substr(${dayBucket('fe.posted_date')}, 1, 10)
      ORDER BY day
    `).all(...withTimestampRange()) as any[] : [];

    const refundSummary = summaryOnly ? db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(r.quantity), 0) as units
      FROM refunds r
      WHERE r.refund_date >= ? AND r.refund_date < ? ${MF_REFUND} ${CF_REFUND}
        AND (
          r.marketplace != 'walmart'
          OR EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.event_type = 'WalmartRefundEvent'
              AND fe.order_id = r.order_id
              AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
          )
        )
    `).get(...withTimestampRange()) as { count: number; units: number } : null;

    // Sales detail — individual products sold in the period, with per-order fees
    const salesDetail = summaryOnly ? [] : db.prepare(`
      WITH ${orderFeeAllocationCtes({
        realFeesOnly: dateBasis === 'reconciled',
      })}
      SELECT
        oi.order_id,
        o.marketplace,
        o.fulfillment_channel,
        ${productNameExpr('oi', 'o')} as product_name,
        oi.asin,
        oi.sku,
        oi.quantity,
        oi.total_price as revenue,
        -- Quantity-aware SELLABLE-return reversal + amzn.gr $0, identical to the
        -- summary COGS line (shared fragment).
        ${recognizedCogsExpr('oi')} as cogs,
        COALESCE(aof.allocated_fee, 0) as fees,
        oi.shipping_cost as shippingCost,
        oi.total_price - (${recognizedCogsExpr('oi')}) + COALESCE(aof.allocated_fee, 0) - COALESCE(oi.shipping_cost, 0) as net_profit,
        fe.posted_date,
        o.purchase_date
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      ${sellableReturnJoin('oi')}
      LEFT JOIN allocated_order_fees aof ON aof.id = oi.id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER} ${CF_ORDER} ${OPERATING_ORDER_FILTER}
      ORDER BY fe.posted_date DESC
      LIMIT 500
    `).all(...withTimestampRange()) as any[];

    // Refund detail for the period.
    //
    // Amazon refunds often arrive with an EMPTY asin and the numeric MSKU in
    // r.sku (e.g. "1070389709"). The products table is keyed by real ASIN
    // (B0…), so direct r.asin → products.asin and r.sku → products.asin joins
    // both fail. The fix: go through order_items (which has the real ASIN + a
    // products.name-compatible row) via r.order_id. We also try the historic
    // fallbacks (r.asin → products.asin, r.sku → products.asin or sku) to
    // handle marketplaces where refunds.asin is actually populated (Walmart,
    // eBay historical).
    const refundDetail = summaryOnly ? [] : db.prepare(`
      SELECT
        r.order_id,
        r.marketplace,
        COALESCE(
          p_via_oi.name,   -- real ASIN resolved through order_items
          p.name,          -- refunds.asin → products.asin
          p2.name,         -- refunds.sku → products.asin (legacy)
          p3.name,         -- refunds.sku → products.sku (Walmart/eBay path)
          oi.asin,         -- if we got a real ASIN from order_items but no products row, display it
          NULLIF(r.asin, ''),
          r.sku
        ) as product_name,
        COALESCE(NULLIF(r.asin, ''), oi.asin) as asin,
        r.sku,
        r.quantity,
        r.refund_amount,
        r.fee_clawback,
        r.reason,
        r.refund_date
      FROM refunds r
      LEFT JOIN order_items oi
        ON oi.order_id = r.order_id
        AND (
          (NULLIF(r.sku, '') IS NOT NULL AND oi.sku = r.sku)
          OR (NULLIF(r.asin, '') IS NOT NULL AND oi.asin = r.asin AND NULLIF(r.sku, '') IS NULL)
        )
      LEFT JOIN products p_via_oi ON p_via_oi.asin = oi.asin
      LEFT JOIN products p  ON p.asin = r.asin AND r.asin != ''
      LEFT JOIN products p2 ON p2.asin = r.sku
      LEFT JOIN products p3 ON p3.sku  = r.sku
      WHERE r.refund_date >= ? AND r.refund_date < ? ${MF_REFUND} ${CF_REFUND}
        AND (
          r.marketplace != 'walmart'
          OR EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.event_type = 'WalmartRefundEvent'
              AND fe.order_id = r.order_id
              AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
          )
        )
      GROUP BY r.id
      ORDER BY r.refund_date DESC
      LIMIT 200
    `).all(...withTimestampRange()) as any[];

    db.close();

    return NextResponse.json({
      income: {
        sales: salesIncome.total,
        shippingCredits: shippingCredits.total,
        mfnShippingCredits: mfnShippingCredits.total,
        fbaShippingCredits: fbaShippingCredits.total,
        promoRebates: promoRebates.total,
        restockingFees: refundTotal.restocking,
        otherIncome: otherIncomeTotal.total,
        total: totalIncome,
      },
      expenses: {
        cogs: cogsTotal.total,
        cogsGross: cogsGrossTotal,
        feeHierarchy,
        shippingCosts: shippingCosts.total,
        otherExpenses: totalExpenses.total,
        otherExpensesByCategory: expensesByCategory,
        inventoryWriteoff: dispWriteoff,
        dispositionRestockReversal: dispRestockReversal,
        totalFees,
        total: totalAllExpenses,
      },
      refunds: {
        total: refundTotal.total,
        clawback: refundTotal.clawback,
        net: refundTotal.total - refundTotal.clawback,
      },
      reimbursements: reimbTotal.total,
      salesTax: {
        collected: taxTotal.collected,
        facilitator: taxTotal.facilitator,
      },
      netProfit,
      margin: totalIncome > 0 ? (netProfit / totalIncome) * 100 : 0,
      operatingSales,
      dateBasis,
      channel,
      localDays,
      unitSummary,
      dailySummary,
      refundSummary,
      salesDetail,
      refundDetail,
    });
  } catch (error) {
    db.close();
    console.error('P&L API error:', error);
    return NextResponse.json({ error: 'Failed to load P&L data' }, { status: 500 });
  }
}
