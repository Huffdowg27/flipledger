import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { fetchCatalogByAsin, isBarcode, searchCatalog } from '@/lib/sp-api/catalog';
import { getFeesEstimate } from '@/lib/sp-api/feesEstimate';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb(readonly = true) {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly });
  db.pragma('journal_mode = WAL');
  return db;
}

function getCredentials(): SPAPICredentials | null {
  const db = getDb();
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const s: Record<string, string> = {};
    for (const r of rows) s[r.key] = r.value;
    if (!s.clientId || !s.clientSecret || !s.refreshToken) return null;
    return {
      clientId:      s.clientId,
      clientSecret:  s.clientSecret,
      refreshToken:  s.refreshToken,
      marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
    };
  } finally {
    db.close();
  }
}

// MSKU parser — identical logic to merchant-inventory route.
// Format: {LV|MF_LV}_{SUPPLIER}_{DATE}_{COST}_{LIST}_{QTY}_{B|P?}_{SEQ}
// Parsed right-to-left so 6-digit and 8-digit DATE variants are handled uniformly.
interface SkuParsed {
  parsed_cost_cents: number | null;
  parsed_list_price_cents: number | null;
  parsed_order_qty: number | null;
  parsed_date: string | null;
  sku_parse_status: 'parsed' | 'unparsed';
}

function parseSku(sku: string): SkuParsed {
  const nil: SkuParsed = {
    parsed_cost_cents: null, parsed_list_price_cents: null,
    parsed_order_qty: null, parsed_date: null, sku_parse_status: 'unparsed',
  };

  let body: string;
  if (sku.startsWith('MF_LV_')) body = sku.slice(6);
  else if (sku.startsWith('LV_'))  body = sku.slice(3);
  else return nil;

  const parts = body.split('_');
  if (parts.length < 5) return nil;

  let i = parts.length - 1;
  if (!/^\d+$/.test(parts[i])) return nil;
  i--;
  if (parts[i] === 'B' || parts[i] === 'P') i--;
  if (i < 3) return nil;

  const qty = parseInt(parts[i--], 10);
  if (!Number.isFinite(qty) || qty <= 0) return nil;

  const listPrice = parseFloat(parts[i--]);
  if (!Number.isFinite(listPrice) || listPrice <= 0) return nil;

  const cost = parseFloat(parts[i--]);
  if (!Number.isFinite(cost) || cost <= 0) return nil;

  const ds = parts[i];
  if (!/^\d{6}$/.test(ds) && !/^\d{8}$/.test(ds)) return nil;

  let parsedDate: string;
  if (ds.length === 6) {
    parsedDate = `20${ds.slice(4, 6)}-${ds.slice(0, 2)}-${ds.slice(2, 4)}`;
  } else {
    parsedDate = `${ds.slice(4, 8)}-${ds.slice(0, 2)}-${ds.slice(2, 4)}`;
  }

  return {
    parsed_cost_cents:       Math.round(cost * 100),
    parsed_list_price_cents: Math.round(listPrice * 100),
    parsed_order_qty:        qty,
    parsed_date:             parsedDate,
    sku_parse_status:        'parsed',
  };
}

// Shared SELECT used by both the local and barcode paths.
// Caller appends the WHERE clause.
const LISTING_SELECT = `
  SELECT
    ml.id                                        AS ml_id,
    ml.sku,
    ml.asin,
    ml.quantity                                  AS amazon_qty,
    ml.status                                    AS amazon_status,
    ml.fulfillment_channel                       AS fulfillment_channel,
    ml.list_price_cents                          AS amazon_list_price_cents,
    ml.last_synced,
    COALESCE(p.name, ml.item_name)               AS product_name,
    p.image_url,
    p.category,
    il.id                                        AS il_id,
    il.buy_price,
    il.list_price_cents                          AS il_list_price_cents,
    il.bin_location,
    il.condition,
    il.quantity_received,
    il.quantity_remaining,
    il.quantity                                  AS lot_quantity,
    (SELECT COUNT(*) FROM receiving_issues ri
      WHERE ri.inventory_ledger_id = il.id AND ri.status = 'open') AS open_issue_count,
    il.received_at,
    il.inspected_at,
    il.merchant_shipping_group_name,
    fec.fee_cents,
    fec.referral_fee_cents,
    fec.list_price_cents                         AS fee_list_price_cents
  FROM merchant_listings ml
  LEFT JOIN products p ON p.asin = ml.asin
  LEFT JOIN inventory_ledger il
    ON il.sku = ml.sku
    AND il.quantity_remaining > 0
    AND il.id = (
      SELECT id FROM inventory_ledger
      WHERE sku = ml.sku AND quantity_remaining > 0
      ORDER BY date_purchased DESC
      LIMIT 1
    )
  LEFT JOIN fee_estimates_cache fec
    ON fec.asin = ml.asin AND fec.marketplace LIKE '%:MFN'
  WHERE ml.marketplace = 'amazon'
    AND (ml.sku LIKE 'LV_%' OR ml.sku LIKE 'MF_LV_%')
`;

