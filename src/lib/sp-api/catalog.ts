/**
 * SP-API Catalog Items API client.
 * Fetches product details (name, category, images) for ASINs.
 */

import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export interface CatalogItem {
  asin: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  imageUrl: string | null;
  dimensions: { lengthIn?: number; widthIn?: number; heightIn?: number; weightLb?: number } | null;
  source: 'amazon' | 'local';
}

/** Detect whether a query looks like an ASIN (B + 9 alphanumeric). */
export function isAsin(q: string): boolean {
  return /^B[0-9A-Z]{9}$/i.test(q.trim());
}

/** Detect whether a query looks like a UPC/EAN/ISBN (all digits, 10-14 chars). */
export function isBarcode(q: string): boolean {
  const s = q.trim();
  return /^\d{10,14}$/.test(s);
}

/** Parse a SP-API catalog item response into our CatalogItem shape. */
function parseCatalogItem(item: any): CatalogItem | null {
  if (!item?.asin) return null;
  const summary = item.summaries?.[0];
  const classification = item.classifications?.[0]?.classifications?.[0];
  const image = item.images?.[0]?.images?.[0];

  // Dimensions: try packageDimensions from summary first, then itemDimensions
  const pkg = summary?.packageDimensions || summary?.itemDimensions;
  const dims = pkg ? {
    lengthIn: pkg.length?.value,
    widthIn: pkg.width?.value,
    heightIn: pkg.height?.value,
    weightLb: pkg.weight?.value,
  } : null;

  return {
    asin: item.asin,
    name: summary?.itemName || null,
    brand: summary?.brand || null,
    category: classification?.displayName || null,
    imageUrl: image?.link || null,
    dimensions: dims,
    source: 'amazon',
  };
}

/**
 * Look up a product in the local DB first (fast path).
 * Matches by ASIN against products and live_inventory.
 */
export function lookupLocalByAsin(asin: string): CatalogItem | null {
  const db = getDb();
  try {
    // Try products table first
    const p = db.prepare(`
      SELECT asin, name, category, image_url
      FROM products
      WHERE asin = ?
      LIMIT 1
    `).get(asin) as any;

    if (p?.name) {
      return {
        asin: p.asin,
        name: p.name,
        brand: null,
        category: p.category,
        imageUrl: p.image_url,
        dimensions: null,
        source: 'local',
      };
    }

    // Fallback: live_inventory has product_name
    const li = db.prepare(`
      SELECT asin, product_name FROM live_inventory WHERE asin = ? LIMIT 1
    `).get(asin) as any;

    if (li?.product_name) {
      return {
        asin: li.asin,
        name: li.product_name,
        brand: null,
        category: null,
        imageUrl: null,
        dimensions: null,
        source: 'local',
      };
    }

    return null;
  } finally {
    db.close();
  }
}

/**
 * Fetch product details from Amazon's Catalog Items API by ASIN.
 * GET /catalog/2022-04-01/items/{asin}
 */
export async function fetchCatalogByAsin(
  credentials: SPAPICredentials,
  asin: string
): Promise<CatalogItem | null> {
  const response = await spApiRequest(
    credentials,
    `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`,
    {
      marketplaceIds: credentials.marketplaceId,
      includedData: 'summaries,images,classifications,dimensions',
    }
  );
  return parseCatalogItem(response);
}

/**
 * Search Amazon's Catalog Items API by UPC/EAN/ISBN barcode or keywords.
 * GET /catalog/2022-04-01/items?identifiers={barcode}&identifiersType=UPC
 */
export async function searchCatalog(
  credentials: SPAPICredentials,
  query: string
): Promise<CatalogItem[]> {
  const trimmed = query.trim();

  // Barcode path — use identifiers lookup
  if (isBarcode(trimmed)) {
    // Try UPC first, then EAN, then ISBN (for 10-13 digit codes)
    const types = trimmed.length === 13 ? ['EAN', 'UPC'] : trimmed.length === 10 ? ['ISBN'] : ['UPC', 'EAN'];
    for (const type of types) {
      try {
        const response = await spApiRequest(
          credentials,
          '/catalog/2022-04-01/items',
          {
            identifiers: trimmed,
            identifiersType: type,
            marketplaceIds: credentials.marketplaceId,
            includedData: 'summaries,images,classifications,dimensions',
            pageSize: '10',
          }
        );
        const items: CatalogItem[] = (response?.items || [])
          .map(parseCatalogItem)
          .filter((x: CatalogItem | null): x is CatalogItem => x !== null);
        if (items.length > 0) return items;
      } catch {
        // try next type
      }
    }
    return [];
  }

  // Keyword path
  const response = await spApiRequest(
    credentials,
    '/catalog/2022-04-01/items',
    {
      keywords: trimmed,
      marketplaceIds: credentials.marketplaceId,
      includedData: 'summaries,images,classifications,dimensions',
      pageSize: '10',
    }
  );
  return (response?.items || [])
    .map(parseCatalogItem)
    .filter((x: CatalogItem | null): x is CatalogItem => x !== null);
}

/**
 * Fetch and store product details for ASINs missing names/categories.
 * Batches requests to avoid rate limits.
 */
