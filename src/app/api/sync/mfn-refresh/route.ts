import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { syncOrders, reconcileOpenOrders } from '@/lib/sp-api/orders';
import { getEbayCredentials } from '@/lib/ebay-api/auth';
import { runEbaySync } from '@/lib/ebay-api/sync';

function getAmazonCredentials() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    clientId: s.clientId || '',
    clientSecret: s.clientSecret || '',
    refreshToken: s.refreshToken || '',
    marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
  };
}

/**
 * On-demand refresh for the MFN Orders screen. Instead of just re-reading the
 * local DB, this asks Amazon for live state:
 *   - syncOrders: pulls recent NEW orders (last 7 days) so they appear.
 *   - reconcileOpenOrders: re-checks currently-open orders and updates status,
 *     so anything shipped or canceled drops off "Ready to Ship".
 * eBay is kicked off fire-and-forget and fail-safe — its auth error (currently
 * an invalid refresh token) can never block or break the Amazon refresh. Once
 * eBay is reconnected in Settings, its orders flow through this same button.
 */
export async function POST() {
  const credentials = getAmazonCredentials();
  // Narrow window: the background worker already carries the fuller history, so
  // the button only needs to catch brand-new orders. Keeps the click fast.
  const startDate = new Date(Date.now() - 2 * 86400000).toISOString();

  const result = {
    ordersProcessed: 0,
    checked: 0,
    updated: 0,
    canceled: 0,
    errors: [] as string[],
    ebayStarted: false,
  };

  try {
    const sync = await syncOrders(credentials, startDate);
    result.ordersProcessed = sync.ordersProcessed;
    result.errors.push(...sync.errors);
  } catch (err) {
    result.errors.push(`orders sync: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const rec = await reconcileOpenOrders(credentials);
    result.checked = rec.checked;
    result.updated = rec.updated;
    result.canceled = rec.canceled;
    result.errors.push(...rec.errors);
  } catch (err) {
    result.errors.push(`reconcile: ${err instanceof Error ? err.message : String(err)}`);
  }

  // eBay: fire-and-forget, fail-safe. Never awaited, never allowed to throw
  // into the Amazon path.
  try {
    const ebayCreds = getEbayCredentials();
    if (ebayCreds) {
      runEbaySync(ebayCreds, 7).catch((err) => console.error('[mfn-refresh] eBay sync error:', err));
      result.ebayStarted = true;
    }
  } catch { /* eBay must never break the Amazon refresh */ }

  return NextResponse.json(result);
}