const LISTING_ORDER = `
  ORDER BY
    CASE ml.status WHEN 'Active' THEN 0 ELSE 1 END,
    CASE WHEN ml.quantity = 0 THEN 0 ELSE 1 END,
    ml.quantity ASC
  LIMIT 15
`;

type DbRow = Record<string, unknown>;

const CATALOG_IMAGE_LOOKUP_LIMIT = 15;

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

function rowImageUrl(row: DbRow): string | null {
  return typeof row.image_url === 'string' && row.image_url.trim()
    ? row.image_url.trim()
    : null;
}

function rowAsin(row: DbRow): string | null {
  const asin = String(row.asin ?? '').trim().toUpperCase();
  return /^B[0-9A-Z]{9}$/.test(asin) ? asin : null;
}

function cacheCatalogImages(rows: DbRow[], catalogImageByAsin: Map<string, string>): void {
  const now = new Date().toISOString();
  const candidates = rows
    .map(row => {
      const asin = rowAsin(row);
      const imageUrl = asin ? catalogImageByAsin.get(asin) : null;
      return asin && imageUrl && !rowImageUrl(row)
        ? {
            asin,
            sku: String(row.sku ?? '').trim() || null,
            productName: String(row.product_name ?? '').trim() || null,
            imageUrl,
          }
        : null;
    })
    .filter((row): row is { asin: string; sku: string | null; productName: string | null; imageUrl: string } => row != null);

  if (candidates.length === 0) return;

  const db = getDb(false);
  try {
    const upsertImage = db.prepare(`
      INSERT INTO products (asin, sku, name, image_url, marketplace, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'amazon', ?, ?)
      ON CONFLICT(asin) DO UPDATE SET
        image_url = CASE
          WHEN products.image_url IS NULL OR TRIM(products.image_url) = ''
          THEN excluded.image_url
          ELSE products.image_url
        END,
        name = CASE
          WHEN products.name IS NULL OR TRIM(products.name) = ''
          THEN excluded.name
          ELSE products.name
        END,
        sku = CASE
          WHEN products.sku IS NULL OR TRIM(products.sku) = ''
          THEN excluded.sku
          ELSE products.sku
        END,
        updated_at = CASE
          WHEN products.image_url IS NULL OR TRIM(products.image_url) = ''
          THEN excluded.updated_at
          ELSE products.updated_at
        END
    `);

    const writeImages = db.transaction(() => {
      for (const row of candidates) {
        upsertImage.run(row.asin, row.sku, row.productName, row.imageUrl, now, now);
      }
    });
    writeImages();
  } catch (error) {
    console.warn('[mfn-search] catalog image cache write failed:', error);
  } finally {
    db.close();
  }
}

