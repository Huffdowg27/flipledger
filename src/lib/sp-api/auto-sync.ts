/**
 * Auto-sync scheduler — runs sync automatically every N hours.
 * Syncs BOTH Amazon and Walmart, plus generates recurring expenses.
 * Triggered on app startup via the Sidebar component.
 */

import { runFullSync, getSyncStatus } from './sync';
import { runWalmartSync, getWalmartSyncStatus } from '../walmart-api/sync';
import { getWalmartCredentials } from '../walmart-api/auth';
import { runEbaySync, getEbaySyncStatus } from '../ebay-api/sync';
import { getEbayCredentials } from '../ebay-api/auth';
import { syncFbaCustomerReturns } from './customerReturns';
import { syncSalesRanks } from './salesRank';
import { syncReimbursementCandidates } from './reimbursementCandidates';
import { syncReimbursementsReport } from './reimbursementsReport';
import { dedupAmazonReimbursements } from './dedupReimbursements';
import { syncAmazonDisputeCandidates } from './amazonDisputeCandidates';
import { syncWalmartDisputeCandidates } from '../walmart-api/disputeCandidates';
import { generateRecurringExpenses } from '../recurring-expenses';
import { recalculateFIFO } from '../fifo';
import { backfillMfnFees } from './backfillMfnFees';
import { backfillUpcs } from './backfillUpcs';
import type { SPAPICredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

let syncInterval: NodeJS.Timeout | null = null;
const SYNC_INTERVAL_HOURS = 1;
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // Check every 15 minutes
const LOOKBACK_DAYS = 14; // Sync last 2 weeks each run

// Per-job in-process lock — prevents two 15-min ticks from overlapping the same
// long-running report sync. Cleared on process restart (PM2 handles that).
const inFlight = new Set<string>();

/** Read-only snapshot of the in-process lock set, for /api/sync/status. */
export function getInFlightJobs(): string[] {
  return Array.from(inFlight);
}

// Hard timeout on each long-running async report sync. Prevents a hung Amazon
// report endpoint from permanently occupying the event loop.
const JOB_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }) as Promise<T>;
}

/**
 * Run a gated long-running sync job at most once per interval, with safety
 * rails to prevent the 15-min re-entry storm that previously wedged the app.
 *
 * Three guards stacked:
 *   1. In-process lock (`inFlight`) — second tick that finds the job already
 *      running just logs and returns.
 *   2. Attempt-timestamp persisted BEFORE running — so a thrown error (or a
 *      hard process kill) still throttles the next attempt for the full
 *      interval, not the next 15-min tick. This is the actual fix for the
 *      reimbursements-report re-entry storm.
 *   3. Hard timeout — wraps run() in Promise.race so a hung Amazon report
 *      endpoint cannot permanently occupy the event loop. Note: the underlying
 *      fetch is not cancellable, so the wrapped work may complete in the
 *      background; subsequent ticks could in theory overlap with it. That's
 *      still vastly better than the prior 15-min re-spam.
 */
async function runGatedSync(opts: {
  key: string;             // e.g. 'reimbursements_report_last_sync'
  intervalHours: number;
  label: string;           // human-readable, for logging
  run: () => Promise<unknown>;
}) {
  const { key, intervalHours, label, run } = opts;

  if (inFlight.has(key)) {
    console.log(`[AutoSync] ${label}: skipping (already in-flight)`);
    return;
  }

  const lastSync = getLastSyncTime(key);
  const lastAttempt = getLastSyncTime(key + '_attempted_at');
  const lastTouch = Math.max(lastSync, lastAttempt);
  if (hoursSince(lastTouch) < intervalHours) return;

  inFlight.add(key);
  setLastSyncTime(key + '_attempted_at', new Date().toISOString());

  try {
    await withTimeout(run(), JOB_TIMEOUT_MS, label);
    setLastSyncTime(key, new Date().toISOString());
  } catch (err) {
    console.error(`[AutoSync] ${label} error:`, err);
  } finally {
    inFlight.delete(key);
  }
}

