import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get('year') || String(new Date().getFullYear() - 1));
  const marketplace = searchParams.get('marketplace'); // future: filter by marketplace

  const db = getDb();
  const startDate = `${year}-01-01`;
  const endDate = `${year + 1}-01-01`;

  // Tax Report uses purchase_date (transaction date) to match the 1099-K.
  // The IRS sees the 1099-K, so our tax numbers must reconcile against it.
  // This differs from the dashboard which uses posted_date (cash basis) for operations.

  // Optional marketplace filter
  const mktFilter = marketplace ? 'AND o.marketplace = ?' : '';
  const mktParams = marketplace ? [marketplace] : [];

  // ── Historical years (< 2026) ──────────────────────────────────────
  // Pre-cutover years come entirely from the imported Amazon Date Range
  // Transaction Reports + IL buy costs/dispositions (see profitloss route for
  // the cutover rationale: settlement-sourced fees are unreachable >90 days
  // back, so synced tables are structurally incomplete before 2026).
  // Historical data is Amazon-only; a year is all-historical or all-synced.
  if (year < 2026) {
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
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter}
    `).get(startDate, endDate, ...mktParams) as any;

    // Returns and allowances (refunds)
    const refundTotals = db.prepare(`
      SELECT
        COALESCE(SUM(refund_amount), 0) as totalRefunds,
        COALESCE(SUM(fee_clawback), 0) as totalClawbacks,
        COALESCE(SUM(COALESCE(restocking_fee, 0)), 0) as totalRestocking,
        COUNT(*) as refundCount
      FROM refunds
      WHERE refund_date >= ? AND refund_date < ?
    `).get(startDate, endDate) as any;

    // Other income (reimbursements + other_income table)
    // Exclude SETTLEMENT- rows (duplicates of ADJ- rows from settlement report re-import).
    const reimbursements = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
      FROM reimbursements
      WHERE reimbursement_date >= ? AND reimbursement_date < ?
        AND reimbursement_id NOT LIKE 'SETTLEMENT-%'
    `).get(startDate, endDate) as any;

    const otherIncomeData = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM other_income
      WHERE date >= ? AND date < ?
    `).get(startDate, endDate) as any;

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
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter}
      GROUP BY strftime('%Y-%m', o.purchase_date)
      ORDER BY month
    `).all(startDate, endDate, ...mktParams) as any[];

    // ═══ COGS (FIFO) ═════════════════════════════════════════════════

    // Cost of goods sold (from pre-calculated FIFO cogs_per_unit)
    const cogsSold = db.prepare(`
      SELECT COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter}
    `).get(startDate, endDate, ...mktParams) as any;

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
        COALESCE(SUM(ABS(fd.amount)), 0) as total,
        COUNT(*) as count
      FROM fee_details fd
      JOIN orders o ON fd.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter}
      GROUP BY fd.fee_category, fd.fee_type
      ORDER BY fd.fee_category, total DESC
    `).all(startDate, endDate, ...mktParams) as any[];

    // Service fees (by effective_date for proper month allocation)
    const serviceFees = db.prepare(`
      SELECT
        COALESCE(fee_category, 'Other Fees') as category,
        fee_type as feeType,
        COALESCE(SUM(ABS(amount)), 0) as total,
        COUNT(*) as count
      FROM fee_details
      WHERE (order_id IS NULL OR order_id = '')
        AND date(posted_date) >= ?
        AND date(posted_date) < ?
      GROUP BY fee_category, fee_type
      ORDER BY fee_category, total DESC
    `).all(startDate, endDate) as any[];

    // Combine and build hierarchy
    const allFees = [...orderFees, ...serviceFees];
    const feeSummary: Record<string, number> = {};
    for (const fee of allFees) {
      feeSummary[fee.category] = (feeSummary[fee.category] || 0) + fee.total;
    }
    const totalAmazonFees = Object.values(feeSummary).reduce((s, v) => s + v, 0);

    // Promotional rebates
    const promos = db.prepare(`
      SELECT COALESCE(SUM(ABS(COALESCE(oi.promotional_rebate, 0))), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter}
    `).get(startDate, endDate, ...mktParams) as any;

    // MFN shipping costs
    const shippingCosts = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(oi.shipping_cost, 0)), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ? ${mktFilter}
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
        state,
        COALESCE(SUM(tax_collected), 0) as taxCollected,
        COALESCE(SUM(marketplace_facilitator_tax), 0) as facilitatorTax,
        COALESCE(SUM(tax_collected), 0) as total,
        COUNT(*) as orderCount
      FROM sales_tax
      WHERE posted_date >= ? AND posted_date < ?
      GROUP BY state
      ORDER BY total DESC
    `).all(startDate, endDate) as any[];

    const totalTaxCollected = salesTaxByState.reduce((s: number, r: any) => s + r.taxCollected, 0);

    // ═══ REFUNDS BY MONTH ════════════════════════════════════════════

    const refundsByMonth = db.prepare(`
      SELECT
        strftime('%Y-%m', refund_date) as month,
        COUNT(*) as count,
        COALESCE(SUM(refund_amount), 0) as totalRefunded,
        COALESCE(SUM(fee_clawback), 0) as feeClawbacks,
        COALESCE(SUM(refund_amount - fee_clawback), 0) as netCost
      FROM refunds
      WHERE refund_date >= ? AND refund_date < ?
      GROUP BY strftime('%Y-%m', refund_date)
      ORDER BY month
    `).all(startDate, endDate) as any[];

    // ═══ PER-MARKETPLACE BREAKDOWN ═════════════════════════════════
    const marketplaceBreakdown = db.prepare(`
      SELECT
        o.marketplace,
        COALESCE(SUM(oi.total_price), 0) as productSales,
        COALESCE(SUM(COALESCE(oi.shipping_charged, 0)), 0) as shippingIncome,
        COALESCE(SUM(oi.total_price + COALESCE(oi.shipping_charged, 0)), 0) as grossReceipts,
        COUNT(DISTINCT o.order_id) as orderCount,
        COALESCE(SUM(oi.quantity), 0) as unitsSold,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogs
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
      GROUP BY o.marketplace
      ORDER BY grossReceipts DESC
    `).all(startDate, endDate) as any[];

    // Fees per marketplace (order-linked)
    const feesByMarketplace = db.prepare(`
      SELECT
        o.marketplace,
        COALESCE(SUM(ABS(fd.amount)), 0) as totalFees
      FROM fee_details fd
      JOIN orders o ON fd.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
        AND fd.order_id IS NOT NULL AND fd.order_id != ''
      GROUP BY o.marketplace
    `).all(startDate, endDate) as any[];

    const feeMap: Record<string, number> = {};
    for (const f of feesByMarketplace) feeMap[f.marketplace] = f.totalFees;

    // Refunds per marketplace
    const refundsByMarketplace = db.prepare(`
      SELECT
        marketplace,
        COALESCE(SUM(refund_amount), 0) as totalRefunds,
        COALESCE(SUM(fee_clawback), 0) as totalClawbacks,
        COUNT(*) as refundCount
      FROM refunds
      WHERE refund_date >= ? AND refund_date < ?
      GROUP BY marketplace
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
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
      GROUP BY o.marketplace
    `).all(startDate, endDate) as any[];

    const shipMap: Record<string, number> = {};
    for (const s of shippingByMarketplace) shipMap[s.marketplace] = s.shippingCosts;

    const perMarketplace = marketplaceBreakdown.map((m: any) => ({
      marketplace: m.marketplace,
      grossReceipts: m.grossReceipts,
      productSales: m.productSales,
      shippingIncome: m.shippingIncome,
      cogs: m.cogs,
      fees: feeMap[m.marketplace] || 0,
      refunds: refundMap[m.marketplace]?.refunds || 0,
      clawbacks: refundMap[m.marketplace]?.clawbacks || 0,
      shippingCosts: shipMap[m.marketplace] || 0,
      orders: m.orderCount,
      units: m.unitsSold,
    }));

    // ═══ 1099-K RECONCILIATION ═════════════════════════════════════
    // The 1099-K Box 1a = Product Sales + Shipping + Gift Wrap - Promos + Sales Tax
    // This uses transaction date to match the 1099-K
    const k1099_grossReceipts = income.productSales + income.shippingIncome + promos.total + totalTaxCollected;
    // Note: promos are already negative in the raw data, so adding them subtracts

    // ═══ SCHEDULE C CALCULATION ══════════════════════════════════════
    // Schedule C Line 1 = gross receipts WITHOUT sales tax (tax is pass-through)
    const line1_grossReceipts = income.grossReceipts;
    const line2_returnsAllowances = refundTotals.totalRefunds;
    const line3_netReceipts = line1_grossReceipts - line2_returnsAllowances;
    const line4_cogs = cogsSold.total;
    const line5_grossProfit = line3_netReceipts - line4_cogs;
    // Restocking fees: money kept by the seller on partial refunds — income.
    const line6_otherIncome = reimbursements.total + otherIncomeData.total + refundTotals.totalClawbacks + refundTotals.totalRestocking;
    const line7_grossIncome = line5_grossProfit + line6_otherIncome;

    // Deductions (Lines 8-27 on Schedule C)
    const deductions = {
      amazonFees: totalAmazonFees,
      promotionalRebates: promos.total,
      shippingCosts: shippingCosts.total,
      otherExpenses: totalOtherExpenses,
      inboundShipping: inboundShipping.total,
    };
    const totalDeductions = Object.values(deductions).reduce((s, v) => s + v, 0);

    const line31_netProfit = line7_grossIncome - totalDeductions;

    db.close();

    return NextResponse.json({
      year,
      scheduleC: {
        line1_grossReceipts,
        line2_returnsAllowances,
        line3_netReceipts,
        line4_cogs,
        line5_grossProfit,
        line6_otherIncome,
        line7_grossIncome,
        deductions,
        totalDeductions,
        line31_netProfit,
      },
      incomeByMonth,
      cogs: {
        beginningInventory: beginningInventory.total,
        purchases: purchases.total,
        inboundShipping: inboundShipping.total,
        costOfGoodsSold: cogsSold.total,
        endingInventory: endingInventory.total,
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
