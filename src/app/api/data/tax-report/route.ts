import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { recognizedCogsExpr, sellableReturnJoin } from '@/lib/cogs-reversal';
import { parseMarketplaceFilter } from '@/lib/request-filters';
import { buildTaxSchedule } from '@/lib/tax-schedule';
import { HISTORY_CUTOVER } from '@/lib/accounting-cutover';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawYear = searchParams.get('year') || String(new Date().getFullYear() - 1);
  if (!/^\d{4}$/.test(rawYear)) {
    return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
  }
  const year = Number(rawYear);
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
  }

  const marketplaceResult = parseMarketplaceFilter(searchParams.get('marketplace'));
  if (!marketplaceResult.ok) {
    return NextResponse.json({ error: 'Invalid marketplace' }, { status: 400 });
  }
  const marketplace = marketplaceResult.marketplace;

  const db = getDb();
  const startDate = `${year}-01-01`;
  const endDate = `${year + 1}-01-01`;

  // Tax Report uses purchase_date (transaction date) to match the 1099-K.
  // The IRS sees the 1099-K, so our tax numbers must reconcile against it.
  // This differs from the dashboard which uses posted_date (cash basis) for operations.

  // Optional marketplace filter
  const mktFilter = marketplace ? 'AND o.marketplace = ?' : '';
  const activeOrderFilter = `AND o.status NOT IN ('Canceled', 'Cancelled')`;
  const mktParams = marketplace ? [marketplace] : [];
  const refundMktFilter = marketplace ? 'AND r.marketplace = ?' : '';
  const reimbursementMktFilter = marketplace ? 'AND rb.marketplace = ?' : '';
  const incomeMktFilter = marketplace ? 'AND inc.marketplace = ?' : '';
  const eventMktFilter = marketplace ? 'AND fe.marketplace = ?' : '';
  const taxMktFilter = marketplace ? 'AND st.marketplace = ?' : '';

  // ── Historical years (< 2026) ──────────────────────────────────────
  // Pre-cutover years come entirely from the imported Amazon Date Range
  // Transaction Reports + IL buy costs/dispositions (see profitloss route for
  // the cutover rationale: settlement-sourced fees are unreachable >90 days
  // back, so synced tables are structurally incomplete before 2026).
  // Historical data is Amazon-only; a year is all-historical or all-synced.
  if (startDate < HISTORY_CUTOVER) {
    try {
      const o = db.prepare(`
        SELECT
          COALESCE(SUM(product_sales + gift_wrap_credits), 0) AS productSales,
          COALESCE(SUM(shipping_credits), 0) AS shippingIncome,
          COUNT(DISTINCT order_id) AS orderCount,
          COALESCE(SUM(COALESCE(quantity, 0)), 0) AS unitsSold,
          COALESCE(SUM(promotional_rebates), 0) AS promoSigned,
          COALESCE(SUM(selling_fees), 0) AS sellingFees,
          COALESCE(SUM(fba_fees), 0) AS fbaFees,
          COALESCE(SUM(other_transaction_fees + other), 0) AS otherTxnFees,
          COALESCE(SUM(marketplace_withheld_tax), 0) AS withheldTax
        FROM historical_transactions
        WHERE type = 'Order' AND txn_date >= ? AND txn_date < ?
      `).get(startDate, endDate) as any;
      const grossReceipts = o.productSales + o.shippingIncome;

      const r = db.prepare(`
        SELECT
          COALESCE(SUM(-(product_sales + shipping_credits + gift_wrap_credits + promotional_rebates)), 0) AS totalRefunds,
          COALESCE(SUM(selling_fees + fba_fees + other_transaction_fees + other), 0) AS totalClawbacks,
          COUNT(*) AS refundCount
        FROM historical_transactions
        WHERE type = 'Refund' AND txn_date >= ? AND txn_date < ?
      `).get(startDate, endDate) as any;

      const byType = (types: string[], like?: string) => (db.prepare(`
        SELECT COALESCE(SUM(total), 0) AS t, COUNT(*) AS n FROM historical_transactions
        WHERE (type IN (${types.map(() => '?').join(',') || "''"})${like ? ` OR type LIKE '${like}'` : ''})
          AND txn_date >= ? AND txn_date < ?
      `).get(...types, startDate, endDate) as any);
      const reimb = byType(['Adjustment', 'SAFE-T reimbursement']);
      const serviceFees = byType(['Service Fee']);
      const fbaInventoryFees = byType(['FBA Inventory Fee', 'FBA Inventory Fee - Reversal']);
      const fbaReturnFees = byType(['FBA Customer Return Fee']);
      const shippingServices = byType(['Shipping Services']);
      const liquidations = byType([], 'Liquidations%');

      const otherIncomeUser = db.prepare(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM other_income WHERE date >= ? AND date < ?'
      ).get(startDate, endDate) as any;

      const incomeByMonth = db.prepare(`
        SELECT substr(txn_date, 1, 7) AS month,
          COALESCE(SUM(product_sales + gift_wrap_credits), 0) AS productSales,
          COALESCE(SUM(shipping_credits), 0) AS shippingIncome,
          COUNT(DISTINCT order_id) AS orderCount,
          COALESCE(SUM(COALESCE(quantity, 0)), 0) AS unitsSold
        FROM historical_transactions
        WHERE type = 'Order' AND txn_date >= ? AND txn_date < ?
        GROUP BY month ORDER BY month
      `).all(startDate, endDate) as any[];

      // COGS — disposition-adjusted, mirroring the P&L's historical model:
      // gross buy cost − restocked returns (measured rate) + write-offs.
      const RETURN_RESTOCK_RATE = 0.8915;
      const hGross = (db.prepare(
        'SELECT COALESCE(SUM(buy_cost), 0) AS t FROM historical_cogs WHERE date_posted >= ? AND date_posted < ?'
      ).get(startDate, endDate) as any).t;
      const hReversal = (db.prepare(`
        WITH unit_costs AS (
          SELECT order_id, msku, SUM(buy_cost) * 1.0 / NULLIF(SUM(quantity), 0) AS unit_cost
          FROM historical_cogs GROUP BY order_id, msku
        )
        SELECT COALESCE(SUM(COALESCE(t.quantity, 1) * COALESCE(u.unit_cost, 0)), 0) AS t
        FROM historical_transactions t
        LEFT JOIN unit_costs u ON u.order_id = t.order_id AND u.msku = t.sku
        WHERE t.type = 'Refund' AND t.txn_date >= ? AND t.txn_date < ?
      `).get(startDate, endDate) as any).t;
      const hWriteoffs = (db.prepare(`
        SELECT COALESCE(SUM(-buy_cost_adj), 0) AS t FROM historical_dispositions
        WHERE buy_cost_adj < 0 AND disp_date >= ? AND disp_date < ?
      `).get(startDate, endDate) as any).t;
      const cogsSoldTotal = Math.round(hGross - RETURN_RESTOCK_RATE * hReversal + hWriteoffs);

      // Real year-end inventory from IL valuation snapshots when available.
      const snap = db.prepare('SELECT total_value FROM historical_inventory_snapshots WHERE snapshot_date = ?');
      const beginningInventory = (snap.get(`${year - 1}-12-31`) as any)?.total_value ?? 0;
      const endingInventory = (snap.get(`${year}-12-31`) as any)?.total_value ?? 0;

      const feeSummary: Record<string, number> = {
        'Selling Fees (referral, closing, holdback)': -o.sellingFees,
        'FBA Fulfillment Fees': -o.fbaFees,
        'Other Transaction Fees': -o.otherTxnFees,
        'Service Fees (storage, subscription, inbound, ads)': -serviceFees.t,
        'FBA Inventory Fees (removal, disposal, storage)': -fbaInventoryFees.t,
        'FBA Customer Return Fees': -fbaReturnFees.t,
      };
      for (const k of Object.keys(feeSummary)) if (feeSummary[k] === 0) delete feeSummary[k];
      const totalAmazonFees = Object.values(feeSummary).reduce((s, v) => s + v, 0);
      const allFees = Object.entries(feeSummary).map(([category, total]) => ({
        category, feeType: 'Report bucket', total, count: o.orderCount,
      }));

      const promosTotal = -o.promoSigned; // stored negative; deduction is positive
      const shippingCostsTotal = -shippingServices.t;

      const otherExpenses = db.prepare(`
        SELECT category, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM expenses WHERE date >= ? AND date < ? GROUP BY category ORDER BY total DESC
      `).all(startDate, endDate) as any[];
      const totalOtherExpenses = otherExpenses.reduce((s: number, e: any) => s + e.total, 0);

      const totalTaxCollected = -o.withheldTax; // facilitator-withheld, pass-through
      const salesTaxByState = totalTaxCollected !== 0 ? [{
        state: 'All states (marketplace facilitator)', taxCollected: totalTaxCollected,
        facilitatorTax: totalTaxCollected, total: totalTaxCollected, orderCount: o.orderCount,
      }] : [];

      const refundsByMonth = db.prepare(`
        SELECT substr(txn_date, 1, 7) AS month, COUNT(*) AS count,
          COALESCE(SUM(-(product_sales + shipping_credits + gift_wrap_credits + promotional_rebates)), 0) AS totalRefunded,
          COALESCE(SUM(selling_fees + fba_fees + other_transaction_fees + other), 0) AS feeClawbacks,
          COALESCE(SUM(-(product_sales + shipping_credits + gift_wrap_credits + promotional_rebates)
            - (selling_fees + fba_fees + other_transaction_fees + other)), 0) AS netCost
        FROM historical_transactions
        WHERE type = 'Refund' AND txn_date >= ? AND txn_date < ?
        GROUP BY month ORDER BY month
      `).all(startDate, endDate) as any[];

      const inboundShipping = db.prepare(
        'SELECT COALESCE(SUM(cost), 0) AS total FROM inbound_shipments WHERE date_shipped >= ? AND date_shipped < ?'
      ).get(startDate, endDate) as any;
      const purchases = db.prepare(
        'SELECT COALESCE(SUM(buy_price * quantity), 0) AS total FROM inventory_ledger WHERE date_purchased >= ? AND date_purchased < ?'
      ).get(startDate, endDate) as any;

      const perMarketplace = [{
        marketplace: 'amazon', grossReceipts, productSales: o.productSales,
        shippingIncome: o.shippingIncome, cogs: cogsSoldTotal, fees: totalAmazonFees,
        refunds: r.totalRefunds, clawbacks: r.totalClawbacks,
        shippingCosts: shippingCostsTotal, orders: o.orderCount, units: o.unitsSold,
      }];

      const k1099_grossReceipts = o.productSales + o.shippingIncome + o.promoSigned + totalTaxCollected;

      const line1_grossReceipts = grossReceipts;
      const line2_returnsAllowances = r.totalRefunds;
      const line3_netReceipts = line1_grossReceipts - line2_returnsAllowances;
      const line4_cogs = cogsSoldTotal;
      const line5_grossProfit = line3_netReceipts - line4_cogs;
      // Clawbacks include restocking (refund-row 'other' bucket); liquidation
      // proceeds are genuine other income.
      const line6_otherIncome = reimb.t + otherIncomeUser.total + r.totalClawbacks + Math.max(liquidations.t, 0);
      const line7_grossIncome = line5_grossProfit + line6_otherIncome;
      const deductions = {
        amazonFees: totalAmazonFees,
        promotionalRebates: promosTotal,
        shippingCosts: shippingCostsTotal,
        otherExpenses: totalOtherExpenses,
        inboundShipping: inboundShipping.total,
      };
      const totalDeductions = Object.values(deductions).reduce((s, v) => s + v, 0);
      const line31_netProfit = line7_grossIncome - totalDeductions;

      db.close();
      return NextResponse.json({
        year,
        scheduleC: {
          line1_grossReceipts, line2_returnsAllowances, line3_netReceipts,
          line4_cogs, line5_grossProfit, line6_otherIncome, line7_grossIncome,
          deductions, totalDeductions, line31_netProfit,
        },
        incomeByMonth,
        cogs: {
          beginningInventory, purchases: purchases.total,
          inboundShipping: inboundShipping.total,
          costOfGoodsSold: cogsSoldTotal, endingInventory,
          calculationMethod: 'historical-fifo',
          saleCogsBeforeDispositionAdjustments: hGross,
          dispositionRestockReversal: Math.round(RETURN_RESTOCK_RATE * hReversal),
          inventoryWriteoff: hWriteoffs,
        },
        perMarketplace,
        amazonFees: allFees,
        amazonFeeSummary: Object.entries(feeSummary).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
        otherExpenses,
        salesTaxByState,
        totalTaxCollected,
        refundsByMonth,
        reimbursements: { total: reimb.t, count: reimb.n },
        promos: promosTotal,
        shippingCosts: shippingCostsTotal,
        summary: {
          totalRevenue: grossReceipts,
          totalOrders: o.orderCount,
          totalUnits: o.unitsSold,
          totalRefunds: r.totalRefunds,
          refundCount: r.refundCount,
        },
      });
    } catch (error) {
      db.close();
      console.error('Tax Report (historical) API error:', error);
      return NextResponse.json({ error: 'Failed to load tax report data' }, { status: 500 });
    }
  }

  try {
    // ═══ INCOME ═══════════════════════════════════════════════════════

    // Gross receipts (product sales + shipping credits)
    const income = db.prepare(`
      SELECT
        COALESCE(SUM(oi.total_price), 0) as productSales,
        COALESCE(SUM(COALESCE(oi.shipping_charged, 0)), 0) as shippingIncome,
        COALESCE(SUM(oi.total_price + COALESCE(oi.shipping_charged, 0)), 0) as grossReceipts,
        COUNT(DISTINCT o.order_id) as orderCount,
        COALESCE(SUM(oi.quantity), 0) as unitsSold
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter} ${activeOrderFilter}
    `).get(startDate, endDate, ...mktParams) as any;

    // Returns and allowances (refunds)
    const refundTotals = db.prepare(`
      SELECT
        COALESCE(SUM(r.refund_amount), 0) as totalRefunds,
        COALESCE(SUM(r.fee_clawback), 0) as totalClawbacks,
        COALESCE(SUM(COALESCE(r.restocking_fee, 0)), 0) as totalRestocking,
        COUNT(*) as refundCount
      FROM refunds r
      WHERE r.refund_date >= ? AND r.refund_date < ? ${refundMktFilter}
        AND (
          r.marketplace != 'walmart'
          OR EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.event_type = 'WalmartRefundEvent'
              AND fe.order_id = r.order_id
              AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
          )
        )
    `).get(startDate, endDate, ...mktParams) as any;

    // Other income (reimbursements + other_income table)
    // Exclude SETTLEMENT- rows (duplicates of ADJ- rows from settlement report re-import).
    const reimbursements = db.prepare(`
      SELECT COALESCE(SUM(rb.amount), 0) as total, COUNT(*) as count
      FROM reimbursements rb
      WHERE rb.reimbursement_date >= ? AND rb.reimbursement_date < ? ${reimbursementMktFilter}
        AND rb.reimbursement_id NOT LIKE 'SETTLEMENT-%'
    `).get(startDate, endDate, ...mktParams) as any;

    const otherIncomeData = db.prepare(`
      SELECT COALESCE(SUM(inc.amount), 0) as total
      FROM other_income inc
      WHERE inc.date >= ? AND inc.date < ? ${incomeMktFilter}
    `).get(startDate, endDate, ...mktParams) as any;

    // ═══ INCOME BY MONTH ═════════════════════════════════════════════

    const incomeByMonth = db.prepare(`
      SELECT
        strftime('%Y-%m', o.purchase_date) as month,
        COALESCE(SUM(oi.total_price), 0) as productSales,
        COALESCE(SUM(COALESCE(oi.shipping_charged, 0)), 0) as shippingIncome,
        COUNT(DISTINCT o.order_id) as orderCount,
        COALESCE(SUM(oi.quantity), 0) as unitsSold
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter} ${activeOrderFilter}
      GROUP BY strftime('%Y-%m', o.purchase_date)
      ORDER BY month
    `).all(startDate, endDate, ...mktParams) as any[];

    // ═══ COGS (FIFO) ═════════════════════════════════════════════════

    // Recognized COGS mirrors P&L: quantity-aware confirmed sellable returns
    // reverse only returned units, and amzn.gr resales carry zero second-life cost.
    const cogsSold = db.prepare(`
      SELECT COALESCE(SUM(${recognizedCogsExpr('oi')}), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      ${sellableReturnJoin('oi')}
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter} ${activeOrderFilter}
    `).get(startDate, endDate, ...mktParams) as any;

    const dispositionsActive = !marketplace || marketplace === 'amazon';
    const dispositionRestockReversal = dispositionsActive ? (db.prepare(`
      SELECT COALESCE(SUM(buy_cost_adj), 0) as total
      FROM dispositions
      WHERE buy_cost_adj > 0 AND disp_date >= ? AND disp_date < ?
    `).get(startDate, endDate) as any).total : 0;
    const inventoryWriteoff = dispositionsActive ? (db.prepare(`
      SELECT COALESCE(SUM(-buy_cost_adj), 0) as total
      FROM dispositions
      WHERE buy_cost_adj < 0 AND disp_date >= ? AND disp_date < ?
    `).get(startDate, endDate) as any).total : 0;
    const recognizedCogs = cogsSold.total - dispositionRestockReversal;

    // Purchases during the year (new inventory bought)
    const purchases = db.prepare(`
      SELECT COALESCE(SUM(buy_price * quantity), 0) as total
      FROM inventory_ledger
      WHERE date_purchased >= ? AND date_purchased < ?
    `).get(startDate, endDate) as any;

    // Inbound shipping to FBA
    const inboundShipping = db.prepare(`
      SELECT COALESCE(SUM(cost), 0) as total
      FROM inbound_shipments
      WHERE date_shipped >= ? AND date_shipped < ?
    `).get(startDate, endDate) as any;

    // Beginning / ending inventory via an opening-balance cutoff.
    //
    // The ledger holds buy lots back to 2016, but the Amazon Orders API only
    // serves ~2 years of history, so our earliest order is 2024-05-01. Any lot
    // purchased before that floor whose sale predates it was never depleted by
    // FIFO (no matching order exists), so it lingers with quantity_remaining > 0
    // and falsely inflates on-hand value (~$2.5M pre-2024, plus ~$131K in the
    // Jan–Apr 2024 gap before sales tracking began).
    //
    // We therefore set the cutoff to the sales-data floor and treat everything
    // purchased before it as a closed opening balance (excluded here), valuing
    // only the post-cutoff pool at its current remaining quantity, year-bounded
    // by purchase date. Beginning(Y) == Ending(Y-1), so the years chain. Real
    // pre-cutoff figures can be entered later from InventoryLab once available.
    const INVENTORY_CUTOFF = '2024-05-01';

    const onHandValue = db.prepare(`
      SELECT COALESCE(SUM(buy_price * quantity_remaining), 0) as total
      FROM inventory_ledger
      WHERE date_purchased >= ? AND date_purchased < ? AND quantity_remaining > 0
    `);
    const beginningInventory = onHandValue.get(INVENTORY_CUTOFF, startDate) as any;
    const endingInventory = onHandValue.get(INVENTORY_CUTOFF, endDate) as any;

    // ═══ AMAZON FEES ═════════════════════════════════════════════════

    // Order-linked fees (by order purchase date)
    const orderFees = db.prepare(`
      SELECT
        COALESCE(fd.fee_category, 'Other Fees') as category,
        fd.fee_type as feeType,
        o.marketplace,
        COALESCE(-SUM(fd.amount), 0) as total,
        COUNT(*) as count
      FROM fee_details fd
      JOIN orders o ON fd.order_id = o.order_id
      LEFT JOIN financial_events src ON fd.financial_event_id = src.id
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter} ${activeOrderFilter}
        AND NOT (src.event_type = 'RefundEvent' AND fd.amount > 0)
      GROUP BY o.marketplace, fd.fee_category, fd.fee_type
      ORDER BY fd.fee_category, total DESC
    `).all(startDate, endDate, ...mktParams) as any[];

    // Non-order service fees use the same canonical-source exclusions as P&L.
    const serviceFees = db.prepare(`
      SELECT
        COALESCE(fd.fee_category, 'Other Fees') as category,
        fd.fee_type as feeType,
        fe.marketplace,
        COALESCE(-SUM(fd.amount), 0) as total,
        COUNT(*) as count
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE (fd.order_id IS NULL OR fd.order_id = '')
        AND date(fd.posted_date) >= ?
        AND date(fd.posted_date) < ?
        ${eventMktFilter}
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
      GROUP BY fe.marketplace, fd.fee_category, fd.fee_type
      ORDER BY fd.fee_category, total DESC
    `).all(startDate, endDate, ...mktParams) as any[];

    // Combine and build hierarchy
    const allFees = [...orderFees, ...serviceFees];
    const feeSummary: Record<string, number> = {};
    for (const fee of allFees) {
      feeSummary[fee.category] = (feeSummary[fee.category] || 0) + fee.total;
    }
    const totalAmazonFees = Object.values(feeSummary).reduce((s, v) => s + v, 0);

    // Promotional rebates
    const promos = db.prepare(`
      SELECT COALESCE(-SUM(COALESCE(oi.promotional_rebate, 0)), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter} ${activeOrderFilter}
    `).get(startDate, endDate, ...mktParams) as any;

    // MFN shipping costs
    const shippingCosts = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(oi.shipping_cost, 0)), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter} ${activeOrderFilter}
    `).get(startDate, endDate, ...mktParams) as any;

    // ═══ OTHER EXPENSES ══════════════════════════════════════════════

    const otherExpenses = db.prepare(`
      SELECT
        category,
        COALESCE(SUM(amount), 0) as total,
        COUNT(*) as count
      FROM expenses
      WHERE date >= ? AND date < ?
      GROUP BY category
      ORDER BY total DESC
    `).all(startDate, endDate) as any[];

    const totalOtherExpenses = otherExpenses.reduce((s: number, e: any) => s + e.total, 0);

    // ═══ SALES TAX BY STATE ══════════════════════════════════════════

    const salesTaxByState = db.prepare(`
      SELECT
        st.state,
        COALESCE(SUM(-st.tax_collected), 0) as taxCollected,
        COALESCE(SUM(-st.marketplace_facilitator_tax), 0) as facilitatorTax,
        COALESCE(SUM(-st.tax_collected), 0) as total,
        COUNT(*) as orderCount
      FROM sales_tax st
      WHERE st.posted_date >= ? AND st.posted_date < ? ${taxMktFilter}
      GROUP BY st.state
      ORDER BY total DESC
    `).all(startDate, endDate, ...mktParams) as any[];

    const totalTaxCollected = salesTaxByState.reduce((s: number, r: any) => s + r.taxCollected, 0);

    // ═══ REFUNDS BY MONTH ════════════════════════════════════════════

    const refundsByMonth = db.prepare(`
      SELECT
        strftime('%Y-%m', r.refund_date) as month,
        COUNT(*) as count,
        COALESCE(SUM(r.refund_amount), 0) as totalRefunded,
        COALESCE(SUM(r.fee_clawback), 0) as feeClawbacks,
        COALESCE(SUM(r.refund_amount - r.fee_clawback), 0) as netCost
      FROM refunds r
      WHERE r.refund_date >= ? AND r.refund_date < ? ${refundMktFilter}
        AND (
          r.marketplace != 'walmart'
          OR EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.event_type = 'WalmartRefundEvent'
              AND fe.order_id = r.order_id
              AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
          )
        )
      GROUP BY strftime('%Y-%m', r.refund_date)
      ORDER BY month
    `).all(startDate, endDate, ...mktParams) as any[];

    // ═══ PER-MARKETPLACE BREAKDOWN ═════════════════════════════════
    const marketplaceBreakdown = db.prepare(`
      SELECT
        o.marketplace,
        COALESCE(SUM(oi.total_price), 0) as productSales,
        COALESCE(SUM(COALESCE(oi.shipping_charged, 0)), 0) as shippingIncome,
        COALESCE(SUM(oi.total_price + COALESCE(oi.shipping_charged, 0)), 0) as grossReceipts,
        COUNT(DISTINCT o.order_id) as orderCount,
        COALESCE(SUM(oi.quantity), 0) as unitsSold,
        COALESCE(SUM(${recognizedCogsExpr('oi')}), 0) as cogs
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      ${sellableReturnJoin('oi')}
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${activeOrderFilter}
      GROUP BY o.marketplace
      ORDER BY grossReceipts DESC
    `).all(startDate, endDate) as any[];

    // Fees per marketplace (order-linked)
    const feesByMarketplace = db.prepare(`
      SELECT
        o.marketplace,
        COALESCE(-SUM(fd.amount), 0) as totalFees
      FROM fee_details fd
      JOIN orders o ON fd.order_id = o.order_id
      LEFT JOIN financial_events src ON fd.financial_event_id = src.id
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${activeOrderFilter}
        AND fd.order_id IS NOT NULL AND fd.order_id != ''
        AND NOT (src.event_type = 'RefundEvent' AND fd.amount > 0)
      GROUP BY o.marketplace
    `).all(startDate, endDate) as any[];

    const feeMap: Record<string, number> = {};
    for (const f of feesByMarketplace) feeMap[f.marketplace] = f.totalFees;
    for (const f of serviceFees) {
      feeMap[f.marketplace] = (feeMap[f.marketplace] || 0) + f.total;
    }

    // Refunds per marketplace
    const refundsByMarketplace = db.prepare(`
      SELECT
        marketplace,
        COALESCE(SUM(refund_amount), 0) as totalRefunds,
        COALESCE(SUM(fee_clawback), 0) as totalClawbacks,
        COUNT(*) as refundCount
      FROM refunds r
      WHERE r.refund_date >= ? AND r.refund_date < ?
        AND (
          r.marketplace != 'walmart'
          OR EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.event_type = 'WalmartRefundEvent'
              AND fe.order_id = r.order_id
              AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
          )
        )
      GROUP BY r.marketplace
    `).all(startDate, endDate) as any[];

    const refundMap: Record<string, { refunds: number; clawbacks: number }> = {};
    for (const r of refundsByMarketplace) refundMap[r.marketplace] = { refunds: r.totalRefunds, clawbacks: r.totalClawbacks };

    // Shipping costs per marketplace
    const shippingByMarketplace = db.prepare(`
      SELECT
        o.marketplace,
        COALESCE(SUM(COALESCE(oi.shipping_cost, 0)), 0) as shippingCosts
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${activeOrderFilter}
      GROUP BY o.marketplace
    `).all(startDate, endDate) as any[];

    const shipMap: Record<string, number> = {};
    for (const s of shippingByMarketplace) shipMap[s.marketplace] = s.shippingCosts;

    const perMarketplace = marketplaceBreakdown.map((m: any) => ({
      marketplace: m.marketplace,
      grossReceipts: m.grossReceipts,
      productSales: m.productSales,
      shippingIncome: m.shippingIncome,
      cogs: m.cogs + (m.marketplace === 'amazon' ? inventoryWriteoff - dispositionRestockReversal : 0),
      fees: feeMap[m.marketplace] || 0,
      refunds: refundMap[m.marketplace]?.refunds || 0,
      clawbacks: refundMap[m.marketplace]?.clawbacks || 0,
      shippingCosts: shipMap[m.marketplace] || 0,
      orders: m.orderCount,
      units: m.unitsSold,
    }));

    const scheduleC = buildTaxSchedule({
      grossReceipts: income.grossReceipts,
      returnsAndAllowances: refundTotals.totalRefunds,
      recognizedCogs,
      inventoryWriteoff,
      reimbursements: reimbursements.total,
      otherIncome: otherIncomeData.total,
      feeClawbacks: refundTotals.totalClawbacks,
      restockingFees: refundTotals.totalRestocking,
      marketplaceFees: totalAmazonFees,
      promotionalRebates: promos.total,
      shippingCosts: shippingCosts.total,
      otherExpenses: totalOtherExpenses,
      inboundShipping: inboundShipping.total,
    });

    db.close();

    return NextResponse.json({
      year,
      scheduleC,
      incomeByMonth,
      cogs: {
        beginningInventory: beginningInventory.total,
        purchases: purchases.total,
        inboundShipping: inboundShipping.total,
        costOfGoodsSold: scheduleC.line4_cogs,
        endingInventory: endingInventory.total,
        calculationMethod: 'transaction-fifo',
        saleCogsBeforeDispositionAdjustments: cogsSold.total,
        dispositionRestockReversal,
        inventoryWriteoff,
      },
      perMarketplace,
      amazonFees: allFees,
      amazonFeeSummary: Object.entries(feeSummary).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
      otherExpenses,
      salesTaxByState,
      totalTaxCollected,
      refundsByMonth,
      reimbursements: { total: reimbursements.total, count: reimbursements.count },
      promos: promos.total,
      shippingCosts: shippingCosts.total,
      summary: {
        totalRevenue: income.grossReceipts,
        totalOrders: income.orderCount,
        totalUnits: income.unitsSold,
        totalRefunds: refundTotals.totalRefunds,
        refundCount: refundTotals.refundCount,
      },
    });
  } catch (error) {
    db.close();
    console.error('Tax Report API error:', error);
    return NextResponse.json({ error: 'Failed to load tax report data' }, { status: 500 });
  }
}
