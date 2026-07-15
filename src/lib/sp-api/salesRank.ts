/**
 * Sales rank (BSR) sync. Hits Catalog Items 2022-04-01 with
 * `includedData=salesRanks` for each active ASIN, stores one snapshot
 * per ASIN per day in `sales_rank_history`.
 *
 * Active ASINs = anything with non-zero stock in `live_inventory`
 * OR sold within the last 90 days.
 *
 * Rate limit: Catalog Items API allows ~2 req/sec (burst 10). We
 * sleep 600ms between calls to stay well under the bucket.
 */
import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

const SLEEP_MS_BETWEEN_CALLS = 600;
const ACTIVE_LOOKBACK_DAYS = 90;
const DEFAULT_MAX_RUN_MS = 7 * 60 * 1000;

interface CatalogSalesRanksResponse {
  asin?: string;
  salesRanks?: Array<{
    marketplaceId?: string;
    classificationRanks?: Array<{ classificationId?: string; title?: string; link?: string; rank?: number }>;
    displayGroupRanks?: Array<{ websiteDisplayGroup?: string; title?: string; link?: string; rank?: number }>;
  }>;
}

type SalesRankFetchResult = {
  rank: number | null;
  category: string | null;
  status?: 'ok' | 'notFound' | 'noRank' | 'error';
};

type NowProvider = Date | (() => Date);

