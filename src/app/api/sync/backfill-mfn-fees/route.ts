/**
 * POST /api/sync/backfill-mfn-fees
 *
 * Backfills fee_estimates_cache for MFN (merchant-fulfilled) ASINs that have
 * no cached fee estimate. Calls SP-API for each eligible ASIN.
 *
 * Defaults: dryRun=true, limit=25, delayMs=250, writeFallback=false
 *
 * dryRun=true  → read-only; no SP-API calls; no cache writes; returns eligible count + samples
 * dryRun=false → calls SP-API for each eligible ASIN; writes cache on sp-api source;
 *                optionally writes fallback estimates when writeFallback=true
 *
 * Hard constraints:
 * - No schema changes
 * - No Amazon writes (read-only SP-API)
 * - Does not touch orders, FIFO, COGS, quantity_remaining, activation, or labels
 */

import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { getFeesEstimate } from '@/lib/sp-api/feesEstimate';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb(readonly = false) {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly });
  db.pragma('journal_mode = WAL');
  return db;
}

function getCredentials(db: InstanceType<typeof Database>): SPAPICredentials {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    clientId:      s.clientId      || '',
    clientSecret:  s.clientSecret  || '',
    refreshToken:  s.refreshToken  || '',
    marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
  };
}

interface EligibleRow {
  asin: string;
  list_price_cents: number;
  category: string | null;
}

interface SampleEntry {
  asin: string;
  list_price_cents: number;
  category: string | null;
}

