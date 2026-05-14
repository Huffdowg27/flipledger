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
//
// Primary source: merchant_listings (Amazon Seller Central via GET_FLAT_FILE_OPEN_LISTINGS_DATA).
// Filtered to LV_/MF_LV_ SKUs — the user's MFN SKU namespace.
// inventory_ledger is LEFT JOINed in to enrich with cost, bin, receive status.
//
// Returns:
//   listed    — Amazon MFN listings (matched + live_only)
//   localOnly — LV_ inventory lots with no Amazon listing (not yet activated)
//   lastSynced
export async function GET() {
  const db = getDb();
  try {
    // Amazon MFN listings for LV_ SKUs, enriched with local lot data.
    const listed = db.prepare(`
      SELECT
        'ml:' || ml.id                    AS row_key,
        CASE WHEN il.id IS NOT NULL THEN 'matched' ELSE 'live_only' END AS row_source,
        ml.id                             AS ml_id,
        ml.asin,
        ml.sku,
        ml.quantity                       AS amazon_qty,
        ml.status                         AS amazon_status,
        ml.list_price_cents               AS amazon_list_price_cents,
        ml.last_synced,
        CASE
          WHEN ml.status IN ('Inactive', 'Incomplete') THEN 'inactive'
          WHEN COALESCE(ml.quantity, 0) = 0            THEN 'oos'
          ELSE                                               'active'
        END                               AS live_state,
        il.id                             AS il_id,
        il.quantity,
        il.quantity_remaining,
        il.buy_price,
        il.date_purchased,
        il.bin_location,
        il.condition,
        il.quantity_received,
        il.received_at,
        il.inspected_at,
        il.receive_notes,
        il.list_price_cents               AS il_list_price_cents,
        COALESCE(p.name, ml.product_name) AS product_name,
        p.image_url,
        p.category,
        lbi.fnsku,
        s.name                            AS supplier_name
      FROM merchant_listings ml
      LEFT JOIN inventory_ledger il
        ON il.sku = ml.sku
        AND (il.sku LIKE 'LV_%' OR il.sku LIKE 'MF_LV_%')
        AND il.quantity_remaining > 0
      LEFT JOIN products p ON p.asin = ml.asin
      LEFT JOIN suppliers s ON s.id = il.supplier_id
      LEFT JOIN (
        SELECT sku, fnsku FROM listing_batch_items
        WHERE fnsku IS NOT NULL
        GROUP BY sku
      ) lbi ON lbi.sku = ml.sku
      WHERE ml.marketplace = 'amazon'
        AND (ml.sku LIKE 'LV_%' OR ml.sku LIKE 'MF_LV_%')
      ORDER BY
        CASE live_state
          WHEN 'active'   THEN 1
          WHEN 'oos'      THEN 2
          WHEN 'inactive' THEN 3
          ELSE                 4
        END,
        COALESCE(p.name, ml.product_name) ASC
    `).all();

    // Local LV_ lots that have no matching Amazon listing — not yet activated.
    const localOnly = db.prepare(`
      SELECT
        'il:' || il.id               AS row_key,
        'local_only'                 AS row_source,
        NULL                         AS ml_id,
        il.asin,
        il.sku,
        NULL                         AS amazon_qty,
        NULL                         AS amazon_status,
        NULL                         AS amazon_list_price_cents,
        NULL                         AS last_synced,
        'not_listed'                 AS live_state,
        il.id                        AS il_id,
        il.quantity,
        il.quantity_remaining,
        il.buy_price,
        il.date_purchased,
        il.bin_location,
        il.condition,
        il.quantity_received,
        il.received_at,
        il.inspected_at,
        il.receive_notes,
        il.list_price_cents          AS il_list_price_cents,
        COALESCE(p.name, il.sku)     AS product_name,
        p.image_url,
        p.category,
        lbi.fnsku,
        s.name                       AS supplier_name
      FROM inventory_ledger il
      LEFT JOIN merchant_listings ml
        ON ml.sku = il.sku AND ml.marketplace = 'amazon'
      LEFT JOIN products p ON p.asin = il.asin
      LEFT JOIN suppliers s ON s.id = il.supplier_id
      LEFT JOIN (
        SELECT sku, fnsku FROM listing_batch_items
        WHERE fnsku IS NOT NULL
        GROUP BY sku
      ) lbi ON lbi.sku = il.sku
      WHERE (il.sku LIKE 'LV_%' OR il.sku LIKE 'MF_LV_%')
        AND il.quantity_remaining > 0
        AND ml.id IS NULL
      ORDER BY
        CASE WHEN il.bin_location IS NULL OR il.bin_location = '' THEN 1 ELSE 0 END,
        il.bin_location ASC,
        il.date_purchased DESC
    `).all();

    const syncRow = db.prepare(
      `SELECT value FROM settings WHERE key = 'merchant_listings_last_sync'`
    ).get() as { value: string } | undefined;

    return NextResponse.json({
      listed,
      localOnly,
      lastSynced: syncRow?.value ?? null,
    });
  } catch (error) {
    console.error('Merchant inventory error:', error);
    return NextResponse.json({ error: 'Failed to load inventory' }, { status: 500 });
  } finally {
    db.close();
  }
}