/**
 * Backfill product images for merchant listings that lack one.
 *
 * Two gaps this closes that the weekly enrichProductCatalog sweep does not:
 *   1. Merchant ASINs with no `products` row at all (enrichment only SELECTs
 *      from products, so it never sees them) — we insert a stub row first.
 *   2. The weekly sweep only does 50/run; this processes a caller-set chunk so
 *      a one-time bulk backfill finishes in minutes instead of weeks.
 *
 * Chunked: returns `remaining` so the caller can loop until it hits 0.
 */
export async function backfillMerchantListingImages(
  credentials: SPAPICredentials,
  limit = 100
): Promise<{ processed: number; updated: number; remaining: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let processed = 0;
  let updated = 0;

  try {
    // 1. Ensure every merchant ASIN has a products row so it becomes enrichable.
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO products (asin, created_at, updated_at)
      SELECT DISTINCT ml.asin, ?, ?
      FROM merchant_listings ml
      WHERE TRIM(ml.asin) <> '' AND ml.asin IS NOT NULL
    `).run(now, now);

    // 2. Pull a chunk of merchant ASINs still missing an image.
    const targets = db.prepare(`
      SELECT DISTINCT ml.asin AS asin
      FROM merchant_listings ml
      JOIN products p ON p.asin = ml.asin
      WHERE (p.image_url IS NULL OR TRIM(p.image_url) = '')
        AND TRIM(ml.asin) <> '' AND ml.asin IS NOT NULL
      ORDER BY ml.asin
      LIMIT ?
    `).all(limit) as { asin: string }[];

    for (const { asin } of targets) {
      processed++;
      try {
        const item = await fetchCatalogByAsin(credentials, asin);
        const enrichedAt = new Date().toISOString();
        db.prepare(`
          UPDATE products SET
            name = COALESCE(?, name),
            category = COALESCE(?, category),
            image_url = COALESCE(?, image_url),
            catalog_last_enriched = ?,
            updated_at = ?
          WHERE asin = ?
        `).run(item?.name ?? null, item?.category ?? null, item?.imageUrl ?? null, enrichedAt, enrichedAt, asin);
        if (item?.imageUrl) updated++;
        await new Promise(resolve => setTimeout(resolve, 250));
      } catch (err) {
        db.prepare(`UPDATE products SET catalog_last_enriched = ? WHERE asin = ?`)
          .run(new Date().toISOString(), asin);
        errors.push(`Catalog ${asin}: ${err}`);
      }
    }

    const rem = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT DISTINCT ml.asin
        FROM merchant_listings ml
        JOIN products p ON p.asin = ml.asin
        WHERE (p.image_url IS NULL OR TRIM(p.image_url) = '')
          AND TRIM(ml.asin) <> '' AND ml.asin IS NOT NULL
      )
    `).get() as { n: number };

    return { processed, updated, remaining: rem.n, errors };
  } finally {
    db.close();
  }
}

export async function enrichProductCatalog(
  credentials: SPAPICredentials
): Promise<{ enriched: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let enriched = 0;

  try {
    // Find products missing names or images, but do not hammer the same failed
    // ASINs every hourly sync. Catalog metadata is slow-changing, so a weekly
    // retry cadence is enough for rows that did not enrich cleanly.
    const missingProducts = db.prepare(`
      SELECT DISTINCT asin FROM products
      WHERE (
        (name IS NULL OR TRIM(name) = '')
        OR (image_url IS NULL OR TRIM(image_url) = '')
      )
      AND TRIM(asin) <> ''
      AND asin IS NOT NULL
      AND (
        catalog_last_enriched IS NULL
        OR julianday(catalog_last_enriched) <= julianday('now', '-7 days')
      )
      ORDER BY updated_at ASC
      LIMIT 50
    `).all() as { asin: string }[];

    for (const { asin } of missingProducts) {
      try {
        const response = await spApiRequest(
          credentials,
          `/catalog/2022-04-01/items/${asin}`,
          {
            marketplaceIds: credentials.marketplaceId,
            includedData: 'summaries,images,classifications',
          }
        );

        const item = response;
        if (!item) continue;

        const summary = item.summaries?.[0];
        const classification = item.classifications?.[0];
        const image = item.images?.[0]?.images?.[0];

        const name = summary?.itemName || null;
        const category = classification?.classifications?.[0]?.displayName || null;
        const imageUrl = image?.link || null;

        const enrichedAt = new Date().toISOString();
        db.prepare(`
          UPDATE products SET
            name = COALESCE(?, name),
            category = COALESCE(?, category),
            image_url = COALESCE(?, image_url),
            catalog_last_enriched = ?,
            updated_at = ?
          WHERE asin = ?
        `).run(name, category, imageUrl, enrichedAt, enrichedAt, asin);

        enriched++;

        // SP-API pacing happens in spApiRequest; this gives the event loop a
        // small breather between per-ASIN DB updates.
        await new Promise(resolve => setTimeout(resolve, 250));
      } catch (err) {
        db.prepare(`
          UPDATE products SET catalog_last_enriched = ?
          WHERE asin = ?
        `).run(new Date().toISOString(), asin);
        errors.push(`Catalog ${asin}: ${err}`);
      }
    }
  } finally {
    db.close();
  }

  return { enriched, errors };
}
