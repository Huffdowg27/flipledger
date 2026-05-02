import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

// Shared subquery: each order's date — cash basis (posted_date) or accrual (purchase_date)
const FE_POSTED = `(SELECT order_id, MIN(posted_date) as posted_date FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id)`;
const FE_PURCHASE = `(SELECT order_id, purchase_date as posted_date FROM orders)`;

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
  const endDateNext = new Date(new Date(endDate).getTime() + 86400000).toISOString().split('T')[0];
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  const periodMs = endMs - startMs + 86400000;
  const prevStart = new Date(startMs - periodMs).toISOString().split('T')[0];

  // Marketplace filter
  const marketplace = searchParams.get('marketplace');
  const MF = marketplace ? `AND o.marketplace = '${marketplace}'` : '';
  const MF_R = marketplace ? `AND marketplace = '${marketplace}'` : '';
  const dateBasis = searchParams.get('dateBasis') || 'posted';
  const FE = dateBasis === 'purchase' ? FE_PURCHASE : FE_POSTED;

  try {
    // ─── Revenue & units ──────────────────────────────────────────────
    const salesData = db.prepare(`
      SELECT
        COALESCE(SUM(oi.total_price + CASE WHEN o.fulfillment_channel IN ('MFN', 'Seller') THEN COALESCE(oi.shipping_charged, 0) ELSE 0 END), 0) as totalRevenue,
        COUNT(DISTINCT oi.order_id) as totalOrders,
        COALESCE(SUM(oi.quantity), 0) as totalUnits,
        COALESCE(SUM(ABS(COALESCE(oi.promotional_rebate, 0))), 0) as totalPromos,
        COALESCE(SUM(COALESCE(oi.shipping_cost, 0)), 0) as totalShippingCost
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(startDate, endDateNext) as any;

    const prevSalesData = db.prepare(`
      SELECT
        COALESCE(SUM(oi.total_price + CASE WHEN o.fulfillment_channel IN ('MFN', 'Seller') THEN COALESCE(oi.shipping_charged, 0) ELSE 0 END), 0) as totalRevenue,
        COUNT(DISTINCT oi.order_id) as totalOrders,
        COALESCE(SUM(oi.quantity), 0) as totalUnits,
        COALESCE(SUM(ABS(COALESCE(oi.promotional_rebate, 0))), 0) as totalPromos,
        COALESCE(SUM(COALESCE(oi.shipping_cost, 0)), 0) as totalShippingCost
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(prevStart, startDate) as any;

    // ─── Order fees ───────────────────────────────────────────────────
    const orderFeeData = db.prepare(`
      SELECT COALESCE(-SUM(fd.amount), 0) as totalFees
      FROM fee_details fd
      JOIN ${FE} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE fd.order_id IS NOT NULL AND fd.order_id != ''
        AND fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(startDate, endDateNext) as any;

    const serviceFeeData = db.prepare(`
      SELECT COALESCE(-SUM(fd.amount), 0) as totalFees
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE (fd.order_id IS NULL OR fd.order_id = '')
        AND date(fd.posted_date) >= ? AND date(fd.posted_date) < ?
        ${marketplace ? "AND fe.marketplace = '" + marketplace + "'" : ''}
    `).get(startDate, endDateNext) as any;

    const prevOrderFeeData = db.prepare(`
      SELECT COALESCE(-SUM(fd.amount), 0) as totalFees
      FROM fee_details fd
      JOIN ${FE} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE fd.order_id IS NOT NULL AND fd.order_id != ''
        AND fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(prevStart, startDate) as any;

    const prevServiceFeeData = db.prepare(`
      SELECT COALESCE(-SUM(fd.amount), 0) as totalFees
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE (fd.order_id IS NULL OR fd.order_id = '')
        AND date(fd.posted_date) >= ? AND date(fd.posted_date) < ?
        ${marketplace ? "AND fe.marketplace = '" + marketplace + "'" : ''}
    `).get(prevStart, startDate) as any;

    // ─── COGS ─────────────────────────────────────────────────────────
    const cogsData = db.prepare(`
      SELECT COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as totalCogs
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(startDate, endDateNext) as any;

    const prevCogsData = db.prepare(`
      SELECT COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as totalCogs
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(prevStart, startDate) as any;

    // ─── Refunds ──────────────────────────────────────────────────────
    // Walmart refunds: only count those settled in recon (matches Walmart Net
    // Payable). Non-Walmart refunds: count all (Amazon refunds come pre-settled
    // through Financial Events, eBay refunds come from Fulfillment API at
    // settlement time).
    const SETTLED_FILTER = `
      AND (
        marketplace != 'walmart'
        OR EXISTS (
          SELECT 1 FROM financial_events fe
          WHERE fe.event_type = 'WalmartRefundEvent'
            AND fe.order_id = refunds.order_id
            AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
        )
      )
    `;
    const refundData = db.prepare(`
      SELECT COALESCE(SUM(refund_amount), 0) as totalRefunds,
        COALESCE(SUM(fee_clawback), 0) as totalClawbacks
      FROM refunds WHERE refund_date >= ? AND refund_date < ? ${MF_R} ${SETTLED_FILTER}
    `).get(startDate, endDateNext) as any;

    const prevRefundData = db.prepare(`
      SELECT COALESCE(SUM(refund_amount), 0) as totalRefunds,
        COALESCE(SUM(fee_clawback), 0) as totalClawbacks
      FROM refunds WHERE refund_date >= ? AND refund_date < ? ${MF_R} ${SETTLED_FILTER}
    `).get(prevStart, startDate) as any;

    // ─── Reimbursements ───────────────────────────────────────────────
    const reimbData = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM reimbursements WHERE reimbursement_date >= ? AND reimbursement_date < ? ${MF_R}
    `).get(startDate, endDateNext) as any;

    const prevReimbData = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM reimbursements WHERE reimbursement_date >= ? AND reimbursement_date < ? ${MF_R}
    `).get(prevStart, startDate) as any;

    // ─── Other expenses ───────────────────────────────────────────────
    const expenseData = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as totalExpenses
      FROM expenses WHERE date >= ? AND date < ?
    `).get(startDate, endDateNext) as any;

    // ─── Chart data (daily/weekly/monthly depending on range) ─────────
    const rangeDays = Math.ceil((new Date(endDateNext).getTime() - new Date(startDate).getTime()) / 86400000);
    // daily for ≤31 days, weekly for ≤90, monthly for longer
    const chartGrouping = rangeDays <= 31 ? 'daily' : rangeDays <= 90 ? 'weekly' : 'monthly';
    const chartGroupExpr = chartGrouping === 'daily' ? "date(fe.posted_date)"
      : chartGrouping === 'weekly' ? "date(fe.posted_date, 'weekday 0', '-6 days')"
      : "strftime('%Y-%m-01', fe.posted_date)";

    const dailyRevenue = db.prepare(`
      SELECT ${chartGroupExpr} as day, SUM(oi.total_price) as revenue,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogs
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
      GROUP BY ${chartGroupExpr} ORDER BY day
    `).all(startDate, endDateNext) as any[];

    const dailyOrderFees = db.prepare(`
      SELECT ${chartGroupExpr} as day, -SUM(fd.amount) as fees
      FROM fee_details fd
      JOIN ${FE} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE fd.order_id IS NOT NULL AND fd.order_id != ''
        AND fe.posted_date >= ? AND fe.posted_date < ? ${MF}
      GROUP BY ${chartGroupExpr}
    `).all(startDate, endDateNext) as any[];

    const feesByDay: Record<string, number> = {};
    for (const row of dailyOrderFees) feesByDay[row.day] = row.fees;

    const chartData = dailyRevenue.map((d: any) => ({
      day: d.day, revenue: d.revenue,
      profit: d.revenue - d.cogs - (feesByDay[d.day] || 0),
      grouping: chartGrouping,
    }));

    // ─── Top/Bottom products ──────────────────────────────────────────
    const topProducts = db.prepare(`
      SELECT COALESCE(p.name, p2.name, oi.asin) as name, oi.asin, COALESCE(p.category, p2.category) as category,
        SUM(oi.total_price) as revenue, SUM(oi.quantity) as unitsSold,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogs
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN products p ON oi.asin = p.asin
      LEFT JOIN products p2 ON oi.sku = p2.asin
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
      GROUP BY oi.asin
      ORDER BY (SUM(oi.total_price) - COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0)) DESC
      LIMIT 5
    `).all(startDate, endDateNext) as any[];

    const worstProducts = db.prepare(`
      SELECT COALESCE(p.name, p2.name, oi.asin) as name, oi.asin, COALESCE(p.category, p2.category) as category,
        SUM(oi.total_price) as revenue, SUM(oi.quantity) as unitsSold,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogs
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN products p ON oi.asin = p.asin
      LEFT JOIN products p2 ON oi.sku = p2.asin
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
        AND oi.cogs_per_unit > 0
      GROUP BY oi.asin
      ORDER BY (SUM(oi.total_price) - COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0)) ASC
      LIMIT 5
    `).all(startDate, endDateNext) as any[];

    // ─── Expense breakdown ────────────────────────────────────────────
    const orderFeeBreakdown = db.prepare(`
      SELECT COALESCE(fd.fee_category, 'Other') as category, -SUM(fd.amount) as total
      FROM fee_details fd
      JOIN ${FE} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE fd.order_id IS NOT NULL AND fd.order_id != ''
        AND fe.posted_date >= ? AND fe.posted_date < ? ${MF}
      GROUP BY fd.fee_category
    `).all(startDate, endDateNext) as any[];

    const serviceFeeBreakdown = db.prepare(`
      SELECT COALESCE(fd.fee_category, 'Other') as category, -SUM(fd.amount) as total
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE (fd.order_id IS NULL OR fd.order_id = '')
        AND date(fd.posted_date) >= ? AND date(fd.posted_date) < ?
        ${marketplace ? "AND fe.marketplace = '" + marketplace + "'" : ''}
      GROUP BY fd.fee_category
    `).all(startDate, endDateNext) as any[];

    const categoryMap: Record<string, number> = {};
    for (const row of [...orderFeeBreakdown, ...serviceFeeBreakdown]) {
      categoryMap[row.category] = (categoryMap[row.category] || 0) + row.total;
    }

    const expenseBreakdown = [
      { category: 'Cost of Goods Sold', total: Math.abs(cogsData.totalCogs) },
      ...Object.entries(categoryMap).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
      ...(expenseData.totalExpenses > 0 ? [{ category: 'Other Expenses', total: Math.abs(expenseData.totalExpenses) }] : []),
    ];

    // ─── Inventory value (from live_inventory — real FBA/WFS stock counts) ──
    const invValue = db.prepare(`
      SELECT
        COALESCE(SUM(li.fulfillable_qty * COALESCE(il.buy_price, 0)), 0) as totalValue,
        COALESCE(SUM(li.fulfillable_qty + li.inbound_qty), 0) as totalUnits
      FROM live_inventory li
      LEFT JOIN (
        SELECT sku, buy_price FROM inventory_ledger
        WHERE id IN (SELECT MAX(id) FROM inventory_ledger GROUP BY sku)
      ) il ON li.sku = il.sku
    `).get() as any;

    // ─── Calculate totals ─────────────────────────────────────────────
    const totalRevenue = salesData.totalRevenue;
    const totalCogs = cogsData.totalCogs;
    const allFees = orderFeeData.totalFees + serviceFeeData.totalFees;
    const promos = salesData.totalPromos;
    const shippingCost = salesData.totalShippingCost;
    const netRefunds = refundData.totalRefunds - refundData.totalClawbacks;
    const totalProfit = totalRevenue - totalCogs - allFees - shippingCost - netRefunds + reimbData.total;

    const prevRevenue = prevSalesData.totalRevenue;
    const prevCogs = prevCogsData.totalCogs;
    const prevAllFees = prevOrderFeeData.totalFees + prevServiceFeeData.totalFees;
    const prevPromos = prevSalesData.totalPromos;
    const prevShippingCost = prevSalesData.totalShippingCost;
    const prevNetRefunds = prevRefundData.totalRefunds - prevRefundData.totalClawbacks;
    const prevProfit = prevRevenue - prevCogs - prevAllFees - prevShippingCost - prevNetRefunds + prevReimbData.total;

    const roi = totalCogs > 0 ? (totalProfit / totalCogs) * 100 : 0;
    const prevRoi = prevCogs > 0 ? (prevProfit / prevCogs) * 100 : 0;

    // ─── In-flight: orders not yet recognized in P&L (regardless of dateBasis) ──
    // pending = customer placed but not shipped (Pending/Unshipped)
    // shipped = shipped but Financial Events ShipmentEvent hasn't posted yet (cash-basis lag)
    const pendingMF = marketplace ? `AND o.marketplace = '${marketplace}'` : `AND o.marketplace = 'amazon'`;
    const pendingData = db.prepare(`
      SELECT
        COUNT(DISTINCT o.order_id) as orders,
        COALESCE(SUM(oi.total_price + COALESCE(oi.shipping_charged, 0)), 0) as revenue
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.status IN ('Pending', 'Unshipped') ${pendingMF}
    `).get() as any;

    // Limit to last 14 days — older shipped-no-event orders are stuck anomalies, not actionable.
    // Amazon's Delivery Date Policy holds funds ~7-10 days from ship (≈ delivery + 7-day cushion).
    const recentCutoff = new Date(Date.now() - 14 * 86400000).toISOString();
    const shippedNotPostedData = db.prepare(`
      SELECT
        COUNT(DISTINCT o.order_id) as orders,
        COALESCE(SUM(oi.price_per_unit * oi.quantity + COALESCE(oi.shipping_charged, 0)), 0) as revenue,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogs,
        MIN(COALESCE(o.shipped_at, o.purchase_date)) as earliestShip,
        MAX(COALESCE(o.shipped_at, o.purchase_date)) as latestShip
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      LEFT JOIN ${FE_POSTED} fe ON fe.order_id = o.order_id
      WHERE o.status IN ('Shipped', 'PartiallyShipped')
        AND fe.order_id IS NULL
        AND o.purchase_date >= ?
        ${pendingMF}
    `).get(recentCutoff) as any;

    // Amazon's Delivery Date Policy: funds release ~10 days after ship (typical observed window 8-10 days)
    const DDP_DAYS = 10;
    const earliestRelease = shippedNotPostedData.earliestShip
      ? new Date(new Date(shippedNotPostedData.earliestShip).getTime() + DDP_DAYS * 86400000).toISOString()
      : null;
    const latestRelease = shippedNotPostedData.latestShip
      ? new Date(new Date(shippedNotPostedData.latestShip).getTime() + DDP_DAYS * 86400000).toISOString()
      : null;

    // Trailing 30d Amazon AOV — used to estimate pending order revenue (Amazon doesn't
    // return order_items or OrderTotal for Pending status until buyer payment clears)
    const aovCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const aovData = db.prepare(`
      SELECT
        COALESCE(SUM(oi.price_per_unit * oi.quantity + COALESCE(oi.shipping_charged, 0)), 0) AS revenue,
        COUNT(DISTINCT o.order_id) AS orders
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ?
        AND o.status IN ('Shipped', 'PartiallyShipped')
        ${pendingMF}
    `).get(aovCutoff) as any;
    const avgOrderValueCents = aovData.orders > 0 ? Math.round(aovData.revenue / aovData.orders) : 0;
    const pendingEstimateCents = pendingData.orders * avgOrderValueCents;

    // Projected profit on the shipped-not-posted cohort: revenue - cogs - estimated fees @ 13% - estimated MFN ship
    // Historical Amazon all-in fee rate is ~12.6%, round to 13% for forecast conservatism.
    const shippedNotPostedFees = Math.round(shippedNotPostedData.revenue * 0.13);
    const shippedNotPostedProfit = shippedNotPostedData.revenue - shippedNotPostedData.cogs - shippedNotPostedFees;

    db.close();

    return NextResponse.json({
      stats: {
        totalRevenue, totalProfit,
        totalUnits: salesData.totalUnits, totalOrders: salesData.totalOrders,
        totalCogs, totalFees: allFees, roi,
        serviceFees: serviceFeeData.totalFees,
        prevRevenue, prevProfit, prevUnits: prevSalesData.totalUnits, prevRoi,
      },
      inFlight: {
        pending: {
          orders: pendingData.orders,
          revenueReported: pendingData.revenue,
          revenueEstimate: pendingEstimateCents,
          avgOrderValue: avgOrderValueCents,
        },
        shippedNotPosted: {
          orders: shippedNotPostedData.orders,
          revenue: shippedNotPostedData.revenue,
          cogs: shippedNotPostedData.cogs,
          projectedProfit: shippedNotPostedProfit,
          earliestRelease,
          latestRelease,
        },
      },
      dailyRevenue: chartData,
      topProducts, worstProducts,
      expenseBreakdown,
      inventoryValue: invValue,
    });
  } catch (error) {
    db.close();
    console.error('Dashboard API error:', error);
    return NextResponse.json({ error: 'Failed to load dashboard data' }, { status: 500 });
  }
}
