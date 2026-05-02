/**
 * eBay sync coordinator.
 * Orchestrates order and finances syncs.
 */

import { syncEbayOrders } from './orders';
import type { EbayCredentials, EbaySyncStatus, SyncResult } from './types';
import Database from 'better-sqlite3';
import path from 'path';

let currentSync: EbaySyncStatus = {
  running: false,
  results: [],
  totalErrors: [],
  startedAt: '',
};

export function getEbaySyncStatus(): EbaySyncStatus {
  return { ...currentSync };
}

export async function runEbaySync(
  credentials: EbayCredentials,
  lookbackDays: number = 90,
  explicitStartDate?: string,
  explicitEndDate?: string,
): Promise<EbaySyncStatus> {
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
    console.log('[eBay] Syncing orders...');
    const orderStart = Date.now();
    const orderResult = await syncEbayOrders(credentials, startDate, endDate);
    const orderSync: SyncResult = {
      syncType: 'ebay_orders',
      recordsFetched: orderResult.recordsFetched,
      errors: orderResult.errors,
      duration: Date.now() - orderStart,
    };
    currentSync.results.push(orderSync);
    currentSync.totalErrors.push(...orderResult.errors);
    console.log(`[eBay] Orders: ${orderResult.recordsFetched} fetched, ${orderResult.errors.length} errors`);

    // Fees are extracted directly from order data (totalMarketplaceFee field)
    // No separate Finances API call needed — eBay Fulfillment API includes fee breakdown per order

    // Update last sync timestamp
    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ebay_last_sync', ?)").run(new Date().toISOString());

    // Log to sync_log
    const totalFetched = currentSync.results.reduce((s, r) => s + r.recordsFetched, 0);
    db.prepare(`
      INSERT INTO sync_log (sync_type, started_at, completed_at, status, error, records_fetched)
      VALUES ('ebay_full', ?, ?, ?, ?, ?)
    `).run(
      currentSync.startedAt,
      new Date().toISOString(),
      currentSync.totalErrors.length > 0 ? 'partial' : 'success',
      currentSync.totalErrors.length > 0 ? currentSync.totalErrors.join('; ').substring(0, 1000) : null,
      totalFetched,
    );
    db.close();

  } catch (err: any) {
    currentSync.totalErrors.push(`eBay sync failed: ${err.message}`);
    console.error('[eBay] Sync failed:', err);
  } finally {
    currentSync.running = false;
    currentSync.completedAt = new Date().toISOString();
  }

  return currentSync;
}
