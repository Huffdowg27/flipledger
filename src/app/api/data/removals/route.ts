import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { isIsoCalendarDate, parseMarketplaceFilter } from '@/lib/request-filters';

interface RemovalQueryRow {
  removalOrderId: string;
  asin: string | null;
  sku: string | null;
  productName: string;
  quantity: number;
  removalType: string;
  reason: string | null;
  status: string | null;
  dateRequested: string;
  dateCompleted: string | null;
  fee: number;
}

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const marketplaceResult = parseMarketplaceFilter(searchParams.get('marketplace'));
  if (!marketplaceResult.ok) {
    return NextResponse.json({ error: 'Invalid marketplace' }, { status: 400 });
  }
  const marketplace = marketplaceResult.marketplace;

  let cutoff: string;
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  if (
    (startDate !== null && !isIsoCalendarDate(startDate))
    || (endDate !== null && !isIsoCalendarDate(endDate))
    || (startDate !== null && endDate !== null && startDate > endDate)
  ) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  }

  if (startDate) {
    cutoff = startDate;
  } else {
    const rawDays = searchParams.get('days') || '30';
    if (!/^\d+$/.test(rawDays)) {
      return NextResponse.json({ error: 'Invalid days' }, { status: 400 });
    }
    const days = Number(rawDays);
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
      return NextResponse.json({ error: 'Invalid days' }, { status: 400 });
    }
    cutoff = new Date(Date.now() - days * 86400000).toISOString();
  }

  const cutoffEnd = endDate
    ? new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 86400000).toISOString().split('T')[0]
    : null;

  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT
        r.removal_order_id as removalOrderId,
        r.asin,
        r.sku,
        COALESCE(p.name, p2.name, r.asin, r.sku, 'Removal #' || r.removal_order_id) as productName,
        r.quantity,
        r.removal_type as removalType,
        r.reason,
        r.status,
        r.date_requested as dateRequested,
        r.date_completed as dateCompleted,
        COALESCE(r.fee, 0) as fee
      FROM removals r
      LEFT JOIN products p ON r.asin = p.asin
      LEFT JOIN products p2 ON r.sku = p2.asin
      WHERE r.date_requested >= ?
        AND (? IS NULL OR r.date_requested < ?)
        AND (? IS NULL OR r.marketplace = ?)
      ORDER BY r.date_requested DESC
    `).all(cutoff, cutoffEnd, cutoffEnd, marketplace, marketplace) as RemovalQueryRow[];

    const items = rows.map((row) => ({
      removalOrderId: row.removalOrderId,
      asin: row.asin,
      sku: row.sku,
      productName: row.productName,
      quantity: row.quantity,
      removalType: row.removalType,
      reason: row.reason,
      status: row.status,
      dateRequested: row.dateRequested,
      dateCompleted: row.dateCompleted,
      fee: row.fee,
    }));

    const totalRemovals = items.reduce((s, i) => s + i.quantity, 0);
    const totalFee = items.reduce((s, i) => s + i.fee, 0);

    db.close();

    return NextResponse.json({
      items,
      totals: {
        count: items.length,
        totalRemovals: items.length,
        totalQuantity: totalRemovals,
        totalFee,
      },
    });
  } catch (error) {
    db.close();
    console.error('Removals API error:', error);
    return NextResponse.json({ error: 'Failed to load removals data' }, { status: 500 });
  }
}
