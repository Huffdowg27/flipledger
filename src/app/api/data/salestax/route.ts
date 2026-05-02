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
        state,
        SUM(tax_collected) as taxCollected,
        SUM(COALESCE(marketplace_facilitator_tax, 0)) as facilitatorTax,
        SUM(tax_collected) + SUM(COALESCE(marketplace_facilitator_tax, 0)) as total,
        COUNT(*) as orderCount
      FROM sales_tax
      WHERE posted_date >= ?
      GROUP BY state
      ORDER BY total DESC
    `).all(cutoff) as any[];

    const items = rows.map((row) => ({
      state: row.state,
      taxCollected: row.taxCollected,
      facilitatorTax: row.facilitatorTax,
      total: row.total,
      orderCount: row.orderCount,
    }));

    const totalCollected = items.reduce((s, i) => s + i.taxCollected, 0);
    const totalFacilitator = items.reduce((s, i) => s + i.facilitatorTax, 0);

    db.close();

    return NextResponse.json({
      items,
      totals: {
        stateCount: items.length,
        totalCollected,
        totalFacilitator,
        grandTotal: totalCollected + totalFacilitator,
      },
    });
  } catch (error) {
    db.close();
    console.error('Sales Tax API error:', error);
    return NextResponse.json({ error: 'Failed to load sales tax data' }, { status: 500 });
  }
}
