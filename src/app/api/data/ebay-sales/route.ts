import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

const ORDER_POSTED = `(SELECT order_id, MIN(posted_date) as posted_date FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id)`;

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

  const endDateNext = new Date(new Date(endDate).getTime() + 86400000).toISOString().split('T')[0];

  try {
    const rows = db.prepare(`
      SELECT
        fe.posted_date as date,
        o.order_id as orderId,
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
        o.is_estimated as isEstimated,
        o.marketplace
      FROM orders o
      JOIN order_items oi ON o.order_id = oi.order_id
      JOIN ${ORDER_POSTED} fe ON o.order_id = fe.order_id
      LEFT JOIN products p ON oi.asin = p.asin
      LEFT JOIN products p2 ON oi.sku = p2.asin AND p.asin IS NULL
      LEFT JOIN (
        SELECT order_id, -SUM(amount) as totalFees FROM fee_details WHERE order_id IS NOT NULL AND order_id != '' AND amount < 0 GROUP BY order_id
      ) fd ON o.order_id = fd.order_id
      LEFT JOIN (
        SELECT order_id, SUM(total_price) as order_total FROM order_items GROUP BY order_id
      ) ot ON o.order_id = ot.order_id
      WHERE o.marketplace = 'ebay'
        AND fe.posted_date >= ? AND fe.posted_date < ?
      ORDER BY fe.posted_date DESC
    `).all(startDate, endDateNext) as any[];

    const items = rows.map((row) => {
      const buyCost = row.buyCostPerUnit * row.quantity;
      const shippingProfit = row.shippingCharged - row.shippingCost;
      const profit = row.salePrice - buyCost - row.fees + shippingProfit;
      const profitPercent = row.salePrice > 0 ? (profit / row.salePrice) * 100 : 0;
      const roiPercent = buyCost > 0 ? (profit / buyCost) * 100 : 0;
      return {
        date: row.date,
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
        isEstimated: !!row.isEstimated,
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