interface ErrorEntry {
  asin: string;
  error: string;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest) {
  let body: { dryRun?: unknown; limit?: unknown; delayMs?: unknown; writeFallback?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine — use defaults
  }

  const dryRun      = body.dryRun      !== false; // default true
  const limit       = Math.min(Math.max(Number(body.limit)   || 25,  1), 200);
  const delayMs     = Math.max(Number(body.delayMs) || 250, 0);
  const writeFallback = body.writeFallback === true; // default false

  const db = getDb(dryRun); // read-only on dry run
  let creds: SPAPICredentials;
  try {
    creds = getCredentials(db);
  } catch (err) {
    db.close();
    return NextResponse.json({ error: `Failed to load credentials: ${err}` }, { status: 500 });
  }

  const marketplaceId = creds.marketplaceId || 'ATVPDKIKX0DER';
  const mfnCacheKey   = `${marketplaceId}:MFN`;

  // Count total eligible (before limit) for reporting
  const totalEligibleRow = db.prepare(`
    SELECT COUNT(DISTINCT ml.asin) AS cnt
    FROM merchant_listings ml
    LEFT JOIN fee_estimates_cache fec
      ON fec.asin = ml.asin AND fec.marketplace = ?
    WHERE ml.marketplace = 'amazon'
      AND ml.fulfillment_channel = 'DEFAULT'
      AND ml.asin IS NOT NULL
      AND ml.list_price_cents > 0
      AND fec.asin IS NULL
  `).get(mfnCacheKey) as { cnt: number };

  const totalEligible = totalEligibleRow?.cnt ?? 0;

  // Count ASINs already cached (skipped)
  const cachedRow = db.prepare(`
    SELECT COUNT(DISTINCT ml.asin) AS cnt
    FROM merchant_listings ml
    INNER JOIN fee_estimates_cache fec
      ON fec.asin = ml.asin AND fec.marketplace = ?
    WHERE ml.marketplace = 'amazon'
      AND ml.fulfillment_channel = 'DEFAULT'
      AND ml.asin IS NOT NULL
      AND ml.list_price_cents > 0
  `).get(mfnCacheKey) as { cnt: number };

  const skippedCached = cachedRow?.cnt ?? 0;

  // Eligible ASINs (deduped, limited)
  const eligibleRows = db.prepare(`
    SELECT ml.asin, MAX(ml.list_price_cents) AS list_price_cents, MAX(p.category) AS category
    FROM merchant_listings ml
    LEFT JOIN products p ON p.asin = ml.asin
    LEFT JOIN fee_estimates_cache fec
      ON fec.asin = ml.asin AND fec.marketplace = ?
    WHERE ml.marketplace = 'amazon'
      AND ml.fulfillment_channel = 'DEFAULT'
      AND ml.asin IS NOT NULL
      AND ml.list_price_cents > 0
      AND fec.asin IS NULL
    GROUP BY ml.asin
    ORDER BY ml.asin
    LIMIT ?
  `).all(mfnCacheKey, limit) as EligibleRow[];

  if (dryRun) {
    db.close();
    const samples: SampleEntry[] = eligibleRows.map(r => ({
      asin: r.asin,
      list_price_cents: r.list_price_cents,
      category: r.category,
    }));
    return NextResponse.json({
      dryRun: true,
      limit,
      delayMs,
      writeFallback,
      eligible: totalEligible,
      skippedCached,
      attempted: 0,
      estimated: 0,
      fallbackWritten: 0,
      failed: 0,
      samples,
      errors: [],
    });
  }

  // Live run — credentials required
  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
    db.close();
    return NextResponse.json(
      { error: 'Missing SP-API credentials. Go to Settings and enter your Client ID, Client Secret, and Refresh Token.' },
      { status: 400 }
    );
  }

  let spApiEstimated  = 0;
  let cacheHit        = 0;
  let fallbackReturned = 0;
  let fallbackWritten = 0;
  let fallbackSkipped = 0;
  let failed          = 0;
  const errors: ErrorEntry[] = [];

  for (let i = 0; i < eligibleRows.length; i++) {
    const row = eligibleRows[i];
    if (i > 0 && delayMs > 0) await delay(delayMs);

    try {
      const result = await getFeesEstimate(
        creds,
        row.asin,
        row.list_price_cents,
        row.category,
        false // MFN
      );

      if (result.source === 'sp-api') {
        // getFeesEstimate already called writeCache internally
        spApiEstimated++;
      } else if (result.source === 'cache') {
        // Already cached — should rarely happen since we filter these out, but
        // counts here if another concurrent process wrote it between our query and now
        cacheHit++;
      } else {
        // fallback — SP-API failed; no cache row written by getFeesEstimate
        fallbackReturned++;
        if (writeFallback) {
          // writeCache() is private in feesEstimate.ts — do our own upsert
          db.prepare(`
            INSERT INTO fee_estimates_cache (asin, marketplace, list_price_cents, fee_cents, referral_fee_cents, fba_fee_cents, estimated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(asin, marketplace) DO UPDATE SET
              list_price_cents    = excluded.list_price_cents,
              fee_cents           = excluded.fee_cents,
              referral_fee_cents  = excluded.referral_fee_cents,
              fba_fee_cents       = excluded.fba_fee_cents,
              estimated_at        = excluded.estimated_at
          `).run(
            row.asin,
            mfnCacheKey,
            row.list_price_cents,
            result.totalFeeCents,
            result.referralFeeCents,
            result.fbaFeeCents,
            new Date().toISOString()
          );
          fallbackWritten++;
        } else {
          fallbackSkipped++;
        }
      }
    } catch (err) {
      failed++;
      errors.push({ asin: row.asin, error: String(err) });
      console.error(`[backfill-mfn-fees] ASIN ${row.asin} failed:`, err);
    }
  }

  db.close();

  // estimated = rows where a usable cache-backed fee now exists
  const estimated = spApiEstimated + cacheHit + fallbackWritten;

  return NextResponse.json({
    dryRun: false,
    limit,
    delayMs,
    writeFallback,
    eligible: totalEligible,
    skippedCached,
    attempted: eligibleRows.length,
    estimated,
    spApiEstimated,
    cacheHit,
    fallbackReturned,
    fallbackWritten,
    fallbackSkipped,
    failed,
    errors,
  });
}
