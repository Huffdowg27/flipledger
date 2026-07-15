import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { calculateProfit, calculateROI, calculateMargin, calculateShippingProfit } from '@/lib/calculations';
import { isIsoCalendarDate, parseMarketplaceFilter } from '@/lib/request-filters';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

const ORDER_POSTED = `(SELECT order_id, MIN(posted_date) as posted_date FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id)`;

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
    if (!/^\d+$/.test(rawDays) || Number(rawDays) < 1 || Number(rawDays) > 3650) {
      return NextResponse.json({ error: 'Invalid days' }, { status: 400 });
    }
    const days = Number(rawDays);
    startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  }
  const endDate = rawEndDate || new Date().toISOString().split('T')[0];
  const marketplaceResult = parseMarketplaceFilter(searchParams.get('marketplace'));
  if (!marketplaceResult.ok) {
    return NextResponse.json({ error: 'Invalid marketplace' }, { status: 400 });
  }
  const marketplace = marketplaceResult.marketplace;
  const openOnly = searchParams.get('openOnly') === '1';
  const marketplaceClause = marketplace ? 'AND o.marketplace = ?' : '';

  const endDateNext = new Date(new Date(endDate).getTime() + 86400000).toISOString().split('T')[0];
  const db = getDb();

  try {
    const openOrderFilter = openOnly
      ? `AND o.status IN ('Unshipped', 'PartiallyShipped')`
      : `AND o.purchase_date >= ? AND o.purchase_date < ?`;

    // Merchant Sales — date range filtered by purchase_date (sold date), with
    // ShipmentEvent left-joined so recent MFN/Seller orders can appear as
    // Estimated before Amazon posts final financial events. Reconciled row math
    // keeps the existing fee/COGS lookups intact; this route does not affect
    // P&L/accounting calculations.
    const query = db.prepare(`
      SELECT
        o.purchase_date as soldDate,
        fe.posted_date as postedDate,
        o.order_id as orderId,
        o.status as orderStatus,
        oi.asin,
        oi.sku,
        COALESCE(p.name, p2.name, oi.asin) as productName,
        oi.quantity,
        oi.total_price as salePrice,
        COALESCE(oi.shipping_charged, 0) as shippingCharged,
        COALESCE(oi.shipping_cost, 0) as shippingCost,
        COALESCE(oi.cogs_per_unit, 0) as buyCostPerUnit,
        CASE WHEN ot.order_total > 0
          THEN CAST(COALESCE(fd.totalFees, 0) * oi.total_price * 1.0 / ot.order_total AS INTEGER)
          ELSE COALESCE(fd.totalFees, 0)
        END as fees,
        CASE WHEN fe.posted_date IS NOT NULL THEN 'reconciled' ELSE 'estimated' END as status,
        o.is_estimated as isEstimated,
        o.marketplace
      FROM orders o
      JOIN order_items oi ON o.order_id = oi.order_id
      LEFT JOIN ${ORDER_POSTED} fe ON o.order_id = fe.order_id
      LEFT JOIN products p ON oi.asin = p.asin
      LEFT JOIN products p2 ON oi.sku = p2.asin AND p.asin IS NULL
      LEFT JOIN (
        SELECT order_id, -SUM(amount) as totalFees FROM fee_details WHERE order_id IS NOT NULL AND order_id != '' AND amount < 0 GROUP BY order_id
      ) fd ON o.order_id = fd.order_id
      LEFT JOIN (
        SELECT order_id, SUM(total_price) as order_total FROM order_items GROUP BY order_id
      ) ot ON o.order_id = ot.order_id
      WHERE o.fulfillment_channel IN ('MFN', 'Seller')
        AND o.marketplace != 'ebay'
        ${openOrderFilter} ${marketplaceClause}
      ORDER BY o.purchase_date DESC
    `);

    const rows = (openOnly
      ? query.all(...(marketplace ? [marketplace] : []))
      : query.all(...(marketplace ? [startDate, endDateNext, marketplace] : [startDate, endDateNext]))) as any[];

    const items = rows.map((row) => {
      const buyCost = row.buyCostPerUnit * row.quantity;
      const shippingProfit = calculateShippingProfit(row.shippingCharged, row.shippingCost);
      const profit = calculateProfit(row.salePrice, buyCost, row.fees) + shippingProfit;
      const profitPercent = calculateMargin(profit, row.salePrice);
      const roiPercent = calculateROI(profit, buyCost);
      const isReconciled = row.status === 'reconciled';
      return {
        soldDate: row.soldDate,
        date: row.soldDate,
        postedDate: row.postedDate,
        status: row.status as 'reconciled' | 'estimated',
        orderStatus: row.orderStatus,
        orderId: row.orderId,
        asin: row.asin,
        sku: row.sku,
        productName: row.productName,
        quantity: row.quantity,
        salePrice: row.salePrice,
        shippingCharged: row.shippingCharged,
        shippingCost: row.shippingCost,
        shippingProfit,
        buyCost,
        fees: row.fees,
        profit,
        profitPercent,
        roiPercent,
        isEstimated: !isReconciled,
        marketplace: row.marketplace,
      };
    });

    const totalSales = items.reduce((s, i) => s + i.salePrice, 0);
    const totalFees = items.reduce((s, i) => s + i.fees, 0);
    const totalProfit = items.reduce((s, i) => s + i.profit, 0);
    const totalShippingCharged = items.reduce((s, i) => s + i.shippingCharged, 0);
    const totalShippingCost = items.reduce((s, i) => s + i.shippingCost, 0);
    const count = items.length;

    db.close();

    return NextResponse.json({
      items,
      totals: {
        count,
        totalSales,
        totalFees,
        totalProfit,
        totalShippingCharged,
        totalShippingCost,
        totalShippingProfit: totalShippingCharged - totalShippingCost,
      },
      averages: {
        avgOrderPrice: count > 0 ? totalSales / count : 0,
        avgFees: count > 0 ? totalFees / count : 0,
        avgProfit: count > 0 ? totalProfit / count : 0,
      },
    });
  } catch (error) {
    db.close();
    console.error('Merchant Sales API error:', error);
    return NextResponse.json({ error: 'Failed to load merchant sales data' }, { status: 500 });
  }
}