async function addCatalogImageFallback(rows: DbRow[]): Promise<DbRow[]> {
  const missingImageAsins = Array.from(new Set(
    rows
      .filter(row => !rowImageUrl(row))
      .map(rowAsin)
      .filter((asin): asin is string => asin != null)
  )).slice(0, CATALOG_IMAGE_LOOKUP_LIMIT);

  if (missingImageAsins.length === 0) return rows;

  const creds = getCredentials();
  if (!creds) return rows;

  const catalogImageByAsin = new Map<string, string>();
  for (const asin of missingImageAsins) {
    try {
      const catalogItem = await fetchCatalogByAsin(creds, asin);
      if (catalogItem?.imageUrl) catalogImageByAsin.set(asin, catalogItem.imageUrl);
    } catch (error) {
      console.warn(`[mfn-search] catalog image fallback failed asin=${asin}:`, error);
    }
  }

  if (catalogImageByAsin.size === 0) return rows;

  cacheCatalogImages(rows, catalogImageByAsin);

  return rows.map(row => {
    const asin = rowAsin(row);
    return {
      ...row,
      image_url: rowImageUrl(row) || (asin ? catalogImageByAsin.get(asin) : null) || null,
    };
  });
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// How many uncached results to price live per search. A scan/barcode lookup is
// usually 1 result; the cap keeps a broad title search from bursting the
// Product Fees API rate limit. Successful fetches are cached, so repeats are free.
const FEE_FETCH_LIMIT = 6;

// Fill in fees on-demand for results that have no cached estimate yet, so newly
// received items show realistic fee/margin immediately instead of $0. MFN →
// referral only (isAmazonFulfilled=false). getFeesEstimate writes the cache, so
// the next search of the same item is instant. Mutates rows in place.
async function addFeeFallback(results: DbRow[]): Promise<DbRow[]> {
  const creds = getCredentials();
  if (!creds) return results;

  let calls = 0;
  for (const row of results) {
    if (calls >= FEE_FETCH_LIMIT) break;
    if (row.fee_cents != null) continue; // already cached/priced
    // Accept any 10-char ASIN: B0-prefixed AND 10-digit ISBNs (books). The
    // rowAsin() helper is image-lookup specific (B0-only) and too strict here.
    const asin = String(row.asin ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
    const listCents =
      Number(row.amazon_list_price_cents) ||
      Number(row.parsed_list_price_cents) ||
      Number(row.il_list_price_cents) || 0;
    if (listCents <= 0) continue;
    try {
      if (calls > 0) await delay(300);
      const est = await getFeesEstimate(creds, asin, listCents, (row.category as string | null) ?? null, false);
      row.fee_cents = est.totalFeeCents;
      row.referral_fee_cents = est.referralFeeCents;
      row.fee_list_price_cents = listCents;
      row.fee_source = est.source;
      calls++;
    } catch (error) {
      console.warn(`[mfn-search] live fee fetch failed asin=${asin}:`, error);
    }
  }
  return results;
}

// GET /api/data/mfn-search?q=<term>
//
// No Amazon writes. May cache Catalog image_url locally for exact ASINs
// when the matching products row is missing a photo.
//
// Query routing:
//   Barcode (10-14 digits) → Amazon Catalog Items GET (read-only) to resolve ASINs,
//     then cross-reference with local merchant_listings. Falls back to empty results
//     when SP-API credentials are not configured.
//   ASIN / MSKU / title → local SQLite search, with read-only Catalog image
//     fallback for rows missing cached product photos.
//
// Returns up to 15 results ordered by: Active first, then OOS, then others.
export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get('q') ?? '').trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  // --- Barcode path (UPC/EAN/ISBN: 10-14 digit string) ---
  if (isBarcode(q)) {
    const creds = getCredentials();
    if (!creds) {
      // No credentials → can't resolve barcode; return empty gracefully
      return NextResponse.json({ results: [], barcode: true, credentialsMissing: true });
    }

    let catalogItems: Awaited<ReturnType<typeof searchCatalog>> = [];
    try {
      catalogItems = await searchCatalog(creds, q);
    } catch {
      return NextResponse.json({ results: [], barcode: true });
    }

    if (catalogItems.length === 0) {
      return NextResponse.json({ results: [], barcode: true });
    }

    const asins = catalogItems.map(ci => ci.asin);
    // Map ASIN → catalog image URL so we can fall back when products.image_url is null
    const catalogImageByAsin = new Map<string, string>();
    for (const item of catalogItems) {
      if (item.imageUrl) catalogImageByAsin.set(item.asin, item.imageUrl);
    }

    const db = getDb();
    try {
      const placeholders = asins.map(() => '?').join(',');
      const rows = db.prepare(
        `${LISTING_SELECT} AND ml.asin IN (${placeholders}) ${LISTING_ORDER}`
      ).all(...asins) as DbRow[];

      cacheCatalogImages(rows, catalogImageByAsin);

      const rowsWithIncoming = attachOpenIncomingPurchases(db, rows);
      const results = rowsWithIncoming.map(row => ({
        ...row,
        // Prefer DB image; fall back to catalog image returned for this barcode
        image_url: (row.image_url as string | null) || catalogImageByAsin.get(String(row.asin)) || null,
        // Echo the searched UPC so the client can display it without a separate lookup
        upc: q,
        ...parseSku(String(row.sku ?? '')),
      }));

      await addFeeFallback(results);
      return NextResponse.json({ results, barcode: true });
    } catch (error) {
      console.error('[mfn-search] barcode path error:', error);
      return NextResponse.json({ error: 'Search failed' }, { status: 500 });
    } finally {
      db.close();
    }
  }

  // --- Local path (ASIN / MSKU / title) ---
  const db = getDb();
  let rows: DbRow[];
  try {
    const exactAsin = q.toUpperCase();
    const skuLike   = `%${q}%`;
    const titleLike = `%${q.toLowerCase()}%`;

    rows = db.prepare(`
      ${LISTING_SELECT}
        AND (
          ml.asin = ?
          OR ml.sku LIKE ?
          OR LOWER(COALESCE(p.name, ml.item_name)) LIKE ?
        )
      ${LISTING_ORDER}
    `).all(exactAsin, skuLike, titleLike) as DbRow[];
    rows = attachOpenIncomingPurchases(db, rows);
  } catch (error) {
    console.error('[mfn-search] error:', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  } finally {
    db.close();
  }

  const rowsWithImages = await addCatalogImageFallback(rows);
  const results = rowsWithImages.map(row => ({
    ...row,
    ...parseSku(String(row.sku ?? '')),
  }));

  await addFeeFallback(results);
  return NextResponse.json({ results });
}
