import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { isBarcode, searchCatalog } from '@/lib/sp-api/catalog';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
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
    il.id                                        AS il_id,
    il.buy_price,
    il.list_price_cents                          AS il_list_price_cents,
    il.bin_location,
    il.condition,
    il.quantity_received,
    il.quantity_remaining,
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

// GET /api/data/mfn-search?q=<term>
//
// Read-only. No Amazon writes.
//
// Query routing:
//   Barcode (10-14 digits) → Amazon Catalog Items GET (read-only) to resolve ASINs,
//     then cross-reference with local merchant_listings. Falls back to empty results
//     when SP-API credentials are not configured.
//   ASIN / MSKU / title → local SQLite search only.
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
    const catalogImageByAsin = new Map(catalogItems.map(ci => [ci.asin, ci.imageUrl]));

    const db = getDb();
    try {
      const placeholders = asins.map(() => '?').join(',');
      const rows = db.prepare(
        `${LISTING_SELECT} AND ml.asin IN (${placeholders}) ${LISTING_ORDER}`
      ).all(...asins) as DbRow[];

      const results = rows.map(row => ({
        ...row,
        // Prefer DB image; fall back to catalog image returned for this barcode
        image_url: (row.image_url as string | null) || catalogImageByAsin.get(String(row.asin)) || null,
        // Echo the searched UPC so the client can display it without a separate lookup
        upc: q,
        ...parseSku(String(row.sku ?? '')),
      }));

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
  try {
    const exactAsin = q.toUpperCase();
    const skuLike   = `%${q}%`;
    const titleLike = `%${q.toLowerCase()}%`;

    const rows = db.prepare(`
      ${LISTING_SELECT}
        AND (
          ml.asin = ?
          OR ml.sku LIKE ?
          OR LOWER(COALESCE(p.name, ml.item_name)) LIKE ?
        )
      ${LISTING_ORDER}
    `).all(exactAsin, skuLike, titleLike) as DbRow[];

    const results = rows.map(row => ({
      ...row,
      ...parseSku(String(row.sku ?? '')),
    }));

    return NextResponse.json({ results });
  } catch (error) {
    console.error('[mfn-search] error:', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  } finally {
    db.close();
  }
}
