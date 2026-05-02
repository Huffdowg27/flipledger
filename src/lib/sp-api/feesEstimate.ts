/**
 * SP-API Product Fees estimate client.
 *
 * POST /products/fees/v0/items/{asin}/feesEstimate
 *
 * Returns Amazon's projected fees for selling a given ASIN at a given price.
 * Covers referral fee + FBA fulfillment fee + variable closing fees.
 *
 * Results are cached in fee_estimates_cache for 24 hours per ASIN to avoid
 * hammering the API on restock scans. On cache hit, fees are scaled linearly
 * to the requested list price.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { getAccessToken, getEndpoint } from './auth';
import type { SPAPICredentials } from './types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface FeesEstimate {
  totalFeeCents: number;
  referralFeeCents: number;
  fbaFeeCents: number;
  source: 'sp-api' | 'cache' | 'fallback';
}

/**
 * Conservative category fallback when SP-API is unavailable.
 * Uses Amazon's published referral fee schedule as of 2026 + a typical FBA
 * fulfillment fee for a standard-size item. Not accurate per-item, but better
 * than assuming zero fees.
 *
 * For MFN, only the referral fee is included — seller handles their own shipping
 * cost separately.
 */
function categoryFallback(listPriceCents: number, category: string | null, isAmazonFulfilled: boolean = true): FeesEstimate {
  // Referral rate by category. Default to 15% for unknown.
  const rateMap: Record<string, number> = {
    'Electronics': 0.08,
    'Video Games': 0.08,
    'Cell Phones': 0.08,
    'Camera & Photo': 0.08,
    'Computers': 0.08,
    'Car Electronics': 0.08,
    'Toys & Games': 0.15,
    'Home & Kitchen': 0.15,
    'Sports & Outdoors': 0.15,
    'Health & Personal Care': 0.15,
    'Beauty': 0.15,
    'Grocery': 0.15,
    'Books': 0.15,
    'Jewelry': 0.20,
    'Watches': 0.16,
    'Clothing': 0.17,
    'Shoes': 0.15,
  };

  // Fuzzy match category
  let rate = 0.15;
  if (category) {
    for (const [key, r] of Object.entries(rateMap)) {
      if (category.toLowerCase().includes(key.toLowerCase())) {
        rate = r;
        break;
      }
    }
  }

  const referralFeeCents = Math.round(listPriceCents * rate);
  // Minimum referral fee is $0.30
  const effectiveReferralCents = Math.max(referralFeeCents, 30);
  // FBA standard-size fulfillment fee ~$4.50 (ballpark). Zero for MFN.
  const fbaFeeCents = isAmazonFulfilled ? 450 : 0;

  return {
    totalFeeCents: effectiveReferralCents + fbaFeeCents,
    referralFeeCents: effectiveReferralCents,
    fbaFeeCents,
    source: 'fallback',
  };
}

/**
 * Cache key includes FBA/MFN by appending a suffix to the marketplace string.
 * FBA estimates include fulfillment fees, MFN do not, so they must not collide.
 */
function cacheKey(marketplace: string, isAmazonFulfilled: boolean): string {
  return `${marketplace}:${isAmazonFulfilled ? 'FBA' : 'MFN'}`;
}

/** Read cached fees estimate for an ASIN. Returns null if missing or stale. */
function readCache(asin: string, marketplace: string, isAmazonFulfilled: boolean, listPriceCents: number): FeesEstimate | null {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT list_price_cents, fee_cents, referral_fee_cents, fba_fee_cents, estimated_at
      FROM fee_estimates_cache
      WHERE asin = ? AND marketplace = ?
    `).get(asin, cacheKey(marketplace, isAmazonFulfilled)) as any;

    if (!row) return null;

    const age = Date.now() - new Date(row.estimated_at).getTime();
    if (age > CACHE_TTL_MS) return null;

    // Scale linearly to the requested price. Referral fees are a percentage so this
    // is accurate for them; FBA fees are flat so we keep them as-is from the cached row.
    const cachedPrice = row.list_price_cents || listPriceCents;
    const scale = listPriceCents / cachedPrice;
    const scaledReferral = Math.round((row.referral_fee_cents || 0) * scale);
    const fba = row.fba_fee_cents || 0;

    return {
      totalFeeCents: scaledReferral + fba,
      referralFeeCents: scaledReferral,
      fbaFeeCents: fba,
      source: 'cache',
    };
  } finally {
    db.close();
  }
}

/** Upsert a fresh fees estimate into the cache. */
function writeCache(
  asin: string,
  marketplace: string,
  isAmazonFulfilled: boolean,
  listPriceCents: number,
  estimate: Omit<FeesEstimate, 'source'>
) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO fee_estimates_cache (asin, marketplace, list_price_cents, fee_cents, referral_fee_cents, fba_fee_cents, estimated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asin, marketplace) DO UPDATE SET
        list_price_cents = excluded.list_price_cents,
        fee_cents = excluded.fee_cents,
        referral_fee_cents = excluded.referral_fee_cents,
        fba_fee_cents = excluded.fba_fee_cents,
        estimated_at = excluded.estimated_at
    `).run(
      asin,
      cacheKey(marketplace, isAmazonFulfilled),
      listPriceCents,
      estimate.totalFeeCents,
      estimate.referralFeeCents,
      estimate.fbaFeeCents,
      new Date().toISOString()
    );
  } finally {
    db.close();
  }
}

