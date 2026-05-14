import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

// GET /api/data/merchant-inventory
// Returns all LV_/MF_LV_ inventory_ledger lots with qty_remaining > 0,
// LEFT JOINed to merchant_listings for live Seller Central status.
// Also returns live-only listings (Seller Central entries with no local lot)
// and the last sync timestamp.
export async function GET() {
  const db = getDb();
  try {
    // Primary set: local lots with live listing data overlaid.
    const items = db.prepare(`
      SELECT
        il.id,
        il.asin,
        il.sku,
        il.quantity,
        il.quantity_remaining,
        il.buy_price,
        il.date_purchased,
        il.bin_location,
        il.condition,
        il.notes,
        il.quantity_received,
        il.received_at,
        il.inspected_at,
        il.receive_notes,
        il.list_price_cents,
        s.name     AS supplier_name,
        p.name     AS product_name,
        p.image_url,
        p.category,
        lbi.fnsku,
        ml.status  AS live_status,
        ml.quantity AS live_quantity,
        ml.last_synced AS live_last_synced,
        ml.list_price_cents AS live_list_price_cents,
        CASE
          WHEN ml.sku IS NULL                                     THEN 'not_listed'
          WHEN ml.status IN ('Inactive', 'Incomplete')            THEN 'inactive'
          WHEN COALESCE(ml.quantity, 0) = 0                       THEN 'oos'
          ELSE                                                         'active'
        END AS live_state
      FROM inventory_ledger il
      LEFT JOIN suppliers s ON s.id = il.supplier_id
      LEFT JOIN products p ON p.asin = il.asin
      LEFT JOIN (
        SELECT sku, fnsku FROM listing_batch_items
        WHERE fnsku IS NOT NULL
        GROUP BY sku
      ) lbi ON lbi.sku = il.sku
      LEFT JOIN merchant_listings ml
        ON ml.sku = il.sku AND ml.marketplace = 'amazon'
      WHERE il.quantity_remaining > 0
        AND (il.sku LIKE 'LV_%' OR il.sku LIKE 'MF_LV_%')
      ORDER BY
        CASE WHEN il.bin_location IS NULL OR il.bin_location = '' THEN 1 ELSE 0 END,
        il.bin_location ASC,
        il.date_purchased DESC
    `).all();

    // Live-only: Seller Central listings that have NO matching local lot.
    // Useful for auditing orphan listings created outside FlipLedger.
    const liveOnly = db.prepare(`
      SELECT ml.*
      FROM merchant_listings ml
      LEFT JOIN inventory_ledger il
        ON il.sku = ml.sku
        AND (il.sku LIKE 'LV_%' OR il.sku LIKE 'MF_LV_%')
        AND il.quantity_remaining > 0
      WHERE ml.marketplace = 'amazon'
        AND il.id IS NULL
      ORDER BY ml.status, ml.sku
    `).all();

    // Last sync time from settings.
    const syncRow = db.prepare(
      `SELECT value FROM settings WHERE key = 'merchant_listings_last_sync'`
    ).get() as { value: string } | undefined;

    return NextResponse.json({
      items,
      liveOnly,
      lastSynced: syncRow?.value ?? null,
    });
  } catch (error) {
    console.error('Merchant inventory error:', error);
    return NextResponse.json({ error: 'Failed to load inventory' }, { status: 500 });
  } finally {
    db.close();
  }
}
