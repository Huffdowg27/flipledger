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
export async function enrichProductCatalog(
  credentials: SPAPICredentials
): Promise<{ enriched: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let enriched = 0;

  try {
    // Find products missing names
    const missingProducts = db.prepare(`
      SELECT DISTINCT asin FROM products
      WHERE (name IS NULL OR name = '') AND asin IS NOT NULL
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

        db.prepare(`
          UPDATE products SET
            name = COALESCE(?, name),
            category = COALESCE(?, category),
            image_url = COALESCE(?, image_url),
            updated_at = ?
          WHERE asin = ?
        `).run(name, category, imageUrl, new Date().toISOString(), asin);

        enriched++;

        // Rate limit: ~5 requests per second for Catalog API
        await new Promise(resolve => setTimeout(resolve, 250));
      } catch (err) {
        errors.push(`Catalog ${asin}: ${err}`);
      }
    }
  } finally {
    db.close();
  }

  return { enriched, errors };
}
