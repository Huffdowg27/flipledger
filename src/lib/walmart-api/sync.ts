/**
 * Walmart Marketplace sync coordinator.
 * Orchestrates order, return, and reconciliation report syncs.
 */

import { syncWalmartOrders } from './orders';
import { syncWalmartReturns } from './returns';
import { syncAllReconReports } from './recon';
import { dedupWalmartReconEvents } from './dedupRecon';
import { syncWalmartInventory } from './inventory';
import type { WalmartCredentials, SyncResult } from './types';
import Database from 'better-sqlite3';
import path from 'path';

interface WalmartSyncStatus {
  running: boolean;
  results: SyncResult[];
  totalErrors: string[];
  startedAt: string;
  completedAt?: string;
}

let currentSync: WalmartSyncStatus = {
  running: false,
  results: [],
  totalErrors: [],
  startedAt: '',
};

export function getWalmartSyncStatus(): WalmartSyncStatus {
  return { ...currentSync };
}

export async function runWalmartSync(
  credentials: WalmartCredentials,
  lookbackDays: number = 90,
  explicitStartDate?: string,
  explicitEndDate?: string,
): Promise<WalmartSyncStatus> {
  if (currentSync.running) {
    return currentSync;
  }

  currentSync = {
    running: true,
    results: [],
    totalErrors: [],
    startedAt: new Date().toISOString(),
  };

  const startDate = explicitStartDate || new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const endDate = explicitEndDate || new Date().toISOString();

  try {
    // Step 1: Sync Orders
    console.log('[Walmart] Syncing orders...');
    const orderStart = Date.now();
    const orderResult = await syncWalmartOrders(credentials, startDate, endDate);
    currentSync.results.push({
      syncType: 'walmart_orders',
      recordsFetched: orderResult.recordsFetched,
      errors: orderResult.errors,
      duration: Date.now() - orderStart,
    });
    currentSync.totalErrors.push(...orderResult.errors);
    console.log(`[Walmart] Orders: ${orderResult.recordsFetched} fetched, ${orderResult.errors.length} errors`);

    // Step 2: Sync Returns
    console.log('[Walmart] Syncing returns...');
    const returnStart = Date.now();
    const returnResult = await syncWalmartReturns(credentials, startDate, endDate);
    currentSync.results.push({
      syncType: 'walmart_returns',
      recordsFetched: returnResult.recordsFetched,
      errors: returnResult.errors,
      duration: Date.now() - returnStart,
    });
    currentSync.totalErrors.push(...returnResult.errors);
    console.log(`[Walmart] Returns: ${returnResult.recordsFetched} fetched, ${returnResult.errors.length} errors`);

    // Step 3: Sync Inventory
    console.log('[Walmart] Syncing inventory...');
    const invStart = Date.now();
    const invResult = await syncWalmartInventory(credentials);
    currentSync.results.push({
      syncType: 'walmart_inventory',
      recordsFetched: invResult.itemsProcessed,
      errors: invResult.errors,
      duration: Date.now() - invStart,
    });
    currentSync.totalErrors.push(...invResult.errors);
    console.log(`[Walmart] Inventory: ${invResult.itemsProcessed} items, ${invResult.errors.length} errors`);

    // Step 4: Sync Reconciliation Reports (fees)
    console.log('[Walmart] Syncing recon reports...');
    const reconStart = Date.now();
    // Calculate sinceDays from startDate for recon reports
    const reconSinceDays = Math.ceil((Date.now() - new Date(startDate).getTime()) / 86400000);
    const reconResult = await syncAllReconReports(credentials, reconSinceDays);
    currentSync.results.push({
      syncType: 'walmart_recon',
      recordsFetched: reconResult.recordsFetched,
      errors: reconResult.errors,
      duration: Date.now() - reconStart,
    });
    currentSync.totalErrors.push(...reconResult.errors);
    console.log(`[Walmart] Recon: ${reconResult.recordsFetched} entries, ${reconResult.errors.length} errors`);

    // Self-healing: purge any stale WalmartReconEvent rows whose raw_data
    // shows a Refund or Dispute Settlement transaction (those should be
    // WalmartRefundEvent / WalmartDisputeSettlement instead).
    dedupWalmartReconEvents();

    // Update last sync timestamp
    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('walmart_last_sync', ?)").run(new Date().toISOString());

    // Log to sync_log
    const totalFetched = currentSync.results.reduce((s, r) => s + r.recordsFetched, 0);
    db.prepare(`
      INSERT INTO sync_log (sync_type, started_at, completed_at, status, error, records_fetched)
      VALUES ('walmart_full', ?, ?, ?, ?, ?)
    `).run(
      currentSync.startedAt,
      new Date().toISOString(),
      currentSync.totalErrors.length > 0 ? 'partial' : 'success',
      currentSync.totalErrors.length > 0 ? currentSync.totalErrors.join('; ').substring(0, 1000) : null,
      totalFetched,
    );
    db.close();

  } catch (err: any) {
    currentSync.totalErrors.push(`Walmart sync failed: ${err.message}`);
    console.error('[Walmart] Sync failed:', err);
  } finally {
    currentSync.running = false;
    currentSync.completedAt = new Date().toISOString();
  }

  return currentSync;
}
