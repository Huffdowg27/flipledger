import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

// Subquery to get each order's date — cash basis (posted_date) or accrual (purchase_date)
const ORDER_POSTED_DATE = `(
  SELECT order_id, MIN(posted_date) as posted_date
  FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL
  GROUP BY order_id
)`;

const ORDER_PURCHASE_DATE = `(
  SELECT order_id, purchase_date as posted_date FROM orders
)`;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const db = getDb();

  let startDate = searchParams.get('startDate');
  let endDate = searchParams.get('endDate');
  if (!startDate) {
    const days = parseInt(searchParams.get('days') || '30');
    startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  }
  if (!endDate) {
    endDate = new Date().toISOString().split('T')[0];
  }
  const marketplace = searchParams.get('marketplace');
  const MF = marketplace ? `AND o.marketplace = '${marketplace}'` : '';
  const MF_R = marketplace ? `AND marketplace = '${marketplace}'` : '';
  const dateBasis = searchParams.get('dateBasis') || 'posted';
  const summaryOnly = searchParams.get('summaryOnly') === '1';
  // 'reconciled' uses posted_date basis but requires real fee rows (financial_event_id != 0),
  // excluding estimated fees written by estimateAndBackfillFees() for unreconciled orders.
  const DATE_SUB = dateBasis === 'purchase' ? ORDER_PURCHASE_DATE : ORDER_POSTED_DATE;
  const REAL_FEES_ONLY = dateBasis === 'reconciled' ? 'AND fd.financial_event_id != 0' : '';

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
  const HISTORY_CUTOVER = '2026-01-01';
  // Historical data is Amazon-only — skip the segment when filtering to
  // another marketplace. User-entered tables (expenses, other_income) are not
  // marketplace syncs and keep the full requested range.
  const histActive = startDate < HISTORY_CUTOVER && (!marketplace || marketplace === 'amazon');
  const histEnd = endDateNext < HISTORY_CUTOVER ? endDateNext : HISTORY_CUTOVER;
  const syncedStart = startDate < HISTORY_CUTOVER ? HISTORY_CUTOVER : startDate;

  try {
    // Income (by posted_date — cash basis)
    const salesIncome = db.prepare(`
      SELECT COALESCE(SUM(oi.total_price), 0) as total
      FROM order_items oi
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(syncedStart, endDateNext) as any;

    // MFN shipping credits (income — seller charges buyer for shipping)
    const mfnShippingCredits = db.prepare(`
      SELECT COALESCE(SUM(oi.shipping_charged), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF} AND o.fulfillment_channel IN ('MFN', 'Seller')
    `).get(syncedStart, endDateNext) as any;

    // FBA/WFS shipping credits (Amazon/Walmart charges buyer, passes to seller)
    const fbaShippingCredits = db.prepare(`
      SELECT COALESCE(SUM(oi.shipping_charged), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF} AND o.fulfillment_channel NOT IN ('MFN', 'Seller')
    `).get(syncedStart, endDateNext) as any;

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
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(syncedStart, endDateNext) as any;

    const otherIncomeTotal = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM other_income WHERE date >= ? AND date < ? ${MF_R}
    `).get(startDate, endDateNext) as any;

    // COGS (FIFO) — exclude items returned as SELLABLE (unit is back in inventory;
    // COGS will be charged again when it resells, matching IL's return methodology)
    const cogsTotal = db.prepare(`
      SELECT COALESCE(SUM(
        CASE WHEN sr.order_id IS NULL THEN oi.cogs_per_unit * oi.quantity ELSE 0 END
      ), 0) as total
      FROM order_items oi
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN (
        SELECT DISTINCT order_id, COALESCE(sku,'') as sku
        FROM refunds
        WHERE disposition = 'SELLABLE' AND item_returned = 1 AND marketplace = 'amazon'
      ) sr ON oi.order_id = sr.order_id AND COALESCE(oi.sku,'') = sr.sku
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(syncedStart, endDateNext) as any;

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
        AND fe.posted_date >= ? AND fe.posted_date < ? ${MF}
        AND NOT (src.event_type = 'RefundEvent' AND fd.amount > 0)
        ${REAL_FEES_ONLY}
      GROUP BY fd.fee_category, fd.fee_type
    `).all(syncedStart, endDateNext) as any[];

    // Non-order fees (service fees like storage, inbound shipping, subscriptions)
    // These are marketplace-specific — filter by marketplace when one is selected
    const serviceFeeFilter = marketplace ? `AND fe.marketplace = '${marketplace}'` : '';
    // Exclude ServiceFeeEvent rows for fee types that also appear in SettlementServiceFee.
    // ServiceFeeEvent is re-inserted every sync day (new posted_date bypasses unique constraint),
    // creating N duplicate rows. SettlementServiceFee posts once and is canonical.
    // Safe-to-keep ServiceFeeEvent-only types: FBAInboundConvenienceFee, ReCommerceGradingAndListingCharge.
    const serviceFees = db.prepare(`
      SELECT
        COALESCE(fd.fee_category, 'Other Fees') as category,
        fd.fee_type,
        COALESCE(-SUM(fd.amount), 0) as total
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE (fd.order_id IS NULL OR fd.order_id = '')
        AND date(fd.posted_date) >= ?
        AND date(fd.posted_date) < ?
        ${serviceFeeFilter}
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
    `).all(syncedStart, endDateNext) as any[];

    const feesByCategory = [...orderFees, ...serviceFees]
      .sort((a, b) => (a.category || '').localeCompare(b.category || '') || b.total - a.total);

    // Other expenses — only include when viewing All Marketplaces (they're business-wide, not marketplace-specific)
    const expensesByCategory = marketplace ? [] : db.prepare(`
      SELECT category, COALESCE(SUM(amount), 0) as total
      FROM expenses WHERE date >= ? AND date < ?
      GROUP BY category ORDER BY total DESC
    `).all(startDate, endDateNext) as any[];

    const totalExpenses = marketplace ? { total: 0 } : db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ? AND date < ?
    `).get(startDate, endDateNext) as any;

    // Shipping costs
    const shippingCosts = db.prepare(`
      SELECT COALESCE(SUM(oi.shipping_cost), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF} AND o.fulfillment_channel = 'MFN'
    `).get(syncedStart, endDateNext) as any;

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
      WHERE r.refund_date >= ? AND r.refund_date < ? ${MF_R.replace(/marketplace/g, 'r.marketplace')}
        AND (
          r.marketplace != 'walmart'
          OR EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.event_type = 'WalmartRefundEvent'
              AND fe.order_id = r.order_id
              AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
          )
        )
    `).get(syncedStart, endDateNext) as any;

    // Reimbursements — exclude SETTLEMENT- rows (duplicates of ADJ- rows from settlement report re-import)
    const reimbTotal = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM reimbursements WHERE reimbursement_date >= ? AND reimbursement_date < ? ${MF_R}
        AND reimbursement_id NOT LIKE 'SETTLEMENT-%'
    `).get(syncedStart, endDateNext) as any;

    // Sales tax — stored as negative (Amazon reports withheld tax as a deduction);
    // negate so the P&L surfaces tax collected/remitted as a positive figure.
    const taxTotal = db.prepare(`
      SELECT COALESCE(SUM(-tax_collected), 0) as collected, COALESCE(SUM(-marketplace_facilitator_tax), 0) as facilitator
      FROM sales_tax WHERE posted_date >= ? AND posted_date < ? ${MF_R}
    `).get(syncedStart, endDateNext) as any;

    // ── Historical segment (< HISTORY_CUTOVER) ─────────────────────────
    // Settlement-truth buckets from Amazon's Date Range Transaction Reports
    // plus per-order InventoryLab buy costs. Transfer / loan / debt rows are
    // cash movements, not P&L, and are excluded.
    if (histActive) {
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
    const totalAllExpenses = cogsTotal.total + totalFees + shippingCosts.total + totalExpenses.total;
    const netProfit = totalIncome - totalAllExpenses - refundTotal.total + refundTotal.clawback + reimbTotal.total;

    const unitSummary = summaryOnly ? db.prepare(`
      SELECT
        COALESCE(SUM(oi.quantity), 0) as units,
        COUNT(DISTINCT oi.order_id) as orders
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(syncedStart, endDateNext) as any : null;

    const dailySummary = summaryOnly ? db.prepare(`
      SELECT
        substr(fe.posted_date, 1, 10) as day,
        COALESCE(SUM(oi.total_price), 0) as revenue,
        0 as profit
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
      GROUP BY substr(fe.posted_date, 1, 10)
      ORDER BY day
    `).all(syncedStart, endDateNext) as any[] : [];

    // Sales detail — individual products sold in the period, with per-order fees
    const salesDetail = summaryOnly ? [] : db.prepare(`
      SELECT
        oi.order_id,
        o.marketplace,
        o.fulfillment_channel,
        COALESCE(p.name, oi.asin) as product_name,
        oi.asin,
        oi.sku,
        oi.quantity,
        oi.total_price as revenue,
        oi.cogs_per_unit * oi.quantity as cogs,
        COALESCE(order_fees.total_fees, 0) as fees,
        oi.shipping_cost as shippingCost,
        oi.total_price - (oi.cogs_per_unit * oi.quantity) + COALESCE(order_fees.total_fees, 0) - COALESCE(oi.shipping_cost, 0) as net_profit,
        fe.posted_date,
        o.purchase_date
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      LEFT JOIN products p ON p.asin IN (oi.asin, oi.sku)
      LEFT JOIN (
        SELECT order_id, SUM(amount) as total_fees
        FROM fee_details
        WHERE order_id IS NOT NULL AND order_id != ''
        GROUP BY order_id
      ) order_fees ON oi.order_id = order_fees.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
      ORDER BY fe.posted_date DESC
      LIMIT 500
    `).all(syncedStart, endDateNext) as any[];

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
      WHERE r.refund_date >= ? AND r.refund_date < ? ${marketplace ? `AND r.marketplace = '${marketplace}'` : ''}
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
    `).all(syncedStart, endDateNext) as any[];

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
        feeHierarchy,
        shippingCosts: shippingCosts.total,
        otherExpenses: totalExpenses.total,
        otherExpensesByCategory: expensesByCategory,
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
      dateBasis,
      unitSummary,
      dailySummary,
      salesDetail,
      refundDetail,
    });
  } catch (error) {
    db.close();
    console.error('P&L API error:', error);
    return NextResponse.json({ error: 'Failed to load P&L data' }, { status: 500 });
  }
}
