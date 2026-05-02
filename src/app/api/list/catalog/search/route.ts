/**
 * Catalog search endpoint for the listing tool.
 *
 * GET /api/list/catalog/search?q=XXX
 *   - q = ASIN (B + 9 alphanumeric) → direct lookup
 *   - q = UPC/EAN/ISBN (10-14 digits) → barcode lookup
 *   - q = keywords → keyword search
 *
 * Tries the local DB first for known ASINs (fast path), falls back to SP-API.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import {
  isAsin,
  isBarcode,
  lookupLocalByAsin,
  fetchCatalogByAsin,
  searchCatalog,
  type CatalogItem,
} from '@/lib/sp-api/catalog';
import { getFeesEstimate, type FeesEstimate } from '@/lib/sp-api/feesEstimate';
import { estimateShippingCost, type ShippingEstimate } from '@/lib/shipping-estimate';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getAmazonCredentials(): SPAPICredentials | null {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;
    if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;
    return {
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      refreshToken: settings.refreshToken,
      marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
    };
  } finally {
    db.close();
  }
}

/**
 * Enrich a catalog item with historical data:
 *   - avgFeeRate: average marketplace fee % from past sales
 *   - avgSalePrice: average sale price
 *   - unitsSoldLast30d / last90d
 *   - currentFbaStock: from live_inventory
 *   - lastBuyPrice: most recent buy_price from inventory_ledger
 */
function enrichWithHistory(item: CatalogItem): CatalogItem & {
  avgFeeRate?: number;
  avgSalePrice?: number;
  unitsSoldLast30d?: number;
  unitsSoldLast90d?: number;
  currentFbaStock?: number;
  lastBuyPrice?: number;
} {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');

  try {
    // Historical fee rate: sum of fees / sum of revenue for this ASIN (lifetime, Amazon only)
    const feeStats = db.prepare(`
      SELECT
        COALESCE(SUM(oi.total_price), 0) as revenue,
        COALESCE(-SUM(fd.amount), 0) as fees
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN fee_details fd ON oi.order_id = fd.order_id AND fd.amount < 0
      WHERE oi.asin = ? AND o.marketplace = 'amazon'
    `).get(item.asin) as any;

    const avgFeeRate = feeStats?.revenue > 0 ? feeStats.fees / feeStats.revenue : null;

    // Avg sale price (lifetime)
    const priceStats = db.prepare(`
      SELECT
        COALESCE(AVG(oi.total_price * 1.0 / NULLIF(oi.quantity, 0)), 0) as avgPrice,
        COALESCE(SUM(oi.quantity), 0) as totalUnits
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE oi.asin = ? AND o.marketplace = 'amazon'
    `).get(item.asin) as any;

    // Units sold last 30d and 90d (via purchase_date)
    const now = Date.now();
    const d30 = new Date(now - 30 * 86400000).toISOString();
    const d90 = new Date(now - 90 * 86400000).toISOString();

    const velocity = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN o.purchase_date >= ? THEN oi.quantity ELSE 0 END), 0) as last30,
        COALESCE(SUM(CASE WHEN o.purchase_date >= ? THEN oi.quantity ELSE 0 END), 0) as last90
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE oi.asin = ? AND o.marketplace = 'amazon'
    `).get(d30, d90, item.asin) as any;

    // Current FBA stock
    const stock = db.prepare(`
      SELECT COALESCE(SUM(fulfillable_qty + inbound_qty), 0) as qty
      FROM live_inventory
      WHERE asin = ? AND marketplace = 'amazon'
    `).get(item.asin) as any;

    // Last buy price from inventory_ledger
    const lastBuy = db.prepare(`
      SELECT buy_price
      FROM inventory_ledger
      WHERE asin = ?
      ORDER BY date_purchased DESC, id DESC
      LIMIT 1
    `).get(item.asin) as any;

    return {
      ...item,
      avgFeeRate: avgFeeRate ?? undefined,
      avgSalePrice: priceStats?.avgPrice > 0 ? Math.round(priceStats.avgPrice) : undefined,
      unitsSoldLast30d: velocity?.last30 ?? 0,
      unitsSoldLast90d: velocity?.last90 ?? 0,
      currentFbaStock: stock?.qty ?? 0,
      lastBuyPrice: lastBuy?.buy_price ?? undefined,
    };
  } finally {
    db.close();
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim() || '';
  if (!q) return NextResponse.json({ error: 'Missing query param: q' }, { status: 400 });

  // Channel — FBA or MFN. Controls whether fee estimates include fulfillment fees.
  const channel = (searchParams.get('channel') || 'FBA').toUpperCase();
  const isFBA = channel === 'FBA';

  // Optional target price for fee estimation (cents). If absent, we use the enriched
  // avgSalePrice or lastBuyPrice × 2 as a reasonable default so the estimate is still
  // meaningful.
  const explicitPriceCents = parseInt(searchParams.get('priceCents') || '0', 10) || 0;

  const creds = getAmazonCredentials();
  if (!creds) return NextResponse.json({ error: 'SP-API credentials not configured' }, { status: 400 });

  try {
    let items: CatalogItem[] = [];

    if (isAsin(q)) {
      // Try local first
      const local = lookupLocalByAsin(q.toUpperCase());
      if (local) {
        items = [local];
      } else {
        try {
          const remote = await fetchCatalogByAsin(creds, q.toUpperCase());
          if (remote) items = [remote];
        } catch (err: any) {
          // 404 NOT_FOUND is expected for non-existent ASINs
          if (!String(err).includes('404')) throw err;
        }
      }
    } else {
      // Barcode or keywords — always hit SP-API
      items = await searchCatalog(creds, q);
    }

    // Enrich each with historical data (sales velocity, stock, avg price, etc.)
    const enrichedHistory = items.map(enrichWithHistory);

    // Pick a target price for fee estimation: explicit > avgSalePrice > lastBuyPrice*2 > 0
    const enrichedWithFees = await Promise.all(
      enrichedHistory.map(async (item) => {
        const targetPriceCents =
          explicitPriceCents ||
          item.avgSalePrice ||
          (item.lastBuyPrice ? item.lastBuyPrice * 2 : 0);

        // MFN-only: estimate the seller's outbound shipping cost from their
        // own historical MFN order data. FBA ships via FBA fulfillment fee
        // which is already baked into the SP-API fees estimate.
        const shippingEstimate: ShippingEstimate = isFBA
          ? { costCents: 0, source: 'none', sampleSize: 0 }
          : estimateShippingCost(item.asin, 'amazon');

        if (targetPriceCents <= 0) {
          // Can't estimate fees without any price reference, but shipping is still valid
          return { ...item, feeEstimate: null as FeesEstimate | null, shippingEstimate };
        }

        const feeEstimate = await getFeesEstimate(
          creds,
          item.asin,
          targetPriceCents,
          item.category,
          isFBA
        );

        return {
          ...item,
          feeEstimate,
          feeEstimatePriceCents: targetPriceCents,
          shippingEstimate,
        };
      })
    );

    return NextResponse.json({
      query: q,
      queryType: isAsin(q) ? 'asin' : isBarcode(q) ? 'barcode' : 'keywords',
      channel: isFBA ? 'FBA' : 'MFN',
      count: enrichedWithFees.length,
      items: enrichedWithFees,
    });
  } catch (err) {
    console.error('Catalog search error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
