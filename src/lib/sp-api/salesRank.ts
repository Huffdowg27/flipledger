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

interface CatalogSalesRanksResponse {
  asin?: string;
  salesRanks?: Array<{
    marketplaceId?: string;
    classificationRanks?: Array<{ classificationId?: string; title?: string; link?: string; rank?: number }>;
    displayGroupRanks?: Array<{ websiteDisplayGroup?: string; title?: string; link?: string; rank?: number }>;
  }>;
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

/**
 * Fetch sales ranks for a single ASIN. Returns the top-level rank
 * (the highest-priority displayGroupRank) plus its category title.
 */
export async function fetchSalesRank(
  credentials: SPAPICredentials,
  asin: string
): Promise<{ rank: number | null; category: string | null }> {
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
    if (!ranks) return { rank: null, category: null };

    // Prefer displayGroupRanks (top-level "Toys & Games", "Electronics") over
    // classificationRanks (the deep-tree leaves like "Toys & Games > Action
    // Figures > Vehicles"). Display group is what shoppers see.
    const display = ranks.displayGroupRanks?.[0];
    if (display && typeof display.rank === 'number') {
      return { rank: display.rank, category: display.title || null };
    }
    const classification = ranks.classificationRanks?.[0];
    if (classification && typeof classification.rank === 'number') {
      return { rank: classification.rank, category: classification.title || null };
    }
    return { rank: null, category: null };
  } catch (err) {
    // ASIN not found, suppressed, etc. — skip silently
    console.warn(`[salesRank] ${asin} fetch failed: ${err}`);
    return { rank: null, category: null };
  }
}

/**
 * Sync sales ranks for every active ASIN. Called from auto-sync daily.
 * Returns counts.
 */
export async function syncSalesRanks(credentials: SPAPICredentials): Promise<{
  asinsChecked: number;
  asinsUpdated: number;
  errors: number;
}> {
  const db = getDb();
  let asinsUpdated = 0;
  let errors = 0;

  const activeSince = new Date(Date.now() - ACTIVE_LOOKBACK_DAYS * 86400000).toISOString();

  // Active ASINs = anything in live_inventory with stock OR sold recently
  const activeAsins = db
    .prepare(
      `
      SELECT DISTINCT asin FROM (
        SELECT asin FROM live_inventory WHERE asin IS NOT NULL AND asin != '' AND fulfillable_qty > 0
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
    `
    )
    .all(activeSince) as { asin: string }[];

  const insert = db.prepare(`
    INSERT INTO sales_rank_history (asin, marketplace, category, rank, captured_date, captured_at)
    VALUES (?, 'amazon', ?, ?, date('now'), datetime('now'))
    ON CONFLICT(asin, marketplace, captured_date) DO UPDATE SET
      category = excluded.category,
      rank = excluded.rank,
      captured_at = excluded.captured_at
  `);

  for (const { asin } of activeAsins) {
    try {
      const { rank, category } = await fetchSalesRank(credentials, asin);
      if (rank !== null) {
        insert.run(asin, category, rank);
        asinsUpdated++;
      }
    } catch (err) {
      errors++;
      console.warn(`[salesRank] ${asin} failed: ${err}`);
    }
    await sleep(SLEEP_MS_BETWEEN_CALLS);
  }

  db.close();
  return { asinsChecked: activeAsins.length, asinsUpdated, errors };
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
