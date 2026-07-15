import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { isIsoCalendarDate, parseMarketplaceFilter } from '@/lib/request-filters';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  if (
    (startDate !== null && !isIsoCalendarDate(startDate))
    || (endDate !== null && !isIsoCalendarDate(endDate))
    || (startDate !== null && endDate !== null && startDate > endDate)
  ) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  }
  const rawDays = searchParams.get('days') || '30';
  if (!startDate && (!/^\d+$/.test(rawDays) || Number(rawDays) < 1 || Number(rawDays) > 3650)) {
    return NextResponse.json({ error: 'Invalid days' }, { status: 400 });
  }
  const cutoff = startDate || new Date(Date.now() - Number(rawDays) * 86400000).toISOString();
  const cutoffEnd = endDate
    ? new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 86400000).toISOString().split('T')[0]
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
        date,
        income_type as incomeType,
        amount,
        description
      FROM other_income
      WHERE date >= ?
        AND (? IS NULL OR date < ?)
        AND (? IS NULL OR marketplace = ?)
      ORDER BY date DESC
    `).all(cutoff, cutoffEnd, cutoffEnd, marketplace, marketplace) as any[];

    const items = rows.map((row) => ({
      date: row.date,
      incomeType: row.incomeType,
      amount: row.amount,
      description: row.description,
    }));

    const totalIncome = items.reduce((s, i) => s + i.amount, 0);

    db.close();

    return NextResponse.json({
      items,
      totals: {
        count: items.length,
        totalIncome,
      },
    });
  } catch (error) {
    db.close();
    console.error('Other Income API error:', error);
    return NextResponse.json({ error: 'Failed to load other income data' }, { status: 500 });
  }
}
