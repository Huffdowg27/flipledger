/**
 * Bulk MFN fee backfill — shared core.
 *
 * Populates fee_estimates_cache for merchant-fulfilled (DEFAULT) ASINs that
 * have no cached MFN fee yet, by calling getFeesEstimate (read-only SP-API).
 *
 * Used by:
 *   - POST /api/sync/backfill-mfn-fees  (manual/dry-run capable)
 *   - auto-sync (daily safety net, so listings that are never manually scanned
 *     still get fees pre-filled).
 *
 * On-demand pricing at receive time (mfn-search / catalog-search) is the primary
 * path; this is just a catch-up sweep. getFeesEstimate writes the cache itself on
 * an SP-API hit; only the category-fallback case needs an explicit write here
 * (gated by writeFallback).
 */
import Database from 'better-sqlite3';
import path from 'path';
import { getFeesEstimate } from './feesEstimate';
import type { SPAPICredentials } from './types';

export interface BackfillMfnFeesResult {
  eligible: number;
  attempted: number;
  estimated: number;
  spApiEstimated: number;
  fallbackWritten: number;
  failed: number;
  errors: { asin: string; error: string }[];
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function backfillMfnFees(
  creds: SPAPICredentials,
  opts: { limit?: number; delayMs?: number; writeFallback?: boolean } = {}
): Promise<BackfillMfnFeesResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const delayMs = Math.max(opts.delayMs ?? 300, 0);
  const writeFallback = opts.writeFallback ?? true;
  const marketplaceId = creds.marketplaceId || 'ATVPDKIKX0DER';
  const mfnCacheKey = `${marketplaceId}:MFN`;

  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const result: BackfillMfnFeesResult = {
    eligible: 0, attempted: 0, estimated: 0, spApiEstimated: 0,
    fallbackWritten: 0, failed: 0, errors: [],
  };

  try {
    result.eligible = (db.prepare(`
      SELECT COUNT(DISTINCT ml.asin) AS cnt
      FROM merchant_listings ml
      LEFT JOIN fee_estimates_cache fec ON fec.asin = ml.asin AND fec.marketplace = ?
      WHERE ml.marketplace = 'amazon' AND ml.fulfillment_channel = 'DEFAULT'
        AND ml.asin IS NOT NULL AND ml.list_price_cents > 0 AND fec.asin IS NULL
    `).get(mfnCacheKey) as { cnt: number }).cnt;

    const eligibleRows = db.prepare(`
      SELECT ml.asin, MAX(ml.list_price_cents) AS list_price_cents, MAX(p.category) AS category
      FROM merchant_listings ml
      LEFT JOIN products p ON p.asin = ml.asin
      LEFT JOIN fee_estimates_cache fec ON fec.asin = ml.asin AND fec.marketplace = ?
      WHERE ml.marketplace = 'amazon' AND ml.fulfillment_channel = 'DEFAULT'
        AND ml.asin IS NOT NULL AND ml.list_price_cents > 0 AND fec.asin IS NULL
      GROUP BY ml.asin ORDER BY ml.asin LIMIT ?
    `).all(mfnCacheKey, limit) as { asin: string; list_price_cents: number; category: string | null }[];

    const upsertFallback = db.prepare(`
      INSERT INTO fee_estimates_cache (asin, marketplace, list_price_cents, fee_cents, referral_fee_cents, fba_fee_cents, estimated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asin, marketplace) DO UPDATE SET
        list_price_cents = excluded.list_price_cents, fee_cents = excluded.fee_cents,
        referral_fee_cents = excluded.referral_fee_cents, fba_fee_cents = excluded.fba_fee_cents,
        estimated_at = excluded.estimated_at
    `);

    for (let i = 0; i < eligibleRows.length; i++) {
      const row = eligibleRows[i];
      if (i > 0 && delayMs > 0) await delay(delayMs);
      result.attempted++;
      try {
        const est = await getFeesEstimate(creds, row.asin, row.list_price_cents, row.category, false);
        if (est.source === 'sp-api') { result.spApiEstimated++; result.estimated++; }      // getFeesEstimate cached it
        else if (est.source === 'cache') { result.estimated++; }
        else if (writeFallback) {                                                            // fallback — not auto-cached
          upsertFallback.run(row.asin, mfnCacheKey, row.list_price_cents, est.totalFeeCents, est.referralFeeCents, est.fbaFeeCents, new Date().toISOString());
          result.fallbackWritten++; result.estimated++;
        }
      } catch (err) {
        result.failed++;
        result.errors.push({ asin: row.asin, error: String(err) });
      }
    }
  } finally {
    db.close();
  }

  return result;
}
