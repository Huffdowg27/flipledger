/**
 * POST /api/sync/sales-rank
 *
 * Manually trigger a sales rank sync. Useful for the first run (instead
 * of waiting up to 24h for auto-sync) and for re-syncing on demand from
 * the UI. Rate-limited to ~150 ASINs/min by the Catalog API.
 */
import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { syncSalesRanks } from '@/lib/sp-api/salesRank';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getCredentials(): SPAPICredentials | null {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
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

export async function POST() {
  const creds = getCredentials();
  if (!creds) return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });

  const result = await syncSalesRanks(creds);

  // Update last-sync marker so auto-sync doesn't re-run immediately
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('sales_rank_last_sync', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(new Date().toISOString());
  db.close();

  return NextResponse.json({ success: true, ...result });
}
