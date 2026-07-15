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
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

type DbRow = Record<string, unknown>;

interface IncomingPurchaseCandidate {
  id: number;
  order_ref: string | null;
  order_source: string | null;
  asin: string | null;
  sku: string | null;
  quantity: number;
  quantity_received: number;
  unit_cost_cents: number;
  ordered_at: string | null;
  status: string;
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table);
}

function attachOpenIncomingPurchases(db: Database.Database, rows: DbRow[]): DbRow[] {
  if (rows.length === 0 || !tableExists(db, 'incoming_purchases')) return rows;
  const asins = Array.from(new Set(
    rows
      .map(row => String(row.asin ?? '').trim())
      .filter(asin => asin.length > 0),
  ));
  if (asins.length === 0) return rows;
  const placeholders = asins.map(() => '?').join(',');
  const candidates = db.prepare(`
    SELECT
      id, order_ref, order_source, asin, sku, quantity, quantity_received,
      unit_cost_cents, ordered_at, status
    FROM incoming_purchases
    WHERE status IN ('on_order', 'partial')
      AND quantity > quantity_received
      AND asin IN (${placeholders})
    ORDER BY ordered_at ASC, id ASC
  `).all(...asins) as IncomingPurchaseCandidate[];
  const byAsin = new Map<string, IncomingPurchaseCandidate[]>();
  for (const candidate of candidates) {
    const key = String(candidate.asin ?? '').trim();
    if (!key) continue;
    const list = byAsin.get(key) ?? [];
    list.push(candidate);
    byAsin.set(key, list);
  }
  return rows.map(row => ({
    ...row,
    open_incoming_purchases: byAsin.get(String(row.asin ?? '').trim()) ?? [],
  }));
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
        il.quantity                                  AS lot_quantity,
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
        NULL                                         AS upc,
        (SELECT COUNT(*) FROM receiving_issues ri
          WHERE ri.inventory_ledger_id = il.id AND ri.status = 'open') AS open_issue_count
      FROM inventory_ledger il
      LEFT JOIN merchant_listings ml
        ON ml.sku = il.sku AND ml.marketplace = 'amazon'
      LEFT JOIN products p
        ON p.asin = COALESCE(ml.asin, il.asin)
      LEFT JOIN fee_estimates_cache fec
        ON fec.asin = COALESCE(ml.asin, il.asin) AND fec.marketplace LIKE '%:MFN'
      WHERE il.batch_id = ?
      ORDER BY il.created_at ASC, il.id ASC
    `).all(batchId) as DbRow[];

    return NextResponse.json({ items: attachOpenIncomingPurchases(db, rows) });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
