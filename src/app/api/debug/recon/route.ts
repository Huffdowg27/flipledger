/**
 * GET /api/debug/recon?startDate=2026-04-11&endDate=2026-05-11
 *
 * READ-ONLY reconciliation audit endpoint — three distinct modes.
 *
 * Mode 1: Accrual / Estimated
 *   FL basis: order purchase_date (all orders regardless of settlement)
 *   IL target: "Include Estimated: ON, Reconciled Only: OFF"
 *
 * Mode 2: Cash / Reconciled
 *   FL basis: ShipmentEvent posted_date (settled orders only)
 *   IL target: "Reconciled Only: ON" — data TBD, not yet provided
 *
 * Mode 3: DD+7 Forecast
 *   Not a P&L comparison. Shows shipped-but-not-yet-posted orders grouped
 *   by expected posting date (shipped_at + 7 days). Cashflow forecast only.
 *
 * HARD RULES:
 *   - Opens DB as readonly — no writes possible
 *   - Does NOT modify any existing dashboard / pnl routes
 *   - Temporary debug tool — remove when audit is complete
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  return new Database(dbPath, { readonly: true });
}

// ─── InventoryLab targets ─────────────────────────────────────────────────────
// All values in CENTS.

// Mode 1 target: IL "Include Estimated: ON, Reconciled Only: OFF"
const IL_ESTIMATED: Record<string, number> = {
  sales:                     4_517_778,
  refunds:                  -3_508_53 * -1,    // magnitude; subtract in P&L
  reimbursements:               15_690,
  mfnShippingCredit:            31_694,
  shippingCredit:               30_485,
  shippingCreditRefunds:        -2_883,
  giftWrapCredits:                 399,
  promotionalRebates:          -24_519,
  promotionalRebateRefunds:      2_184,
  otherIncomeLiquidations:       1_341,
  incomeTotal:               4_221_316,
  cogs:                     -2_299_455,
  sellingFees:                -669_980,
  amazonReferralFee:          -664_411,
  closingFees:                  -5_569,
  fbaTransactionFees:         -458_485,
  fbaFulfillmentFees:         -452_120,
  giftWrapChargeback:             -399,
  shippingChargeback:           -5_966,
  fbaTransactionFeeRefund:         699,
  fbaInventoryInboundFees:     -29_835,
  storageFees:                 -15_007,
  removalOrderFees:             -3_487,
  ltsFees:                      -3_725,
  totalNetProfit:              752_189,
};

// Mode 2 target: IL "Reconciled Only: ON" — not yet provided
const IL_RECONCILED: Record<string, number | null> = {
  // Populate after user provides the IL Reconciled-Only screenshot.
  // All values null = TBD.
  sales: null,
  refunds: null,
  reimbursements: null,
  mfnShippingCredit: null,
  shippingCredit: null,
  cogs: null,
  sellingFees: null,
  fbaFulfillmentFees: null,
  storageFees: null,
  removalOrderFees: null,
  ltsFees: null,
  totalNetProfit: null,
};

function cents(n: number | null | undefined): number { return n ?? 0; }
function fmt(c: number): string { return `$${(c / 100).toFixed(2)}`; }
function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const startDate   = searchParams.get('startDate') || '2026-04-11';
  const endDate     = searchParams.get('endDate')   || '2026-05-11';
  const endDateNext = addDays(endDate + 'T00:00:00', 1);

  const db = getDb();
  try {
    // ─── Date subqueries ─────────────────────────────────────────────────────
    const CASH_SUB = `(
      SELECT order_id, MIN(posted_date) as posted_date
      FROM financial_events
      WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL
      GROUP BY order_id
    )`;
    const ACCRUAL_SUB = `(
      SELECT order_id, purchase_date as posted_date FROM orders
    )`;

    // ─── Core query builders ─────────────────────────────────────────────────
    const revenueSQL = (sub: string) => `
      SELECT
        COUNT(DISTINCT oi.order_id) as orders,
        COALESCE(SUM(oi.quantity), 0) as units,
        COALESCE(SUM(oi.total_price), 0) as saleCents,
        COALESCE(SUM(CASE WHEN o.fulfillment_channel IN ('MFN','Seller')
          THEN COALESCE(oi.shipping_charged,0) ELSE 0 END), 0) as mfnShipCents,
        COALESCE(SUM(CASE WHEN o.fulfillment_channel NOT IN ('MFN','Seller')
          THEN COALESCE(oi.shipping_charged,0) ELSE 0 END), 0) as fbaShipCents,
        COALESCE(SUM(COALESCE(oi.promotional_rebate,0)), 0) as promoRebateCents
      FROM order_items oi
      JOIN ${sub} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ?
        AND o.marketplace = 'amazon'
    `;

    const cogsSQL = (sub: string) => `
      SELECT
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogsCents,
        COUNT(CASE WHEN oi.cogs_per_unit = 0 OR oi.cogs_per_unit IS NULL THEN 1 END) as zeroCogItems
      FROM order_items oi
      JOIN ${sub} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ?
        AND o.marketplace = 'amazon'
    `;

    const orderFeesSQL = (sub: string) => `
      SELECT fd.fee_type,
             COALESCE(fd.fee_category,'Other Fees') as fee_category,
             COALESCE(-SUM(fd.amount), 0) as totalCents,
             COUNT(*) as cnt
      FROM fee_details fd
      JOIN ${sub} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE fd.order_id IS NOT NULL AND fd.order_id != ''
        AND fe.posted_date >= ? AND fe.posted_date < ?
        AND o.marketplace = 'amazon'
      GROUP BY fd.fee_type, fd.fee_category
      ORDER BY ABS(SUM(fd.amount)) DESC
    `;

    // ─── Run both bases ───────────────────────────────────────────────────────
    const args = [startDate, endDateNext];
    const revCash    = db.prepare(revenueSQL(CASH_SUB)).get(...args)    as any;
    const revAccrual = db.prepare(revenueSQL(ACCRUAL_SUB)).get(...args) as any;
    const cogsCash    = db.prepare(cogsSQL(CASH_SUB)).get(...args)    as any;
    const cogsAccrual = db.prepare(cogsSQL(ACCRUAL_SUB)).get(...args) as any;
    const feesCash    = db.prepare(orderFeesSQL(CASH_SUB)).all(...args)    as any[];
    const feesAccrual = db.prepare(orderFeesSQL(ACCRUAL_SUB)).all(...args) as any[];

    // Service fees (non-order) — date is fd.posted_date, same for both bases.
    // Exclude ServiceFeeEvent rows for fee types that also appear in SettlementServiceFee
    // (storage, removal, subscription, customerReturn, inboundTransport) — those rows are
    // duplicated each sync day. SettlementServiceFee is the canonical single source.
    const serviceFees = db.prepare(`
      SELECT fd.fee_type,
             COALESCE(fd.fee_category,'Other Fees') as fee_category,
             COALESCE(-SUM(fd.amount), 0) as totalCents,
             COUNT(*) as cnt
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE (fd.order_id IS NULL OR fd.order_id = '')
        AND date(fd.posted_date) >= ? AND date(fd.posted_date) < ?
        AND (fe.marketplace = 'amazon' OR fe.marketplace IS NULL)
        AND NOT (
          fe.event_type = 'ServiceFeeEvent'
          AND fd.fee_type IN (
            'FBAStorageFee',
            'FBARemovalFee',
            'Subscription',
            'FBACustomerReturnPerUnitFee',
            'FBAInboundTransportationFee'
          )
        )
      GROUP BY fd.fee_type, fd.fee_category
      ORDER BY ABS(SUM(fd.amount)) DESC
    `).all(...args) as any[];

    // Refunds — by refund_date; same for both bases
    const refundRow = db.prepare(`
      SELECT
        COALESCE(SUM(refund_amount), 0) as refundCents,
        COALESCE(SUM(fee_clawback), 0)  as clawbackCents,
        COUNT(*) as cnt,
        COUNT(CASE WHEN disposition='SELLABLE' AND item_returned=1 THEN 1 END) as sellableReturns
      FROM refunds
      WHERE refund_date >= ? AND refund_date < ? AND marketplace = 'amazon'
    `).get(...args) as any;

    // Reimbursements — by reimbursement_date; same for both bases.
    // Exclude SETTLEMENT- rows (duplicates of ADJ- rows from settlement report re-import).
    const reimbRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as cnt
      FROM reimbursements
      WHERE reimbursement_date >= ? AND reimbursement_date < ? AND marketplace = 'amazon'
        AND reimbursement_id NOT LIKE 'SETTLEMENT-%'
    `).get(...args) as any;

    // ─── Fee-type helper ──────────────────────────────────────────────────────
    function sumFee(rows: any[], types: string | string[]): number {
      const t = Array.isArray(types) ? types : [types];
      return rows.filter(r => t.includes(r.fee_type)).reduce((s, r) => s + (r.totalCents ?? 0), 0);
    }

    // ─── Build P&L summary for a given basis ─────────────────────────────────
    function buildPnl(revRow: any, cogsRow: any, orderFees: any[]) {
      const sale        = cents(revRow?.saleCents);
      const mfnShip     = cents(revRow?.mfnShipCents);
      const fbaShip     = cents(revRow?.fbaShipCents);
      const promoRebate = cents(revRow?.promoRebateCents);   // negative value
      const cogsVal     = cents(cogsRow?.cogsCents);

      // Order-linked fees
      const referral    = sumFee(orderFees, ['Commission']);
      const closing     = sumFee(orderFees, ['VariableClosingFee','FixedClosingFee','HighVolumeListingFee']);
      const fbaFulfil   = sumFee(orderFees, ['FBAPerUnitFulfillmentFee','FBAPerOrderFulfillmentFee','FBAWeightBasedFee']);
      const giftWrapCB  = sumFee(orderFees, ['GiftwrapChargeback']);
      const shipCB      = sumFee(orderFees, ['ShippingChargeback','ShippingChargeBack']);
      const refundComm  = sumFee(orderFees, ['RefundCommission']);
      const otherOrder  = orderFees
        .filter(r => !['Commission','VariableClosingFee','FixedClosingFee','HighVolumeListingFee',
          'FBAPerUnitFulfillmentFee','FBAPerOrderFulfillmentFee','FBAWeightBasedFee',
          'GiftwrapChargeback','ShippingChargeback','ShippingChargeBack','RefundCommission']
          .includes(r.fee_type))
        .reduce((s, r) => s + (r.totalCents ?? 0), 0);

      // Service fees
      const storage30      = sumFee(serviceFees, ['FBAStorageFee','StorageFee']);
      const ltsf           = sumFee(serviceFees, ['FBALongTermStorageFee','StorageRenewalBilling']);
      const removal        = sumFee(serviceFees, ['FBARemovalFee','FBADisposalFee','RemovalComplete']);
      const inbound        = sumFee(serviceFees, ['FBAInboundTransportationFee','InboundTransportationFee',
                                                   'FBAInboundPlacementServiceFee','FBAInboundConvenienceFee']);
      const subscription   = sumFee(serviceFees, ['Subscription','SubscriptionFee']);
      const customerReturn = sumFee(serviceFees, ['FBACustomerReturnPerUnitFee']);
      const otherSvc       = serviceFees
        .filter(r => !['FBAStorageFee','StorageFee','FBALongTermStorageFee','StorageRenewalBilling',
          'FBARemovalFee','FBADisposalFee','RemovalComplete','FBAInboundTransportationFee',
          'InboundTransportationFee','FBAInboundPlacementServiceFee','FBAInboundConvenienceFee',
          'Subscription','SubscriptionFee','FBACustomerReturnPerUnitFee']
          .includes(r.fee_type))
        .reduce((s, r) => s + (r.totalCents ?? 0), 0);

      const refundNet  = cents(refundRow?.refundCents);
      const clawback   = cents(refundRow?.clawbackCents);
      const reimb      = cents(reimbRow?.total);

      const totalFees = referral + closing + fbaFulfil + giftWrapCB + shipCB
                      + storage30 + ltsf + removal + inbound + subscription
                      + customerReturn + otherOrder + otherSvc;

      // Income total mirrors IL's structure (sale + mfnShip + fbaShip + promoRebate - refund + clawback + reimb)
      const incomeTotal = sale + mfnShip + fbaShip + promoRebate
                        - refundNet + clawback + reimb;

      const netProfit = incomeTotal - cogsVal - totalFees;

      return {
        orders: revRow?.orders ?? 0,
        units:  revRow?.units  ?? 0,
        // Income line items
        sale, mfnShip, fbaShip, promoRebate,
        refundNet, clawback, reimb,
        incomeTotal,
        // Expenses
        cogsVal,
        referral, closing, fbaFulfil, giftWrapCB, shipCB, refundComm,
        otherOrderFees: otherOrder,
        storage30, ltsf, removal, inbound, subscription, customerReturn,
        otherSvcFees: otherSvc,
        totalFees,
        netProfit,
        // For zero-cogs insight
        zeroCogItems: cogsRow?.zeroCogItems ?? 0,
      };
    }

    const pnlAccrual = buildPnl(revAccrual, cogsAccrual, feesAccrual);  // Mode 1
    const pnlCash    = buildPnl(revCash,    cogsCash,    feesCash);     // Mode 2

    // ─── Reconciliation row builder ───────────────────────────────────────────
    // Only compares like-vs-like: accrual vs IL_ESTIMATED, cash vs IL_RECONCILED.
    function reconRow(
      category: string,
      ilEstKey: string | null,
      ilRecKey: string | null,
      flAccrual: number,
      flCash: number,
      notes: string,
    ) {
      const ilEst = ilEstKey ? (IL_ESTIMATED[ilEstKey] ?? null) : null;
      const ilRec = ilRecKey ? (IL_RECONCILED[ilRecKey] ?? null) : null;

      return {
        category,
        // Mode 1: Accrual vs IL Estimated
        mode1_fl:     fmt(flAccrual),
        mode1_il:     ilEst !== null ? fmt(ilEst) : 'TBD',
        mode1_delta:  ilEst !== null ? fmt(flAccrual - ilEst) : 'TBD',
        // Mode 2: Cash vs IL Reconciled
        mode2_fl:     fmt(flCash),
        mode2_il:     ilRec !== null ? fmt(ilRec) : 'TBD — needs IL Reconciled Only ON screenshot',
        mode2_delta:  ilRec !== null ? fmt(flCash - ilRec) : 'TBD',
        notes,
      };
    }

    const reconciliation = [
      reconRow('Sales (product revenue)',
        'sales', 'sales',
        pnlAccrual.sale, pnlCash.sale,
        `FL: SUM(order_items.total_price). Accrual=purchase_date (${pnlAccrual.orders} orders / ${pnlAccrual.units} units), Cash=ShipmentEvent date (${pnlCash.orders} orders / ${pnlCash.units} units).`),

      reconRow('MFN Shipping Credits',
        'mfnShippingCredit', 'mfnShippingCredit',
        pnlAccrual.mfnShip, pnlCash.mfnShip,
        'FL: SUM(order_items.shipping_charged) WHERE fulfillment_channel IN (MFN,Seller).'),

      reconRow('FBA Shipping Credits',
        'shippingCredit', 'shippingCredit',
        pnlAccrual.fbaShip, pnlCash.fbaShip,
        'FL: SUM(order_items.shipping_charged) for FBA orders. Offset by ShippingChargeback on expense side.'),

      reconRow('Promotional Rebates',
        'promotionalRebates', 'promotionalRebates',
        pnlAccrual.promoRebate, pnlCash.promoRebate,
        'FL: SUM(order_items.promotional_rebate) — stored as negative. IL shows -$245.19. FL accrual shows less deduction.'),

      reconRow('Refunds (gross amount out)',
        null, null,
        -pnlAccrual.refundNet, -pnlCash.refundNet,
        `Both bases use refunds.refund_date — same value regardless of order date basis. ${refundRow?.cnt} records. Net after clawback: ${fmt(pnlAccrual.refundNet - pnlAccrual.clawback)}. IL refunds: -$3,508.53.`),

      reconRow('Fee Clawbacks on Refunds',
        null, null,
        pnlAccrual.clawback, pnlCash.clawback,
        `Both bases: SUM(refunds.fee_clawback). ${fmt(cents(refundRow?.clawbackCents))}. IL nets clawbacks into refunds. Not a separate IL line.`),

      reconRow('Reimbursements',
        'reimbursements', 'reimbursements',
        pnlAccrual.reimb, pnlCash.reimb,
        `Both bases: reimbursements.reimbursement_date. ${reimbRow?.cnt} records, ${fmt(cents(reimbRow?.total))}. SETTLEMENT- duplicates excluded. IL: $156.90.`),

      reconRow('Amazon Referral Fee',
        'amazonReferralFee', 'amazonReferralFee',
        -pnlAccrual.referral, -pnlCash.referral,
        'FL: fee_details.fee_type = Commission, order-linked. Filtered by order date basis.'),

      reconRow('Closing Fees',
        'closingFees', 'closingFees',
        -pnlAccrual.closing, -pnlCash.closing,
        'FL: VariableClosingFee + FixedClosingFee + HighVolumeListingFee.'),

      reconRow('FBA Fulfillment Fees',
        'fbaFulfillmentFees', 'fbaFulfillmentFees',
        -pnlAccrual.fbaFulfil, -pnlCash.fbaFulfil,
        'FL: FBAPerUnitFulfillmentFee + FBAPerOrderFulfillmentFee + FBAWeightBasedFee. Accrual very close to IL.'),

      reconRow('Shipping Chargeback',
        'shippingChargeback', 'shippingChargeback',
        -pnlAccrual.shipCB, -pnlCash.shipCB,
        'FL: ShippingChargeback + ShippingChargeBack. Order-linked.'),

      reconRow('Gift Wrap Chargeback',
        'giftWrapChargeback', 'giftWrapChargeback',
        -pnlAccrual.giftWrapCB, -pnlCash.giftWrapCB,
        'FL: GiftwrapChargeback. Order-linked. Cash matches IL ($3.99). Accrual shows $0 — may be date-basis issue.'),

      reconRow('RefundCommission (fee credit)',
        'fbaTransactionFeeRefund', null,
        pnlAccrual.refundComm, pnlCash.refundComm,
        'FL: fee_details.fee_type = RefundCommission. Stored as negative (credit to seller). IL shows "FBA Transaction Fee Refund: $6.99" — FL accrual $75.57 is significantly higher. Possible mapping mismatch.'),

      reconRow('30-Day Storage Fees',
        'storageFees', 'storageFees',
        -pnlAccrual.storage30, -pnlCash.storage30,
        `FL sums BOTH StorageFee ($150.07, 1 record) AND FBAStorageFee ($700.15, 845 records). IL shows -$150.07 which matches only StorageFee. LIKELY DOUBLE-COUNT. Same value for both bases (service fee, uses posted_date directly).`),

      reconRow('Long Term Storage Fees',
        'ltsFees', 'ltsFees',
        -pnlAccrual.ltsf, -pnlCash.ltsf,
        'FL: FBALongTermStorageFee + StorageRenewalBilling. Matches IL exactly ($37.25). ✓'),

      reconRow('Removal Order Fees',
        'removalOrderFees', 'removalOrderFees',
        -pnlAccrual.removal, -pnlCash.removal,
        `FL sums FBARemovalFee ($173.95, 44 records) + RemovalComplete ($35.71, 11 records) = $209.66. IL shows -$34.87 ≈ RemovalComplete only. LIKELY DOUBLE-COUNT. FBARemovalFee may be per-unit breakdown of the same removal jobs.`),

      reconRow('FBA Inbound Fees',
        null, null,
        -pnlAccrual.inbound, -pnlCash.inbound,
        `FL: FBAInboundConvenienceFee ($958.78) + FBAInboundPlacementServiceFee ($178.15) + transport fees ($134.73) = $1,271.66. IL folds these into "FBA Inventory and Inbound Services Fees" ($298.35 total). Large discrepancy — IL may not be showing FBAInboundConvenienceFee (2024 placement fee). These are REAL fees. IL may be undercounting.`),

      reconRow('FBA Customer Return Per Unit Fee',
        null, null,
        -pnlAccrual.customerReturn, -pnlCash.customerReturn,
        'FL: FBACustomerReturnPerUnitFee = $530.10 (123 records). IL does not show this as a separate line. May be folded into IL FBA Transaction Fees or missing entirely from IL.'),

      reconRow('Subscription Fees',
        null, null,
        -pnlAccrual.subscription, -pnlCash.subscription,
        `FL: Subscription ($39.99) + SubscriptionFee ($39.99) = $79.98. POSSIBLE DOUBLE-COUNT — same Amazon Pro subscription billed twice via different event types.`),

      reconRow('Other Order Fees (uncategorized)',
        null, null,
        -pnlAccrual.otherOrderFees, -pnlCash.otherOrderFees,
        'FL: ShippingHB and other uncategorized order-linked fees.'),

      reconRow('Other Service Fees (uncategorized)',
        null, null,
        -pnlAccrual.otherSvcFees, -pnlCash.otherSvcFees,
        `FL: COMPENSATED_CLAWBACK ($106.44), MISSING_FROM_INBOUND_CLAWBACK ($53.06), Shippinglabelpurchaseforreturn ($15.45), ReCommerceGradingAndListingCharge ($9.00). These may be legitimate fees or may overlap with other categories.`),

      reconRow('COGS',
        'cogs', 'cogs',
        -pnlAccrual.cogsVal, -pnlCash.cogsVal,
        `FL accrual: ${fmt(pnlAccrual.cogsVal)} (${pnlAccrual.zeroCogItems} zero-COGS items). FL cash: ${fmt(pnlCash.cogsVal)}. IL: $22,994.55. Accrual gap: ${fmt(-pnlAccrual.cogsVal - IL_ESTIMATED.cogs)}. Zero-COGS items have revenue but no cost recorded — likely missing inventory_ledger lots.`),

      reconRow('NET PROFIT',
        'totalNetProfit', 'totalNetProfit',
        pnlAccrual.netProfit, pnlCash.netProfit,
        `FL accrual: ${fmt(pnlAccrual.netProfit)} vs IL estimated: ${fmt(IL_ESTIMATED.totalNetProfit)}. FL cash: ${fmt(pnlCash.netProfit)} vs IL reconciled: TBD.`),
    ];

    // ═══════════════════════════════════════════════════════════════════════════
    // MODE 3: DD+7 FORECAST
    // Shows shipped-but-not-yet-posted orders grouped by expected posting date.
    // Expected posting = shipped_at + 7 days (Amazon's delivery date policy window).
    // This is a CASHFLOW FORECAST, not a P&L comparison.
    // ═══════════════════════════════════════════════════════════════════════════

    // Held orders: purchased in window, shipped, no ShipmentEvent in DB yet
    const heldOrders = db.prepare(`
      SELECT
        o.order_id,
        o.purchase_date,
        o.shipped_at,
        o.status,
        o.fulfillment_channel,
        COALESCE(SUM(oi.total_price), 0) as revCents,
        COALESCE(SUM(CASE WHEN o.fulfillment_channel IN ('MFN','Seller')
          THEN COALESCE(oi.shipping_charged,0) ELSE 0 END), 0) as mfnShipCents,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogsCents,
        COALESCE(SUM(oi.quantity), 0) as units
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
        AND o.marketplace = 'amazon'
        AND o.order_id NOT IN (
          SELECT DISTINCT order_id FROM financial_events
          WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL
        )
      GROUP BY o.order_id
      ORDER BY o.shipped_at ASC
    `).all(...args) as any[];

    // Group held orders by expected post date (shipped_at + 7 days)
    // Orders with no shipped_at = still unshipped/pending — no release date known
    const byExpectedDate: Record<string, {
      orders: number; units: number;
      revCents: number; cogsCents: number; mfnShipCents: number;
    }> = {};

    let unshippedOrders = 0;
    let unshippedRev = 0;

    for (const o of heldOrders) {
      if (!o.shipped_at) {
        unshippedOrders++;
        unshippedRev += o.revCents;
        continue;
      }
      const expectedDate = addDays(o.shipped_at, 7);
      if (!byExpectedDate[expectedDate]) {
        byExpectedDate[expectedDate] = { orders: 0, units: 0, revCents: 0, cogsCents: 0, mfnShipCents: 0 };
      }
      byExpectedDate[expectedDate].orders++;
      byExpectedDate[expectedDate].units      += o.units;
      byExpectedDate[expectedDate].revCents   += o.revCents;
      byExpectedDate[expectedDate].cogsCents  += o.cogsCents;
      byExpectedDate[expectedDate].mfnShipCents += o.mfnShipCents;
    }

    // Build forecast timeline — sorted by expected release date
    const today = new Date().toISOString().split('T')[0];
    let cumulativeRev = 0;
    const forecastTimeline = Object.entries(byExpectedDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([expectedPostDate, data]) => {
        cumulativeRev += data.revCents;
        const isPast    = expectedPostDate < today;
        const daysUntil = Math.ceil((new Date(expectedPostDate).getTime() - new Date(today).getTime()) / 86_400_000);
        return {
          expectedPostDate,
          isPast,
          daysUntil,
          status: isPast ? 'OVERDUE — should have posted already' : `posts in ~${daysUntil} day${daysUntil === 1 ? '' : 's'}`,
          orders:           data.orders,
          units:            data.units,
          revCents:         fmt(data.revCents),
          mfnShipCents:     fmt(data.mfnShipCents),
          cogsCents:        fmt(data.cogsCents),
          grossRev:         fmt(data.revCents + data.mfnShipCents),
          cumulativeRev:    fmt(cumulativeRev),
        };
      });

    // Summary totals for all held orders
    const heldTotals = heldOrders.reduce(
      (acc, o) => ({
        orders:   acc.orders + 1,
        units:    acc.units + o.units,
        revCents: acc.revCents + o.revCents,
        cogsCents: acc.cogsCents + o.cogsCents,
      }),
      { orders: 0, units: 0, revCents: 0, cogsCents: 0 },
    );

    // Overdue held orders (expected to have posted by now but haven't)
    const overdueRev = Object.entries(byExpectedDate)
      .filter(([date]) => date < today)
      .reduce((s, [, d]) => s + d.revCents, 0);

    // ─── Discovery section ────────────────────────────────────────────────────
    const allFeeTypes = db.prepare(`
      SELECT fd.fee_type, fd.fee_category,
             COUNT(*) as cnt,
             SUM(fd.amount) as sum_cents,
             CASE WHEN fd.order_id IS NULL OR fd.order_id = '' THEN 'service' ELSE 'order' END as linked_to
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE fe.posted_date >= ? AND fe.posted_date < ?
        AND (fe.marketplace = 'amazon' OR fe.marketplace IS NULL)
      GROUP BY fd.fee_type, fd.fee_category, linked_to
      ORDER BY ABS(SUM(fd.amount)) DESC
    `).all(...args) as any[];

    const eventTypes = db.prepare(`
      SELECT event_type, COUNT(*) as cnt
      FROM financial_events
      WHERE posted_date >= ? AND posted_date < ?
        AND (marketplace = 'amazon' OR marketplace IS NULL)
      GROUP BY event_type ORDER BY cnt DESC
    `).all(...args) as any[];

    const ordersByStatus = db.prepare(`
      SELECT o.status, COUNT(DISTINCT o.order_id) as orders,
             SUM(oi.quantity) as units, SUM(oi.total_price) as revCents
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
        AND o.marketplace = 'amazon'
      GROUP BY o.status ORDER BY orders DESC
    `).all(...args) as any[];

    // ─── Known issues summary ─────────────────────────────────────────────────
    const knownIssues = [
      {
        id: 'REVENUE_GAP',
        severity: 'HIGH',
        category: 'Revenue',
        description: 'Sales revenue gap between FL accrual and IL estimated',
        fl_value: fmt(pnlAccrual.sale),
        il_value: fmt(IL_ESTIMATED.sales),
        delta: fmt(pnlAccrual.sale - IL_ESTIMATED.sales),
        likely_causes: [
          `FL has ${pnlAccrual.orders} orders in window vs IL's implied count. ${pnlAccrual.zeroCogItems} FL orders have zero COGS (may have partial sync).`,
          'FL order_items.total_price may differ from IL price source (Orders API vs settlement report).',
          'Some Amazon orders may not have synced to FL.',
          'Promotional rebates under-deducted: FL shows $114.53, IL shows $245.19.',
        ],
        action: 'DO NOT FIX YET. Run order sync audit: compare FL order_id list to Amazon Seller Central export for this date range.',
      },
      {
        id: 'STORAGE_DOUBLE_COUNT',
        severity: 'HIGH',
        category: 'Expenses',
        description: 'Storage fees likely double-counted: StorageFee + FBAStorageFee',
        fl_value: fmt(pnlAccrual.storage30),
        il_value: fmt(IL_ESTIMATED.storageFees),
        delta: fmt(pnlAccrual.storage30 - IL_ESTIMATED.storageFees),
        likely_causes: [
          'StorageFee (1 record, $150.07) = monthly settlement report bulk charge → matches IL exactly.',
          'FBAStorageFee (845 records, $700.15) = per-ASIN breakdown from ServiceFeeEvent — likely same charges.',
          'FL sums both. Should only count one source.',
        ],
        action: 'DO NOT FIX YET. Verify by checking if StorageFee and FBAStorageFee share the same settlement period and total amount.',
      },
      {
        id: 'REMOVAL_DOUBLE_COUNT',
        severity: 'MEDIUM',
        category: 'Expenses',
        description: 'Removal fees likely double-counted: FBARemovalFee + RemovalComplete',
        fl_value: fmt(pnlAccrual.removal),
        il_value: fmt(Math.abs(IL_ESTIMATED.removalOrderFees)),
        delta: fmt(pnlAccrual.removal - Math.abs(IL_ESTIMATED.removalOrderFees)),
        likely_causes: [
          'RemovalComplete (11 records, $35.71) ≈ matches IL $34.87.',
          'FBARemovalFee (44 records, $173.95) = per-unit charges for same removal jobs.',
          'Both may fire from different event types (RemovalShipmentEvent vs ServiceFeeEvent).',
        ],
        action: 'DO NOT FIX YET. Cross-check financial_event_id for both types — if they share the same removal job, it is a dup.',
      },
      {
        id: 'SUBSCRIPTION_DOUBLE_COUNT',
        severity: 'LOW',
        category: 'Expenses',
        description: 'Subscription fee appears twice: Subscription + SubscriptionFee',
        fl_value: fmt(pnlAccrual.subscription),
        il_value: 'Unknown (IL may fold into Other)',
        delta: 'Unknown',
        likely_causes: [
          'Subscription ($39.99) and SubscriptionFee ($39.99) both in fee_details for same month.',
          'Likely same Amazon Pro fee from two different event sources (ServiceFeeEvent + SettlementServiceFee).',
        ],
        action: 'DO NOT FIX YET. Check financial_event_id — if same financial_events row, it is a dup.',
      },
      {
        id: 'COGS_GAP',
        severity: 'HIGH',
        category: 'COGS',
        description: 'COGS significantly understated in FL vs IL',
        fl_value: fmt(pnlAccrual.cogsVal),
        il_value: fmt(Math.abs(IL_ESTIMATED.cogs)),
        delta: fmt(pnlAccrual.cogsVal - Math.abs(IL_ESTIMATED.cogs)),
        likely_causes: [
          `${pnlAccrual.zeroCogItems} order items in accrual window have cogs_per_unit = 0 or NULL.`,
          'Missing inventory_ledger lots for these SKUs — FIFO cannot assign cost.',
          'IL assigns COGS from its own inventory database; FL depends on IL CSV imports.',
          'If IL CSV import missed some lots, or FIFO ran before lots were imported, COGS will be understated.',
        ],
        action: 'DO NOT FIX YET. Identify the zero-COGS SKUs and check if corresponding lots exist in inventory_ledger.',
      },
      {
        id: 'REIMBURSEMENTS_GAP',
        severity: 'RESOLVED',
        category: 'Income',
        description: 'FL reimbursements match IL ($156.90)',
        fl_value: fmt(cents(reimbRow?.total)),
        il_value: fmt(IL_ESTIMATED.reimbursements),
        delta: fmt(cents(reimbRow?.total) - IL_ESTIMATED.reimbursements),
        likely_causes: [],
        action: 'FIXED. SETTLEMENT- duplicate rows excluded at query time in all P&L routes.',
      },
      {
        id: 'INBOUND_CONVENIENCE_FEE',
        severity: 'INFO',
        category: 'Expenses',
        description: 'FBAInboundConvenienceFee ($958.78) not visible as separate line in IL',
        fl_value: fmt(sumFee(serviceFees, ['FBAInboundConvenienceFee'])),
        il_value: 'Not shown as separate IL line (may be in IL inbound total)',
        delta: 'Cannot determine',
        likely_causes: [
          'Amazon\'s 2024 inbound placement convenience fee — sellers who send to one FC pay this.',
          'IL may fold it into "FBA Inventory and Inbound Services Fees" or show it elsewhere.',
          'This is a REAL fee. If IL is not showing it, IL may be understating total expenses.',
          'IL "FBA Inventory and Inbound Services Fees" = $298.35 seems too low given FL inbound total of $1,271.66.',
        ],
        action: 'DO NOT FIX YET. Compare with Amazon Settlement Report to confirm all inbound fee types are present and not duplicated.',
      },
    ];

    // ─── Response ─────────────────────────────────────────────────────────────
    return NextResponse.json({
      meta: {
        startDate, endDate,
        endDateNextUsed: endDateNext,
        today,
        note: 'READ-ONLY audit. Three modes: Accrual/Estimated, Cash/Reconciled, DD+7 Forecast. No writes.',
        generatedAt: new Date().toISOString(),
      },

      // ── MODE 1: Accrual / Estimated ─────────────────────────────────────────
      mode1_accrual_estimated: {
        label: 'Mode 1: Accrual / Estimated',
        fl_basis: 'revenue recognized by order purchase_date (all orders, settled or not)',
        il_basis: 'InventoryLab: Include Estimated ON, Reconciled Only OFF',
        fl: {
          orders:       pnlAccrual.orders,
          units:        pnlAccrual.units,
          sale:         fmt(pnlAccrual.sale),
          mfnShip:      fmt(pnlAccrual.mfnShip),
          fbaShip:      fmt(pnlAccrual.fbaShip),
          promoRebate:  fmt(pnlAccrual.promoRebate),
          refunds:      fmt(-pnlAccrual.refundNet),
          clawbacks:    fmt(pnlAccrual.clawback),
          reimb:        fmt(pnlAccrual.reimb),
          incomeTotal:  fmt(pnlAccrual.incomeTotal),
          cogs:         fmt(-pnlAccrual.cogsVal),
          referral:     fmt(-pnlAccrual.referral),
          closing:      fmt(-pnlAccrual.closing),
          fbaFulfil:    fmt(-pnlAccrual.fbaFulfil),
          shipCB:       fmt(-pnlAccrual.shipCB),
          giftWrapCB:   fmt(-pnlAccrual.giftWrapCB),
          storage30:    fmt(-pnlAccrual.storage30),
          ltsf:         fmt(-pnlAccrual.ltsf),
          removal:      fmt(-pnlAccrual.removal),
          inbound:      fmt(-pnlAccrual.inbound),
          customerReturn: fmt(-pnlAccrual.customerReturn),
          subscription: fmt(-pnlAccrual.subscription),
          otherFees:    fmt(-pnlAccrual.otherOrderFees - pnlAccrual.otherSvcFees),
          netProfit:    fmt(pnlAccrual.netProfit),
        },
        il: {
          sales:              fmt(IL_ESTIMATED.sales),
          refunds:            fmt(-IL_ESTIMATED.refunds),
          reimbursements:     fmt(IL_ESTIMATED.reimbursements),
          mfnShippingCredit:  fmt(IL_ESTIMATED.mfnShippingCredit),
          shippingCredit:     fmt(IL_ESTIMATED.shippingCredit),
          promotionalRebates: fmt(IL_ESTIMATED.promotionalRebates),
          promotionalRebateRefunds: fmt(IL_ESTIMATED.promotionalRebateRefunds),
          otherIncome:        fmt(IL_ESTIMATED.otherIncomeLiquidations),
          incomeTotal:        fmt(IL_ESTIMATED.incomeTotal),
          cogs:               fmt(IL_ESTIMATED.cogs),
          referralFee:        fmt(IL_ESTIMATED.amazonReferralFee),
          closingFees:        fmt(IL_ESTIMATED.closingFees),
          fbaFulfillmentFees: fmt(IL_ESTIMATED.fbaFulfillmentFees),
          shippingChargeback: fmt(IL_ESTIMATED.shippingChargeback),
          giftWrapChargeback: fmt(IL_ESTIMATED.giftWrapChargeback),
          fbaTransFeeRefund:  fmt(IL_ESTIMATED.fbaTransactionFeeRefund),
          storageFees:        fmt(IL_ESTIMATED.storageFees),
          removalFees:        fmt(IL_ESTIMATED.removalOrderFees),
          ltsFees:            fmt(IL_ESTIMATED.ltsFees),
          netProfit:          fmt(IL_ESTIMATED.totalNetProfit),
        },
        top_deltas: {
          sales_gap:        fmt(pnlAccrual.sale - IL_ESTIMATED.sales),
          cogs_gap:         fmt(-pnlAccrual.cogsVal - IL_ESTIMATED.cogs),
          storage_gap:      fmt(-pnlAccrual.storage30 - IL_ESTIMATED.storageFees),
          removal_gap:      fmt(-pnlAccrual.removal - IL_ESTIMATED.removalOrderFees),
          reimbursements_gap: fmt(pnlAccrual.reimb - IL_ESTIMATED.reimbursements),
          net_profit_gap:   fmt(pnlAccrual.netProfit - IL_ESTIMATED.totalNetProfit),
        },
      },

      // ── MODE 2: Cash / Reconciled ───────────────────────────────────────────
      mode2_cash_reconciled: {
        label: 'Mode 2: Cash / Reconciled',
        fl_basis: 'revenue recognized by ShipmentEvent posted_date (settled/reconciled orders only)',
        il_basis: 'InventoryLab: Reconciled Only ON — data NOT YET PROVIDED. All IL values show TBD.',
        note: 'Provide IL Reconciled Only ON screenshot to populate IL target values.',
        fl: {
          orders:       pnlCash.orders,
          units:        pnlCash.units,
          sale:         fmt(pnlCash.sale),
          mfnShip:      fmt(pnlCash.mfnShip),
          fbaShip:      fmt(pnlCash.fbaShip),
          promoRebate:  fmt(pnlCash.promoRebate),
          refunds:      fmt(-pnlCash.refundNet),
          clawbacks:    fmt(pnlCash.clawback),
          reimb:        fmt(pnlCash.reimb),
          incomeTotal:  fmt(pnlCash.incomeTotal),
          cogs:         fmt(-pnlCash.cogsVal),
          referral:     fmt(-pnlCash.referral),
          closing:      fmt(-pnlCash.closing),
          fbaFulfil:    fmt(-pnlCash.fbaFulfil),
          shipCB:       fmt(-pnlCash.shipCB),
          giftWrapCB:   fmt(-pnlCash.giftWrapCB),
          storage30:    fmt(-pnlCash.storage30),
          ltsf:         fmt(-pnlCash.ltsf),
          removal:      fmt(-pnlCash.removal),
          inbound:      fmt(-pnlCash.inbound),
          customerReturn: fmt(-pnlCash.customerReturn),
          subscription: fmt(-pnlCash.subscription),
          otherFees:    fmt(-pnlCash.otherOrderFees - pnlCash.otherSvcFees),
          netProfit:    fmt(pnlCash.netProfit),
        },
        il: 'TBD — provide IL Reconciled Only ON screenshot',
      },

      // ── MODE 3: DD+7 Forecast ───────────────────────────────────────────────
      mode3_dd7_forecast: {
        label: 'Mode 3: DD+7 Forecast',
        description: 'Shipped orders with no ShipmentEvent yet — earned but held. Expected release = shipped_at + 7 days. NOT a P&L — this is a cashflow forecast layer.',
        note: 'These orders ARE counted in Mode 1 (Accrual) revenue but NOT in Mode 2 (Cash). The difference between Mode 1 and Mode 2 revenue = this held pool.',
        summary: {
          held_orders:          heldTotals.orders,
          held_units:           heldTotals.units,
          held_revenue:         fmt(heldTotals.revCents),
          held_cogs:            fmt(heldTotals.cogsCents),
          unshipped_orders:     unshippedOrders,
          unshipped_revenue:    fmt(unshippedRev),
          overdue_revenue:      fmt(overdueRev),
          overdue_note:         overdueRev > 0
            ? `${fmt(overdueRev)} expected to have posted already (expected_date < today). Amazon may still be holding — check Seller Central.`
            : 'No overdue held orders.',
        },
        timeline: forecastTimeline,
        interpretation: [
          'Mode 1 (Accrual) revenue counts ALL these held orders — they exist in FL by purchase_date.',
          'Mode 2 (Cash) does NOT count them — no ShipmentEvent has posted yet.',
          'When ShipmentEvent posts, the order moves from Mode 3 → Mode 2.',
          'Accrual - Cash revenue gap is approximately this held pool.',
          'For cashflow planning: sum timeline rows for the next 7/14/30 days to see expected deposits.',
        ],
      },

      // ── RECONCILIATION TABLE (like-vs-like only) ───────────────────────────
      reconciliation: {
        label: 'Line-by-line comparison — Mode 1 column vs IL Estimated, Mode 2 column vs IL Reconciled (TBD)',
        columns: {
          mode1_fl:     'FL Accrual (purchase_date basis)',
          mode1_il:     'IL Include Estimated ON',
          mode1_delta:  'FL Accrual minus IL Estimated (negative = FL lower)',
          mode2_fl:     'FL Cash (ShipmentEvent basis)',
          mode2_il:     'IL Reconciled Only ON (TBD)',
          mode2_delta:  'FL Cash minus IL Reconciled (TBD)',
        },
        rows: reconciliation,
      },

      // ── KNOWN ISSUES ───────────────────────────────────────────────────────
      knownIssues,

      // ── DISCOVERY ─────────────────────────────────────────────────────────
      discovery: {
        eventTypesInRange: eventTypes,
        allFeeTypesInRange: allFeeTypes.map(r => ({
          ...r,
          sum_dollars: fmt(r.sum_cents ?? 0),
        })),
        ordersByStatus,
        refundBreakdown: {
          totalRefunds:    fmt(cents(refundRow?.refundCents)),
          totalClawbacks:  fmt(cents(refundRow?.clawbackCents)),
          netRefunds:      fmt(cents(refundRow?.refundCents) - cents(refundRow?.clawbackCents)),
          sellableReturns: refundRow?.sellableReturns ?? 0,
          totalCount:      refundRow?.cnt ?? 0,
          note:            'Refund/clawback date basis = refund_date — same value for both cash and accrual modes.',
        },
        reimbursementNote: `${reimbRow?.cnt ?? 0} reimbursement records, ${fmt(cents(reimbRow?.total))} total. SETTLEMENT- duplicates excluded (ADJ- rows only). Matches IL $156.90.`,
      },
    });
  } finally {
    db.close();
  }
}