// Customer returns report is async (60-120s per run) and data only changes
// after Amazon physically receives + processes returns. Daily is plenty —
// running hourly would block the auto-sync loop with no benefit.
const CUSTOMER_RETURNS_INTERVAL_HOURS = 24;
const CUSTOMER_RETURNS_LOOKBACK_DAYS = 90;

// Sales rank sync — daily. Each run touches ~150-300 active ASINs and
// takes 1-3 minutes (rate-limited by Catalog API). BSR doesn't change
// faster than daily for most products.
const SALES_RANK_INTERVAL_HOURS = 24;

// MFN fee backfill — daily safety net. On-demand pricing at receive time is the
// primary path; this catches merchant listings that were never manually scanned.
const MFN_FEES_BACKFILL_INTERVAL_HOURS = 24;

// MFN UPC backfill — daily. Fills products.upc from the Catalog API for ASINs on
// MFN orders, so new orders get UPCs without manual runs.
const MFN_UPCS_BACKFILL_INTERVAL_HOURS = 24;

// Reimbursement candidates — weekly. The FBA inventory adjustments report
// is async (60-120s) and inventory adjustments don't accumulate fast.
// Weekly is enough to catch them well within the 60-day claim window.
const REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS = 24 * 7;
const REIMBURSEMENT_CANDIDATES_LOOKBACK_DAYS = 90;

/**
 * Job metadata for the /sync status surface. Keep this in sync with autoSyncTick
 * — if a new gated job is added there, add its row here so the dashboard can
 * show it and the force-run button can target it.
 */
export const SYNC_JOB_REGISTRY = [
  {
    key: 'lastSync',
    label: 'Amazon — full sync',
    description: 'Orders, finances, inventory, catalog, settlement, listings',
    intervalHours: SYNC_INTERVAL_HOURS,
    runRoute: '/api/sync',
    method: 'POST',
    body: { lookbackDays: LOOKBACK_DAYS },
    family: 'amazon',
  },
  {
    key: 'walmart_last_sync',
    label: 'Walmart',
    description: 'Orders, returns, WFS inventory, recon reports',
    intervalHours: SYNC_INTERVAL_HOURS,
    runRoute: '/api/sync/walmart',
    method: 'POST',
    family: 'walmart',
  },
  {
    key: 'ebay_last_sync',
    label: 'eBay',
    description: 'Orders + finances',
    intervalHours: SYNC_INTERVAL_HOURS,
    runRoute: '/api/sync/ebay',
    method: 'POST',
    family: 'ebay',
  },
  {
    key: 'customer_returns_last_sync',
    label: 'FBA customer returns',
    description: 'Real return reason codes (DEFECTIVE, UNWANTED_ITEM, etc.)',
    intervalHours: CUSTOMER_RETURNS_INTERVAL_HOURS,
    runRoute: '/api/sync/customer-returns',
    method: 'POST',
    family: 'amazon',
  },
  {
    key: 'sales_rank_last_sync',
    label: 'Sales rank',
    description: 'BSR snapshot for every active ASIN',
    intervalHours: SALES_RANK_INTERVAL_HOURS,
    runRoute: '/api/sync/sales-rank',
    method: 'POST',
    family: 'amazon',
  },
  {
    key: 'reimbursements_report_last_sync',
    label: 'Reimbursements report',
    description: '18-month canonical record of every Amazon reimbursement',
    intervalHours: REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS,
    runRoute: '/api/sync/reimbursements-report',
    method: 'POST',
    family: 'amazon',
  },
  {
    key: 'reimbursement_candidates_last_sync',
    label: 'Reimbursement candidates',
    description: 'Lost/damaged inventory Amazon owes you (60-day claim window)',
    intervalHours: REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS,
    runRoute: '/api/sync/reimbursement-candidates',
    method: 'POST',
    family: 'amazon',
  },
  {
    key: 'merchant_listings_last_sync',
    label: 'Merchant listings',
    description: 'Seller Central listing status, qty, price (powers MFN freshness)',
    intervalHours: SYNC_INTERVAL_HOURS,
    runRoute: '/api/sync/merchant-listings',
    method: 'POST',
    family: 'amazon',
    note: 'Also runs automatically as step 5b of every Amazon sync.',
  },
] as const;

