/**
 * Sync orchestrator — coordinates all SP-API data pulls.
 * Called by the /api/sync route.
 */

import { syncFinancialEvents, resetServiceFeeTracker } from './finances';
import { dedupAmazonReimbursements } from './dedupReimbursements';
import { syncOrders, reconcileOpenOrders } from './orders';
import { syncFBAInventory } from './inventory';
import { enrichProductCatalog } from './catalog';
import { syncSettlementReports } from './reports';
import { syncMerchantListings } from './merchantListings';
import { syncSalesTrafficDaily } from './salesTraffic';
import { estimateAndBackfillFees, overrideEstimatedFees } from './fee-estimator';
import { generateRecurringExpenses } from '../recurring-expenses';
import type { SPAPICredentials, SyncResult, SyncStatus } from './types';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

let currentSync: SyncStatus | null = null;

export function getSyncStatus(): SyncStatus | null {
  return currentSync;
}

/**
 * Run a full data sync.
 * Pulls: financial events, orders, inventory, product catalog.
 * Default lookback: 90 days from now.
 */
export async function runFullSync(
  credentials: SPAPICredentials,
  lookbackDays: number = 90,
  explicitStartDate?: string,
  explicitEndDate?: string
): Promise<SyncStatus> {
  if (currentSync?.running) {
    throw new Error('Sync already in progress');
  }

  const startDate = explicitStartDate || new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const endDate = explicitEndDate || undefined;
  const now = new Date().toISOString();

  currentSync = {
    running: true,
    results: [],
    totalErrors: [],
    startedAt: now,
  };

  const db = getDb();

  // Log sync start
  const logResult = db.prepare(`
    INSERT INTO sync_log (sync_type, started_at, status)
    VALUES ('full', ?, 'running')
  `).run(now);
  const syncLogId = Number(logResult.lastInsertRowid);
  db.close();

  let totalRecords = 0;

  try {
    // 1. Orders FIRST — gets correct purchase dates
    console.log('[Sync] Starting orders sync...');
    const ordStart = Date.now();
    const ordResult = await syncOrders(credentials, startDate, endDate);
    const ordSyncResult: SyncResult = {
      syncType: 'orders',
      recordsFetched: ordResult.ordersProcessed,
      errors: ordResult.errors,
      duration: Date.now() - ordStart,
    };
    currentSync.results.push(ordSyncResult);
    totalRecords += ordResult.ordersProcessed;
    console.log(`[Sync] Orders: ${ordResult.ordersProcessed} orders, ${ordResult.errors.length} errors`);

    // 1a. Reconcile open orders — catch cancellations the incremental window misses.
    // The CreatedAfter sync only returns Pending/Unshipped/PartiallyShipped/Shipped,
    // so an older order canceled later would otherwise stay "open" forever locally.
    const recStart = Date.now();
    const recResult = await reconcileOpenOrders(credentials);
    currentSync.results.push({
      syncType: 'reconcile_open_orders',
      recordsFetched: recResult.updated,
      errors: recResult.errors,
      duration: Date.now() - recStart,
    });
    console.log(`[Sync] Reconcile: checked ${recResult.checked} open orders, ${recResult.updated} updated (${recResult.canceled} canceled), ${recResult.errors.length} errors`);

    // 1b. Sales & Traffic — Seller Central-style ordered sales pulse for today.
    // This fills the same-day dashboard gap where pending orders hide item detail.
    const pulseStart = Date.now();
    const pulseSyncResult: SyncResult = {
      syncType: 'sales_traffic',
      recordsFetched: 0,
      errors: [],
      duration: 0,
    };
    try {
      console.log('[Sync] Starting sales traffic pulse sync...');
      const pulse = await syncSalesTrafficDaily(credentials);
      pulseSyncResult.recordsFetched = pulse.orderItems;
      console.log(`[Sync] Sales Traffic: ${pulse.orderItems} order items, $${(pulse.orderedProductSales / 100).toFixed(2)} ordered sales`);
    } catch (err) {
      const msg = `sales_traffic: ${String(err)}`;
      pulseSyncResult.errors.push(msg);
      console.error('[Sync] Sales traffic error:', err);
    }
    pulseSyncResult.duration = Date.now() - pulseStart;
    currentSync.results.push(pulseSyncResult);

    // 2. Financial Events — fees, refunds, reimbursements (overlays on orders)
    resetServiceFeeTracker(); // Reset dedup tracker for this sync run
    console.log('[Sync] Starting financial events sync...');
    const finStart = Date.now();
    const finResult = await syncFinancialEvents(credentials, startDate, endDate);
    const finSyncResult: SyncResult = {
      syncType: 'financial_events',
      recordsFetched: finResult.eventsProcessed,
      errors: finResult.errors,
      duration: Date.now() - finStart,
    };
    currentSync.results.push(finSyncResult);
    totalRecords += finResult.eventsProcessed;
    console.log(`[Sync] Financial events: ${finResult.eventsProcessed} events, ${finResult.errors.length} errors`);

    // 3. FBA Inventory — current stock levels
    console.log('[Sync] Starting FBA inventory sync...');
    const invStart = Date.now();
    const invResult = await syncFBAInventory(credentials);
    const invSyncResult: SyncResult = {
      syncType: 'fba_inventory',
      recordsFetched: invResult.itemsProcessed,
      errors: invResult.errors,
      duration: Date.now() - invStart,
    };
    currentSync.results.push(invSyncResult);
    totalRecords += invResult.itemsProcessed;
    console.log(`[Sync] FBA Inventory: ${invResult.itemsProcessed} items, ${invResult.errors.length} errors`);

    // 4. Product Catalog — enrich product names/categories/images
    console.log('[Sync] Starting catalog enrichment...');
    const catStart = Date.now();
    const catResult = await enrichProductCatalog(credentials);
    const catSyncResult: SyncResult = {
      syncType: 'catalog',
      recordsFetched: catResult.enriched,
      errors: catResult.errors,
      duration: Date.now() - catStart,
    };
    currentSync.results.push(catSyncResult);
    console.log(`[Sync] Catalog: ${catResult.enriched} enriched, ${catResult.errors.length} errors`);

    // 5. Settlement Reports — shipping label costs + reconciliation data
    console.log('[Sync] Starting settlement reports sync...');
    const setStart = Date.now();
    const setResult = await syncSettlementReports(credentials, startDate);
    const setSyncResult: SyncResult = {
      syncType: 'settlement_reports',
      recordsFetched: setResult.shippingCostsUpdated,
      errors: setResult.errors,
      duration: Date.now() - setStart,
    };
    currentSync.results.push(setSyncResult);
    console.log(`[Sync] Settlement Reports: ${setResult.reportsProcessed} reports, ${setResult.shippingCostsUpdated} shipping costs updated, ${setResult.errors.length} errors`);

    // 5b. Merchant Listings — Seller Central listing status / qty / price truth.
    // Read-only from Amazon's perspective; powers MFN freshness on the
    // /analyze/merchant-inventory and /mfn/batch surfaces. Failures here must
    // NOT abort the rest of the sync — they're isolated in a try/catch.
    const mlStart = Date.now();
    const mlSyncResult: SyncResult = {
      syncType: 'merchant_listings',
      recordsFetched: 0,
      errors: [],
      duration: 0,
    };
    try {
      console.log('[Sync] Starting merchant listings sync...');
      const mlResult = await syncMerchantListings(credentials);
      mlSyncResult.recordsFetched = mlResult.reportRows;
      mlSyncResult.duration = Date.now() - mlStart;
      const db3 = getDb();
      db3.prepare(`
        INSERT INTO settings (key, value) VALUES ('merchant_listings_last_sync', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(new Date().toISOString());
      db3.close();
      console.log(`[Sync] Merchant Listings: ${mlResult.reportRows} rows, ${mlResult.inserted} inserted, ${mlResult.updated} updated`);
    } catch (err) {
      const msg = `merchant_listings: ${String(err)}`;
      mlSyncResult.errors.push(msg);
      mlSyncResult.duration = Date.now() - mlStart;
      console.error('[Sync] Merchant listings error:', err);
    }
    currentSync.results.push(mlSyncResult);

    // 6. Override estimated fees with real data, then estimate fees for remaining orders
    console.log('[Sync] Overriding estimated fees and backfilling...');
    const overridden = overrideEstimatedFees();
    const estimated = estimateAndBackfillFees();
    console.log(`[Sync] Fee estimation: ${overridden} estimates overridden, ${estimated.estimated} new estimates created`);

    // Generate recurring expenses for any new months
    console.log('[Sync] Generating recurring expenses...');
    const recurResult = generateRecurringExpenses();
    console.log(`[Sync] Recurring expenses: ${recurResult.generated} generated, ${recurResult.skipped} already existed`);

    // Self-healing dedup: ADJ-* / SETTLEMENT-* placeholders shadowed by canonical
    // numeric reimbursements (from FBA Reimbursements Report). Idempotent.
    dedupAmazonReimbursements();

    // Collect all errors
    currentSync.totalErrors = [
      ...finResult.errors,
      ...ordResult.errors,
      ...invResult.errors,
      ...catResult.errors,
      ...setResult.errors,
      ...mlSyncResult.errors,
    ];

    // Update sync log
    const db2 = getDb();
    db2.prepare(`
      UPDATE sync_log SET completed_at = ?, status = ?, records_fetched = ?, error = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      currentSync.totalErrors.length > 0 ? 'partial' : 'success',
      totalRecords,
      currentSync.totalErrors.length > 0 ? currentSync.totalErrors.join('\n').substring(0, 5000) : null,
      syncLogId
    );

    // Update last sync timestamp in settings
    db2.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('lastSync', ?)`).run(new Date().toISOString());
    db2.close();

    console.log(`[Sync] Complete. ${totalRecords} total records, ${currentSync.totalErrors.length} errors.`);
  } catch (error) {
    try {
      const db2 = getDb();
      db2.prepare(`
        UPDATE sync_log SET completed_at = ?, status = 'error', error = ?
        WHERE id = ?
      `).run(new Date().toISOString(), String(error), syncLogId);
      db2.close();
    } catch (logError) {
      console.error('[Sync] Failed to update sync_log after fatal error:', logError);
    }

    currentSync.totalErrors.push(String(error));
    console.error('[Sync] Fatal error:', error);
  } finally {
    if (currentSync) {
      currentSync.running = false;
      currentSync.completedAt = new Date().toISOString();
    }
  }

  return currentSync!;
}