/**
 * Fetch a fees estimate from SP-API. Raw call — no caching.
 * @param isAmazonFulfilled true for FBA (includes fulfillment fee), false for MFN (referral only).
 */
async function fetchFeesEstimateRaw(
  credentials: SPAPICredentials,
  asin: string,
  listPriceCents: number,
  isAmazonFulfilled: boolean
): Promise<Omit<FeesEstimate, 'source'> | null> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const body = {
    FeesEstimateRequest: {
      MarketplaceId: credentials.marketplaceId,
      IdType: 'ASIN',
      IdValue: asin,
      PriceToEstimateFees: {
        ListingPrice: {
          CurrencyCode: 'USD',
          Amount: listPriceCents / 100,
        },
      },
      Identifier: `flipledger-${asin}-${Date.now()}`,
      IsAmazonFulfilled: isAmazonFulfilled,
    },
  };

  const url = `${endpoint}/products/fees/v0/items/${encodeURIComponent(asin)}/feesEstimate`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API fees estimate ${response.status} on ${asin}: ${errorBody}`);
  }

  const data = await response.json();

  // Response shape: { payload: { FeesEstimateResult: { Status, FeesEstimate: { TotalFeesEstimate, FeeDetailList } } } }
  const result = data?.payload?.FeesEstimateResult || data?.FeesEstimateResult;
  if (!result || result.Status !== 'Success') return null;

  const fees = result.FeesEstimate;
  if (!fees) return null;

  const totalAmount = fees.TotalFeesEstimate?.Amount || 0;
  const totalFeeCents = Math.round(totalAmount * 100);

  // Break out individual fee types
  let referralFeeCents = 0;
  let fbaFeeCents = 0;
  for (const detail of fees.FeeDetailList || []) {
    const amt = Math.round((detail.FinalFee?.Amount || detail.FeeAmount?.Amount || 0) * 100);
    const type = detail.FeeType || '';
    if (type === 'ReferralFee' || type === 'VariableClosingFee') {
      referralFeeCents += amt;
    } else if (type === 'FBAFees' || type === 'FulfillmentFees' || type.startsWith('FBA')) {
      fbaFeeCents += amt;
    } else {
      // Catch-all — lump into referral bucket for scaling
      referralFeeCents += amt;
    }
  }

  // Safety: if breakdown didn't add up, use the total
  if (referralFeeCents + fbaFeeCents === 0 && totalFeeCents > 0) {
    // Assume ~85% referral-ish (scales with price), 15% FBA-ish (flat)
    referralFeeCents = Math.round(totalFeeCents * 0.85);
    fbaFeeCents = totalFeeCents - referralFeeCents;
  }

  return { totalFeeCents, referralFeeCents, fbaFeeCents };
}

/**
 * Get a fees estimate for an ASIN at a given list price.
 * Tries cache → SP-API → category fallback in order.
 *
 * @param isAmazonFulfilled true for FBA (referral + FBA fulfillment), false for MFN (referral only).
 *   Default true. MFN sellers handle their own shipping costs separately.
 */
export async function getFeesEstimate(
  credentials: SPAPICredentials,
  asin: string,
  listPriceCents: number,
  category: string | null = null,
  isAmazonFulfilled: boolean = true
): Promise<FeesEstimate> {
  if (!listPriceCents || listPriceCents <= 0) {
    return categoryFallback(listPriceCents || 0, category, isAmazonFulfilled);
  }

  // 1. Cache (channel-specific)
  const cached = readCache(asin, credentials.marketplaceId, isAmazonFulfilled, listPriceCents);
  if (cached) return cached;

  // 2. SP-API
  try {
    const raw = await fetchFeesEstimateRaw(credentials, asin, listPriceCents, isAmazonFulfilled);
    if (raw && raw.totalFeeCents > 0) {
      writeCache(asin, credentials.marketplaceId, isAmazonFulfilled, listPriceCents, raw);
      return { ...raw, source: 'sp-api' };
    }
  } catch (err) {
    // Log and fall through to the category fallback
    console.warn(`[feesEstimate] SP-API failed for ${asin}:`, err);
  }

  // 3. Category fallback
  return categoryFallback(listPriceCents, category, isAmazonFulfilled);
}
