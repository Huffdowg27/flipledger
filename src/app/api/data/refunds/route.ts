import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { isIsoCalendarDate, parseMarketplaceFilter } from '@/lib/request-filters';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

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

  let cutoff: string;
  if (rawStartDate) {
    cutoff = rawStartDate;
  } else {
    const rawDays = searchParams.get('days') || '30';
    if (!/^\d+$/.test(rawDays) || Number(rawDays) < 1 || Number(rawDays) > 3650) {
      return NextResponse.json({ error: 'Invalid days' }, { status: 400 });
    }
    cutoff = new Date(Date.now() - Number(rawDays) * 86400000).toISOString();
  }

  const cutoffEnd = rawEndDate
    ? new Date(new Date(`${rawEndDate}T00:00:00Z`).getTime() + 86400000).toISOString().split('T')[0]
    : null;

  const marketplaceResult = parseMarketplaceFilter(searchParams.get('marketplace'));
  if (!marketplaceResult.ok) {
    return NextResponse.json({ error: 'Invalid marketplace' }, { status: 400 });
  }
  const marketplace = marketplaceResult.marketplace;

  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT
        r.refund_date as refundDate,
        r.order_id as orderId,
        r.asin,
        r.sku,
        COALESCE(p.name, p2.name, oi.asin, r.asin) as productName,
        r.quantity,
        r.refund_amount as refundAmount,
        r.reason,
        r.item_returned as itemReturned,
        COALESCE(r.fee_clawback, 0) as feeClawback,
        r.marketplace
      FROM refunds r
      LEFT JOIN products p ON r.asin = p.asin
      LEFT JOIN order_items oi ON r.order_id = oi.order_id
      LEFT JOIN products p2 ON oi.asin = p2.asin
      WHERE r.refund_date >= ?
        AND (? IS NULL OR r.refund_date < ?)
        AND (? IS NULL OR r.marketplace = ?)
      ORDER BY r.refund_date DESC
    `).all(cutoff, cutoffEnd, cutoffEnd, marketplace, marketplace) as any[];

    const items = rows.map((row) => ({
      refundDate: row.refundDate,
      orderId: row.orderId,
      asin: row.asin,
      sku: row.sku,
      productName: row.productName,
      quantity: row.quantity,
      refundAmount: row.refundAmount,
      reason: row.reason,
      itemReturned: !!row.itemReturned,
      feeClawback: row.feeClawback,
      netImpact: row.refundAmount - row.feeClawback,
      marketplace: row.marketplace || 'amazon',
    }));

    const count = items.length;
    const totalRefundAmount = items.reduce((s, i) => s + i.refundAmount, 0);
    const totalClawback = items.reduce((s, i) => s + i.feeClawback, 0);
    const totalNetImpact = items.reduce((s, i) => s + i.netImpact, 0);

    db.close();

    return NextResponse.json({
      items,
      totals: {
        count,
        totalRefundAmount,
        totalClawback,
        totalNetImpact,
      },
    });
  } catch (error) {
    db.close();
    console.error('Refunds API error:', error);
    return NextResponse.json({ error: 'Failed to load refunds data' }, { status: 500 });
  }
}