interface SalesRankSyncOptions {
  db?: Database.Database;
  closeDb?: boolean;
  maxAsins?: number;
  maxRunMs?: number;
  sleepMs?: number;
  now?: NowProvider;
  fetchRank?: (credentials: SPAPICredentials, asin: string) => Promise<SalesRankFetchResult>;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface SalesRankSyncResult {
  asinsChecked: number;
  asinsUpdated: number;
  errors: number;
  asinsEligible: number;
  asinsSkippedToday: number;
  asinsAttempted: number;
  asinsDeferred: number;
  asinsNotFound: number;
  asinsWithoutRank: number;
  elapsedMs: number;
  stoppedReason: 'complete' | 'maxAsins' | 'timeBudget';
}

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentDate(now: NowProvider | undefined): Date {
  if (typeof now === 'function') return now();
  return now || new Date();
}

function capturedDateKey(now: NowProvider | undefined): string {
  return currentDate(now).toISOString().slice(0, 10);
}

/**
 * Fetch sales ranks for a single ASIN. Returns the top-level rank
 * (the highest-priority displayGroupRank) plus its category title.
 */
export async function fetchSalesRank(
  credentials: SPAPICredentials,
  asin: string
): Promise<SalesRankFetchResult> {
  try {
    const response = (await spApiRequest(
      credentials,
      `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`,
      {
        marketplaceIds: credentials.marketplaceId,
        includedData: 'salesRanks',
      }
    )) as CatalogSalesRanksResponse;

    const ranks = response?.salesRanks?.[0];
    if (!ranks) return { rank: null, category: null, status: 'noRank' };

    // Prefer displayGroupRanks (top-level "Toys & Games", "Electronics") over
    // classificationRanks (the deep-tree leaves like "Toys & Games > Action
    // Figures > Vehicles"). Display group is what shoppers see.
    const display = ranks.displayGroupRanks?.[0];
    if (display && typeof display.rank === 'number') {
      return { rank: display.rank, category: display.title || null, status: 'ok' };
    }
    const classification = ranks.classificationRanks?.[0];
    if (classification && typeof classification.rank === 'number') {
      return { rank: classification.rank, category: classification.title || null, status: 'ok' };
    }
    return { rank: null, category: null, status: 'noRank' };
  } catch (err) {
    // ASIN not found, suppressed, etc. — skip silently
    console.warn(`[salesRank] ${asin} fetch failed: ${err}`);
    const status = String(err).includes('SP-API 404') ? 'notFound' : 'error';
    return { rank: null, category: null, status };
  }
}

/**
 * Sync sales ranks for every active ASIN. Called from auto-sync daily.
 * Returns counts.
 */
export async function syncSalesRanks(
  credentials: SPAPICredentials,
  options: SalesRankSyncOptions = {}
): Promise<SalesRankSyncResult> {
  const db = options.db || getDb();
  const closeDb = options.closeDb ?? !options.db;
  const logger = options.logger || console;
  const fetchRank = options.fetchRank || fetchSalesRank;
  const sleepMs = options.sleepMs ?? SLEEP_MS_BETWEEN_CALLS;
  const maxRunMs = options.maxRunMs ?? DEFAULT_MAX_RUN_MS;
  const startedAt = currentDate(options.now).getTime();
  const capturedDate = capturedDateKey(options.now);
  const capturedAt = currentDate(options.now).toISOString();

  let asinsUpdated = 0;
  let errors = 0;
  let asinsAttempted = 0;
  let asinsNotFound = 0;
  let asinsWithoutRank = 0;
  let stoppedReason: SalesRankSyncResult['stoppedReason'] = 'complete';

  const activeSince = new Date(currentDate(options.now).getTime() - ACTIVE_LOOKBACK_DAYS * 86400000).toISOString();

  // Active ASINs = anything in live_inventory with stock OR sold recently
  const activeAsins = db.prepare(`
    SELECT
      active.asin,
      CASE WHEN today.asin IS NULL THEN 0 ELSE 1 END AS captured_today
    FROM (
      SELECT DISTINCT asin FROM (
        SELECT asin
        FROM live_inventory
        WHERE asin IS NOT NULL AND asin != '' AND fulfillable_qty > 0
        UNION
        SELECT DISTINCT oi.asin
        FROM order_items oi
        INNER JOIN orders o ON o.order_id = oi.order_id
        WHERE oi.asin IS NOT NULL AND oi.asin != ''
          AND o.purchase_date >= ?
          AND o.marketplace = 'amazon'
      )
      WHERE asin LIKE 'B0%' OR asin LIKE 'B1%' OR asin LIKE 'B2%' OR asin LIKE 'B3%'
        OR length(asin) = 10
    ) active
    LEFT JOIN sales_rank_history today
      ON today.asin = active.asin
     AND today.marketplace = 'amazon'
     AND today.captured_date = ?
    ORDER BY active.asin
  `).all(activeSince, capturedDate) as { asin: string; captured_today: 0 | 1 }[];

  const candidates = activeAsins.filter((row) => row.captured_today === 0);
  const asinsSkippedToday = activeAsins.length - candidates.length;

  const insert = db.prepare(`
    INSERT INTO sales_rank_history (asin, marketplace, category, rank, captured_date, captured_at)
    VALUES (?, 'amazon', ?, ?, ?, ?)
    ON CONFLICT(asin, marketplace, captured_date) DO UPDATE SET
      category = excluded.category,
      rank = excluded.rank,
      captured_at = excluded.captured_at
  `);

  for (const { asin } of candidates) {
    if (options.maxAsins !== undefined && asinsAttempted >= options.maxAsins) {
      stoppedReason = 'maxAsins';
      break;
    }
    if (maxRunMs > 0 && currentDate(options.now).getTime() - startedAt >= maxRunMs) {
      stoppedReason = 'timeBudget';
      break;
    }

    try {
      asinsAttempted++;
      const { rank, category, status } = await fetchRank(credentials, asin);
      if (rank !== null) {
        insert.run(asin, category, rank, capturedDate, capturedAt);
        asinsUpdated++;
      } else if (status === 'notFound') {
        asinsNotFound++;
      } else if (status === 'error') {
        errors++;
      } else {
        asinsWithoutRank++;
      }
    } catch (err) {
      errors++;
      logger.warn(`[salesRank] ${asin} failed: ${err}`);
    }

    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }

  const asinsDeferred = candidates.length - asinsAttempted;
  const elapsedMs = currentDate(options.now).getTime() - startedAt;
  logger.log(
    `[salesRank] eligible=${activeAsins.length} skipped_today=${asinsSkippedToday} attempted=${asinsAttempted} ` +
    `updated=${asinsUpdated} not_found=${asinsNotFound} no_rank=${asinsWithoutRank} errors=${errors} ` +
    `deferred=${asinsDeferred} stopped=${stoppedReason} elapsed_ms=${elapsedMs}`
  );

  if (closeDb) db.close();
  return {
    asinsChecked: asinsAttempted,
    asinsUpdated,
    errors,
    asinsEligible: activeAsins.length,
    asinsSkippedToday,
    asinsAttempted,
    asinsDeferred,
    asinsNotFound,
    asinsWithoutRank,
    elapsedMs,
    stoppedReason,
  };
}

/**
 * Read helper for the UI: latest rank + 7d/30d delta per ASIN.
 */
export function getLatestSalesRank(asin: string): {
  current: number | null;
  category: string | null;
  capturedDate: string | null;
  delta7d: number | null;
  delta30d: number | null;
} {
  const db = getDb();
  try {
    const latest = db
      .prepare(
        `SELECT rank, category, captured_date FROM sales_rank_history
         WHERE asin = ? AND marketplace = 'amazon'
         ORDER BY captured_date DESC LIMIT 1`
      )
      .get(asin) as { rank: number | null; category: string | null; captured_date: string } | undefined;
    if (!latest) return { current: null, category: null, capturedDate: null, delta7d: null, delta30d: null };

    const delta7Row = db
      .prepare(
        `SELECT rank FROM sales_rank_history
         WHERE asin = ? AND captured_date <= date('now','-7 days')
         ORDER BY captured_date DESC LIMIT 1`
      )
      .get(asin) as { rank: number | null } | undefined;
    const delta30Row = db
      .prepare(
        `SELECT rank FROM sales_rank_history
         WHERE asin = ? AND captured_date <= date('now','-30 days')
         ORDER BY captured_date DESC LIMIT 1`
      )
      .get(asin) as { rank: number | null } | undefined;

    const delta7d = delta7Row?.rank && latest.rank ? latest.rank - delta7Row.rank : null;
    const delta30d = delta30Row?.rank && latest.rank ? latest.rank - delta30Row.rank : null;

    return {
      current: latest.rank,
      category: latest.category,
      capturedDate: latest.captured_date,
      delta7d,
      delta30d,
    };
  } finally {
    db.close();
  }
}
