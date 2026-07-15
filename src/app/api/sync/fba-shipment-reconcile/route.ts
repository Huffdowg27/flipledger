/**
 * POST /api/sync/fba-shipment-reconcile
 *
 * Manually trigger the FBA shipment reconcile — checks every FBA batch in
 * 'shipping' against Amazon's v0 shipment status and auto-closes batches
 * whose shipments are all terminal (CLOSED/CANCELLED/DELETED). Also runs
 * every 6h from auto-sync.
 */
import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { reconcileFbaShipments } from '@/lib/sp-api/reconcileFbaShipments';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getCredentials(): SPAPICredentials | null {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 15000');
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

  const result = await reconcileFbaShipments(creds);

  // Update last-sync marker so auto-sync doesn't re-run immediately
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('fba_shipment_reconcile_last_sync', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(new Date().toISOString());
  db.close();

  return NextResponse.json({ success: true, ...result });
}
