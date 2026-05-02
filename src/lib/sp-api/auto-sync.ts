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
import type { SPAPICredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

let syncInterval: NodeJS.Timeout | null = null;
const SYNC_INTERVAL_HOURS = 1;
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // Check every 15 minutes
const LOOKBACK_DAYS = 14; // Sync last 2 weeks each run

// Customer returns report is async (60-120s per run) and data only changes
// after Amazon physically receives + processes returns. Daily is plenty —
// running hourly would block the auto-sync loop with no benefit.
const CUSTOMER_RETURNS_INTERVAL_HOURS = 24;
const CUSTOMER_RETURNS_LOOKBACK_DAYS = 90;

// Sales rank sync — daily. Each run touches ~150-300 active ASINs and
// takes 1-3 minutes (rate-limited by Catalog API). BSR doesn't change
// faster than daily for most products.
const SALES_RANK_INTERVAL_HOURS = 24;

// Reimbursement candidates — weekly. The FBA inventory adjustments report
// is async (60-120s) and inventory adjustments don't accumulate fast.
// Weekly is enough to catch them well within the 60-day claim window.
const REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS = 24 * 7;
const REIMBURSEMENT_CANDIDATES_LOOKBACK_DAYS = 90;

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
  const walmartLastSync = getLastSyncTime('walmart_last_sync');

  // Amazon
  if (hoursSince(amazonLastSync) >= SYNC_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log(`[AutoSync] Starting Amazon sync (last ${LOOKBACK_DAYS} days)`);
      try {
        await runFullSync(amazonCreds, LOOKBACK_DAYS);
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
  const customerReturnsLastSync = getLastSyncTime('customer_returns_last_sync');
  if (hoursSince(customerReturnsLastSync) >= CUSTOMER_RETURNS_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log(`[AutoSync] Starting FBA customer returns sync (last ${CUSTOMER_RETURNS_LOOKBACK_DAYS} days)`);
      try {
        const end = new Date().toISOString();
        const start = new Date(Date.now() - CUSTOMER_RETURNS_LOOKBACK_DAYS * 86400000).toISOString();
        const result = await syncFbaCustomerReturns(amazonCreds, start, end);
        setLastSyncTime('customer_returns_last_sync', new Date().toISOString());
        console.log(
          `[AutoSync] Customer returns: ${result.reportRows} rows, ${result.refundsUpdated} refunds updated, ${result.unmatched} unmatched`
        );
      } catch (err) {
        console.error('[AutoSync] Customer returns error:', err);
      }
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
  const salesRankLastSync = getLastSyncTime('sales_rank_last_sync');
  if (hoursSince(salesRankLastSync) >= SALES_RANK_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log('[AutoSync] Starting sales rank sync');
      try {
        const result = await syncSalesRanks(amazonCreds);
        setLastSyncTime('sales_rank_last_sync', new Date().toISOString());
        console.log(
          `[AutoSync] Sales rank: ${result.asinsChecked} ASINs checked, ${result.asinsUpdated} updated, ${result.errors} errors`
        );
      } catch (err) {
        console.error('[AutoSync] Sales rank error:', err);
      }
    }
  }

  // FBA Reimbursements Report (weekly) — pulls the canonical record of
  // every reimbursement Amazon has paid. Must run BEFORE reimbursement
  // candidates so the matcher sees the latest paid claims and doesn't
  // surface "pending" for things Amazon already paid.
  const reimbursementsReportLastSync = getLastSyncTime('reimbursements_report_last_sync');
  if (hoursSince(reimbursementsReportLastSync) >= REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log('[AutoSync] Starting reimbursements report sync (18-month window)');
      try {
        const end = new Date().toISOString();
        const start = new Date(Date.now() - 540 * 86400000).toISOString();
        const result = await syncReimbursementsReport(amazonCreds, start, end);
        setLastSyncTime('reimbursements_report_last_sync', new Date().toISOString());
        console.log(
          `[AutoSync] Reimbursements report: ${result.reportRows} rows, ${result.inserted} inserted, ${result.updated} updated, $${(result.totalAmountCents / 100).toFixed(2)} total`
        );
        // Sweep any ADJ/SETTLEMENT placeholders the new canonical rows supersede.
        dedupAmazonReimbursements();
      } catch (err) {
        console.error('[AutoSync] Reimbursements report error:', err);
      }
    }
  }

  // Reimbursement candidates (weekly) — pulls FBA inventory adjustments
  // report and matches against existing reimbursements. Surfaces dollars
  // Amazon owes for lost/damaged warehouse inventory that haven't been
  // refunded yet, with a 60-day claim window.
  const reimbursementCandidatesLastSync = getLastSyncTime('reimbursement_candidates_last_sync');
  if (hoursSince(reimbursementCandidatesLastSync) >= REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log(`[AutoSync] Starting reimbursement candidates sync (last ${REIMBURSEMENT_CANDIDATES_LOOKBACK_DAYS} days)`);
      try {
        const end = new Date().toISOString();
        const start = new Date(Date.now() - REIMBURSEMENT_CANDIDATES_LOOKBACK_DAYS * 86400000).toISOString();
        const result = await syncReimbursementCandidates(amazonCreds, start, end);
        setLastSyncTime('reimbursement_candidates_last_sync', new Date().toISOString());
        console.log(
          `[AutoSync] Reimbursement candidates: ${result.reportRows} rows, ${result.reimbursableRows} reimbursable, ${result.newCandidates} new, ${result.alreadyReimbursed} already paid`
        );
      } catch (err) {
        console.error('[AutoSync] Reimbursement candidates error:', err);
      }
    }
  }

  // Walmart
  if (hoursSince(walmartLastSync) >= SYNC_INTERVAL_HOURS) {
    const walmartCreds = getWalmartCredentials();
    if (walmartCreds) {
      console.log(`[AutoSync] Starting Walmart sync (last ${LOOKBACK_DAYS} days)`);
      try {
        await runWalmartSync(walmartCreds, LOOKBACK_DAYS);
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

  // eBay
  const ebayLastSync = getLastSyncTime('ebay_last_sync');
  if (hoursSince(ebayLastSync) >= SYNC_INTERVAL_HOURS) {
    const ebayCreds = getEbayCredentials();
    if (ebayCreds) {
      console.log(`[AutoSync] Starting eBay sync (last ${LOOKBACK_DAYS} days)`);
      try {
        await runEbaySync(ebayCreds, LOOKBACK_DAYS);
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
