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
  const days = parseInt(searchParams.get('days') || '30');

  const db = getDb();
  const marketplace = searchParams.get('marketplace');
  const MF = marketplace ? `AND o.marketplace = '${marketplace}'` : '';
  const MF_R = marketplace ? `AND marketplace = '${marketplace}'` : '';

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const rows = db.prepare(`
      SELECT
        date,
        income_type as incomeType,
        amount,
        description
      FROM other_income
      WHERE date >= ?
      ORDER BY date DESC
    `).all(cutoff) as any[];

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