export type SyncJobRegistryEntry = (typeof SYNC_JOB_REGISTRY)[number];

function getAmazonCredentials(): SPAPICredentials | null {
  try {
    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    db.close();

    const settings: Record<string, string> = {};
    for (const row of rows) settings[row.key] = row.value;

    if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;

    return {
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      refreshToken: settings.refreshToken,
      marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
    };
  } catch {
    return null;
  }
}

function getLastSyncTime(key: string): number {
  try {
    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    db.close();
    return row?.value ? new Date(row.value).getTime() : 0;
  } catch {
    return 0;
  }
}

function hoursSince(timestamp: number): number {
  return (Date.now() - timestamp) / 3600000;
}

function setLastSyncTime(key: string, value: string) {
  try {
    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
    db.close();
  } catch (err) {
    console.error(`[AutoSync] setLastSyncTime(${key}) failed:`, err);
  }
}

async function autoSyncTick() {
  // Amazon sync
  const amazonStatus = getSyncStatus();
  const walmartStatus = getWalmartSyncStatus();
  const ebayStatus = getEbaySyncStatus();

  if (amazonStatus?.running || walmartStatus?.running || ebayStatus?.running) {
    console.log('[AutoSync] Sync already running, skipping');
    return;
  }

  const amazonLastSync = getLastSyncTime('lastSync');
  const amazonLastAttempt = getLastSyncTime('lastSync_attempted_at');
  const walmartLastSync = getLastSyncTime('walmart_last_sync');
  const walmartLastAttempt = getLastSyncTime('walmart_last_sync_attempted_at');

  // Amazon — gated on max(last success, last attempt) so a crashed mid-sync
  // process can't re-fire the next tick. We DO NOT wrap in withTimeout because
  // the underlying SP-API fetches aren't cancellable; a fired timeout that
  // cleared currentSync.running would let the very next tick start a parallel
  // runFullSync writing to the same tables. The in-process currentSync.running
  // guard above is the only safe overlap-prevention while a sync is alive in
  // this process; attempted_at extends that to survive a crash/restart.
  if (hoursSince(Math.max(amazonLastSync, amazonLastAttempt)) >= SYNC_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log(`[AutoSync] Starting Amazon sync (last ${LOOKBACK_DAYS} days)`);
      setLastSyncTime('lastSync_attempted_at', new Date().toISOString());
      try {
        await runFullSync(amazonCreds, LOOKBACK_DAYS);
        setLastSyncTime('lastSync', new Date().toISOString());
        console.log('[AutoSync] Amazon sync complete');
      } catch (err) {
        console.error('[AutoSync] Amazon error:', err);
      }
    }
  }

  // Amazon FBA Customer Returns (daily) — populates real reason codes on
  // refunds (DEFECTIVE, UNWANTED_ITEM, etc.) from the Reports API. Financial
  // Events API doesn't provide these, so this is the only way to get them.
  // Skipped if the Amazon sync isn't configured — no point otherwise.
  {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      await runGatedSync({
        key: 'customer_returns_last_sync',
        intervalHours: CUSTOMER_RETURNS_INTERVAL_HOURS,
        label: 'FBA customer returns sync',
        run: async () => {
          console.log(`[AutoSync] Starting FBA customer returns sync (last ${CUSTOMER_RETURNS_LOOKBACK_DAYS} days)`);
          const end = new Date().toISOString();
          const start = new Date(Date.now() - CUSTOMER_RETURNS_LOOKBACK_DAYS * 86400000).toISOString();
          const result = await syncFbaCustomerReturns(amazonCreds, start, end);
          console.log(
            `[AutoSync] Customer returns: ${result.reportRows} rows, ${result.refundsUpdated} refunds updated, ${result.unmatched} unmatched`
          );
        },
      });
    }
  }

  // Amazon dispute candidates (SAFE-T) — re-classify after refund reasons
  // and reimbursements have been refreshed. Pure SQL, runs in milliseconds.
  try {
    const result = syncAmazonDisputeCandidates();
    if (result.newEligible > 0 || result.newMaybe > 0) {
      console.log(`[AutoSync] Amazon disputes: ${result.scanned} refunds scanned, ${result.newEligible} new eligible, ${result.newMaybe} maybe`);
    }
  } catch (err) {
    console.error('[AutoSync] Amazon disputes error:', err);
  }

  // Amazon Sales Rank (daily) — snapshots BSR for every active ASIN.
  // Used by Inventory Valuation + SKU Profitability for trend tracking.
  {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      await runGatedSync({
        key: 'sales_rank_last_sync',
        intervalHours: SALES_RANK_INTERVAL_HOURS,
        label: 'Sales rank sync',
        run: async () => {
          console.log('[AutoSync] Starting sales rank sync');
          const result = await syncSalesRanks(amazonCreds);
          console.log(
            `[AutoSync] Sales rank: ${result.asinsChecked} ASINs checked, ${result.asinsUpdated} updated, ${result.errors} errors`
          );
        },
      });
    }
  }

  // MFN fee backfill (daily safety net) — pre-fills fee_estimates_cache for any
  // merchant-fulfilled ASIN not yet priced, so listings never manually scanned
  // still show fee/margin. On-demand pricing at receive time is the primary path.
  {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      await runGatedSync({
        key: 'mfn_fees_backfill_last_sync',
        intervalHours: MFN_FEES_BACKFILL_INTERVAL_HOURS,
        label: 'MFN fee backfill',
        run: async () => {
          console.log('[AutoSync] Starting MFN fee backfill (catch-up sweep)');
          const result = await backfillMfnFees(amazonCreds, { limit: 100, delayMs: 300, writeFallback: true });
          console.log(
            `[AutoSync] MFN fee backfill: ${result.eligible} eligible, ${result.attempted} attempted, ${result.estimated} priced (${result.spApiEstimated} sp-api, ${result.fallbackWritten} fallback), ${result.failed} failed`
          );
        },
      });
    }
  }

  // MFN UPC backfill (daily) — fills products.upc from the Catalog API for ASINs
  // on MFN orders, so new orders get UPCs (shown on /mfn/orders) hands-free.
  {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      await runGatedSync({
        key: 'mfn_upcs_backfill_last_sync',
        intervalHours: MFN_UPCS_BACKFILL_INTERVAL_HOURS,
        label: 'MFN UPC backfill',
        run: async () => {
          console.log('[AutoSync] Starting MFN UPC backfill');
          const result = await backfillUpcs(amazonCreds, { limit: 100, delayMs: 300 });
          console.log(
            `[AutoSync] MFN UPC backfill: ${result.eligible} eligible, ${result.attempted} attempted, ${result.found} found, ${result.missing} none, ${result.failed} failed`
          );
        },
      });
    }
  }

  // FBA Reimbursements Report (weekly) — pulls the canonical record of
  // every reimbursement Amazon has paid. Must run BEFORE reimbursement
  // candidates so the matcher sees the latest paid claims and doesn't
  // surface "pending" for things Amazon already paid.
  {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      await runGatedSync({
        key: 'reimbursements_report_last_sync',
        intervalHours: REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS,
        label: 'Reimbursements report sync',
        run: async () => {
          console.log('[AutoSync] Starting reimbursements report sync (18-month window)');
          const end = new Date().toISOString();
          const start = new Date(Date.now() - 540 * 86400000).toISOString();
          const result = await syncReimbursementsReport(amazonCreds, start, end);
          console.log(
            `[AutoSync] Reimbursements report: ${result.reportRows} rows, ${result.inserted} inserted, ${result.updated} updated, $${(result.totalAmountCents / 100).toFixed(2)} total`
          );
          // Sweep any ADJ/SETTLEMENT placeholders the new canonical rows supersede.
          dedupAmazonReimbursements();
        },
      });
    }
  }

  // Reimbursement candidates (weekly) — pulls FBA inventory adjustments
  // report and matches against existing reimbursements. Surfaces dollars
  // Amazon owes for lost/damaged warehouse inventory that haven't been
  // refunded yet, with a 60-day claim window.
  {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      await runGatedSync({
        key: 'reimbursement_candidates_last_sync',
        intervalHours: REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS,
        label: 'Reimbursement candidates sync',
        run: async () => {
          console.log(`[AutoSync] Starting reimbursement candidates sync (last ${REIMBURSEMENT_CANDIDATES_LOOKBACK_DAYS} days)`);
          const end = new Date().toISOString();
          const start = new Date(Date.now() - REIMBURSEMENT_CANDIDATES_LOOKBACK_DAYS * 86400000).toISOString();
          const result = await syncReimbursementCandidates(amazonCreds, start, end);
          console.log(
            `[AutoSync] Reimbursement candidates: ${result.reportRows} rows, ${result.reimbursableRows} reimbursable, ${result.newCandidates} new, ${result.alreadyReimbursed} already paid`
          );
        },
      });
    }
  }

  // Walmart — same attempted_at gate as Amazon
  if (hoursSince(Math.max(walmartLastSync, walmartLastAttempt)) >= SYNC_INTERVAL_HOURS) {
    const walmartCreds = getWalmartCredentials();
    if (walmartCreds) {
      console.log(`[AutoSync] Starting Walmart sync (last ${LOOKBACK_DAYS} days)`);
      setLastSyncTime('walmart_last_sync_attempted_at', new Date().toISOString());
      try {
        await runWalmartSync(walmartCreds, LOOKBACK_DAYS);
        setLastSyncTime('walmart_last_sync', new Date().toISOString());
        console.log('[AutoSync] Walmart sync complete');
      } catch (err) {
        console.error('[AutoSync] Walmart error:', err);
      }

      // After Walmart returns are refreshed, re-classify dispute candidates.
      // Pure SQL — runs in milliseconds, no API call.
      try {
        const result = syncWalmartDisputeCandidates();
        console.log(
          `[AutoSync] Walmart disputes: ${result.scanned} refunds scanned, ${result.newEligible} new eligible, ${result.expired} expired`
        );
      } catch (err) {
        console.error('[AutoSync] Walmart disputes error:', err);
      }
    }
  }

  // eBay — same attempted_at gate
  const ebayLastSync = getLastSyncTime('ebay_last_sync');
  const ebayLastAttempt = getLastSyncTime('ebay_last_sync_attempted_at');
  if (hoursSince(Math.max(ebayLastSync, ebayLastAttempt)) >= SYNC_INTERVAL_HOURS) {
    const ebayCreds = getEbayCredentials();
    if (ebayCreds) {
      console.log(`[AutoSync] Starting eBay sync (last ${LOOKBACK_DAYS} days)`);
      setLastSyncTime('ebay_last_sync_attempted_at', new Date().toISOString());
      try {
        await runEbaySync(ebayCreds, LOOKBACK_DAYS);
        setLastSyncTime('ebay_last_sync', new Date().toISOString());
        console.log('[AutoSync] eBay sync complete');
      } catch (err) {
        console.error('[AutoSync] eBay error:', err);
      }
    }
  }

  // Generate any new recurring expenses
  try {
    const result = generateRecurringExpenses();
    if (result.generated > 0) {
      console.log(`[AutoSync] Generated ${result.generated} recurring expense entries`);
    }
  } catch (err) {
    console.error('[AutoSync] Recurring expenses error:', err);
  }

  // Recalculate FIFO COGS for any new orders
  try {
    const fifoResult = recalculateFIFO({ recalcAll: true });
    if (fifoResult.itemsUpdated > 0) {
      console.log(`[AutoSync] FIFO: updated ${fifoResult.itemsUpdated} items across ${fifoResult.skusProcessed} SKUs`);
    }
  } catch (err) {
    console.error('[AutoSync] FIFO error:', err);
  }
}

export function startAutoSync() {
  if (syncInterval) return; // Already running

  console.log(`[AutoSync] Starting auto-sync scheduler (every ${SYNC_INTERVAL_HOURS}h, checking every 15min, ${LOOKBACK_DAYS}-day lookback)`);

  // Run first sync after 10 seconds (give the app time to start)
  setTimeout(() => {
    autoSyncTick();
  }, 10000);

  // Check every 15 minutes if a sync is needed
  syncInterval = setInterval(() => {
    autoSyncTick();
  }, CHECK_INTERVAL_MS);
}

export function stopAutoSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    console.log('[AutoSync] Stopped');
  }
}
