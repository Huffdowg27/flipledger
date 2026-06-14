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
    // Merchant-listing buckets mirror /analyze/merchant-inventory exactly:
    //   live  = status not Inactive/Incomplete AND quantity > 0  (buyable now)
    //   oos   = status active but quantity = 0
    //   inactive = Inactive/Incomplete
    //   notListed = local LV_ lots with stock and no Amazon listing yet
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM merchant_listings
           WHERE marketplace='amazon' AND status NOT IN ('Inactive','Incomplete') AND COALESCE(quantity,0) > 0) AS mfnLive,
        (SELECT COUNT(*) FROM merchant_listings
           WHERE marketplace='amazon' AND status NOT IN ('Inactive','Incomplete') AND COALESCE(quantity,0) = 0) AS mfnOos,
        (SELECT COUNT(*) FROM merchant_listings
           WHERE marketplace='amazon' AND status IN ('Inactive','Incomplete')) AS mfnInactive,
        (SELECT COUNT(*) FROM inventory_ledger il
           WHERE (il.sku LIKE 'LV_%' OR il.sku LIKE 'MF_LV_%') AND il.quantity_remaining > 0
             AND NOT EXISTS (SELECT 1 FROM merchant_listings ml WHERE ml.sku = il.sku AND ml.marketplace='amazon')) AS mfnNotListed,
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
