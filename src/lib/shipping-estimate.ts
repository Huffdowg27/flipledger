/**
 * Historical shipping-cost estimator for MFN listings.
 *
 * Queries the seller's own synced MFN order data to compute a per-unit
 * shipping cost estimate. Tries per-ASIN first (most accurate — uses your
 * real past shipments of this exact product), then falls back to the
 * overall marketplace average. Returns 0 if no data exists at all.
 *
 * Shipping cost is the amount the seller paid the carrier (stored in
 * `order_items.shipping_cost` in cents), not what the customer paid (that's
 * `shipping_charged`). For FBA orders the FBA fulfillment fee is already
 * captured via the SP-API fees estimate, so this helper is only useful for
 * MFN / merchant-fulfilled channel.
 */
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export interface ShippingEstimate {
  costCents: number;
  source: 'per-asin' | 'marketplace-avg' | 'none';
  sampleSize: number;
}

/**
 * Estimate per-unit shipping cost for an ASIN on a given marketplace.
 * @param asin the product ASIN
 * @param marketplace 'amazon' / 'walmart' / 'ebay' (internal marketplace column value)
 */
export function estimateShippingCost(asin: string, marketplace: string = 'amazon'): ShippingEstimate {
  const db = getDb();
  try {
    // 1. Try per-ASIN average first — most accurate
    const perAsin = db.prepare(`
      SELECT AVG(oi.shipping_cost) as avg_cost, COUNT(*) as n
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE oi.asin = ?
        AND o.marketplace = ?
        AND o.fulfillment_channel IN ('MFN', 'Seller')
        AND oi.shipping_cost > 0
    `).get(asin, marketplace) as any;

    if (perAsin?.n >= 2 && perAsin.avg_cost > 0) {
      return {
        costCents: Math.round(perAsin.avg_cost),
        source: 'per-asin',
        sampleSize: perAsin.n,
      };
    }

    // 2. Fall back to the marketplace-wide MFN average
    const perMarketplace = db.prepare(`
      SELECT AVG(oi.shipping_cost) as avg_cost, COUNT(*) as n
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.marketplace = ?
        AND o.fulfillment_channel IN ('MFN', 'Seller')
        AND oi.shipping_cost > 0
    `).get(marketplace) as any;

    if (perMarketplace?.n >= 5 && perMarketplace.avg_cost > 0) {
      return {
        costCents: Math.round(perMarketplace.avg_cost),
        source: 'marketplace-avg',
        sampleSize: perMarketplace.n,
      };
    }

    // 3. No data at all
    return { costCents: 0, source: 'none', sampleSize: 0 };
  } finally {
    db.close();
  }
}
