/**
 * POST /api/sync/customer-returns
 *
 * Requests the Amazon FBA Customer Returns report for a date range, waits
 * for Amazon to generate it (30-120 seconds), downloads the TSV, and UPDATEs
 * the `reason` column on matching rows in our `refunds` table.
 *
 * Body (optional):
 *   {
 *     "startDate": "2026-01-01T00:00:00Z",  // defaults to 90 days ago
 *     "endDate":   "2026-04-16T00:00:00Z"   // defaults to now
 *   }
 *
 * Returns:
 *   {
 *     success: true,
 *     reportRows: 32,
 *     refundsMatched: 28,
 *     refundsUpdated: 28,
 *     unmatched: 4,
 *     reasonBreakdown: { DEFECTIVE: 6, UNWANTED_ITEM: 12, ... }
 *   }
 *
 * Idempotent — re-running just refreshes reasons. Only updates rows whose
 * reason actually changes.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import { syncFbaCustomerReturns } from '@/lib/sp-api/customerReturns';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;
  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    refreshToken: settings.refreshToken,
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

export async function POST(request: NextRequest) {
  let startDate: string;
  let endDate: string;

  try {
    const body = await request.json().catch(() => ({}));
    endDate = body.endDate || new Date().toISOString();
    // Default window: 90 days back from endDate — SP-API's typical lookback
    // for on-demand reports is 2 years, but 90 days covers the recent period
    // where we have the most data gaps.
    const defaultStart = new Date(Date.now() - 90 * 86400000).toISOString();
    startDate = body.startDate || defaultStart;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const db = getDb();
  const creds = getAmazonCredentials(db);

  // Log the sync attempt
  const now = new Date().toISOString();
  const logResult = db.prepare(`
    INSERT INTO sync_log (sync_type, started_at, status)
    VALUES (?, ?, 'running')
  `).run('customer-returns', now);
  const logId = Number(logResult.lastInsertRowid);
  db.close();

  if (!creds) {
    const db2 = getDb();
    try {
      db2.prepare(`UPDATE sync_log SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`)
        .run(new Date().toISOString(), 'Amazon SP-API credentials not configured', logId);
    } finally {
      db2.close();
    }
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  clearTokenCache();

  try {
    const result = await syncFbaCustomerReturns(creds, startDate, endDate);

    const db3 = getDb();
    try {
      db3.prepare(`
        UPDATE sync_log SET status = 'done', completed_at = ?, records_fetched = ? WHERE id = ?
      `).run(new Date().toISOString(), result.reportRows, logId);
    } finally {
      db3.close();
    }

    return NextResponse.json({
      success: true,
      startDate,
      endDate,
      ...result,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const db4 = getDb();
    try {
      db4.prepare(`
        UPDATE sync_log SET status = 'failed', completed_at = ?, error = ? WHERE id = ?
      `).run(new Date().toISOString(), errorMsg, logId);
    } finally {
      db4.close();
    }
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
