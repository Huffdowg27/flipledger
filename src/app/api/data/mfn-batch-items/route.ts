/**
 * MFN batch hydration endpoint.
 *
 * GET /api/data/mfn-batch-items?batchId=N
 *   -> { items: SearchResult[] }
 *
 * Returns every inventory_ledger lot tagged with batch_id = N, joined with
 * merchant_listings (live Amazon status/qty/price), products (image/name),
 * and fee_estimates_cache. The shape matches /api/data/mfn-search results so
 * MfnBatchReceiveWorkflow can pass each row straight through makeBatchItem
 * and seed the tray as saved items.
 *
 * Read-only. No writes. No FIFO. No SP-API calls.
 */
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
  const raw = request.nextUrl.searchParams.get('batchId');
  const batchId = raw != null && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(batchId) || batchId <= 0) {
    return NextResponse.json({ error: 'batchId (positive integer) is required' }, { status: 400 });
  }

  const db = getDb();
  try {
    // Lead from inventory_ledger so MFN batches with lots that have no matching
    // merchant_listings row still come back (e.g. local-only lots created before
    // the listing synced). Mirror /api/data/mfn-search's SELECT shape.
    const rows = db.prepare(`
      SELECT
        ml.id                                        AS ml_id,
        il.sku                                       AS sku,
        COALESCE(ml.asin, il.asin)                   AS asin,
        ml.quantity                                  AS amazon_qty,
        ml.status                                    AS amazon_status,
        ml.fulfillment_channel                       AS fulfillment_channel,
        ml.list_price_cents                          AS amazon_list_price_cents,
        ml.last_synced                               AS last_synced,
        COALESCE(p.name, ml.item_name)               AS product_name,
        p.image_url                                  AS image_url,
        il.id                                        AS il_id,
        il.buy_price                                 AS buy_price,
        il.list_price_cents                          AS il_list_price_cents,
        il.bin_location                              AS bin_location,
        il.condition                                 AS condition,
        il.quantity_received                         AS quantity_received,
        il.quantity_remaining                        AS quantity_remaining,
        il.received_at                               AS received_at,
        il.inspected_at                              AS inspected_at,
        il.merchant_shipping_group_name              AS merchant_shipping_group_name,
        fec.fee_cents                                AS fee_cents,
        fec.referral_fee_cents                       AS referral_fee_cents,
        fec.list_price_cents                         AS fee_list_price_cents,
        NULL                                         AS parsed_cost_cents,
        NULL                                         AS parsed_list_price_cents,
        NULL                                         AS parsed_order_qty,
        'unparsed'                                   AS sku_parse_status,
        NULL                                         AS upc
      FROM inventory_ledger il
      LEFT JOIN merchant_listings ml
        ON ml.sku = il.sku AND ml.marketplace = 'amazon'
      LEFT JOIN products p
        ON p.asin = COALESCE(ml.asin, il.asin)
      LEFT JOIN fee_estimates_cache fec
        ON fec.asin = COALESCE(ml.asin, il.asin) AND fec.marketplace LIKE '%:MFN'
      WHERE il.batch_id = ?
      ORDER BY il.created_at ASC, il.id ASC
    `).all(batchId);

    return NextResponse.json({ items: rows });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
