/**
 * GET /api/dashboard/metrics
 *
 * Lightweight live counts for addable dashboard metric tiles (listing counts).
 * Period-based money metrics come from /api/data/profitloss instead.
 */
import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET() {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM merchant_listings WHERE marketplace='amazon' AND status='Active') AS mfnActive,
        (SELECT COUNT(*) FROM merchant_listings WHERE marketplace='amazon' AND status='Inactive') AS mfnInactive,
        (SELECT COUNT(*) FROM live_inventory WHERE marketplace='amazon' AND fulfillable_qty>0) AS fbaActiveSkus,
        (SELECT COALESCE(SUM(fulfillable_qty),0) FROM live_inventory WHERE marketplace='amazon') AS fbaUnits
    `).get() as any;
    return NextResponse.json(row);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
