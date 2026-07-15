/**
 * POST /api/sync/backfill-upcs
 *
 * Fills products.upc from Amazon's Catalog Items API for ASINs that appear on
 * merchant-fulfilled (MFN) orders and don't have a UPC yet. Read-only SP-API.
 *
 * Body (all optional): { dryRun=true, limit=50, delayMs=300 }
 *   dryRun=true  → eligible count + samples, no SP-API calls / writes.
 *   dryRun=false → fetch + store UPC for up to `limit` ASINs (delegates to backfillUpcs()).
 *
 * Also runs daily via auto-sync. UPCs persist (sentinel '-' for checked-none), so
 * re-runs only touch what's still missing.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { backfillUpcs, UPC_ELIGIBLE_SQL } from '@/lib/sp-api/backfillUpcs';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getCredentials(): SPAPICredentials {
  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    clientId: s.clientId || '', clientSecret: s.clientSecret || '',
    refreshToken: s.refreshToken || '', marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
  };
}

export async function POST(request: NextRequest) {
  let body: { dryRun?: unknown; limit?: unknown; delayMs?: unknown } = {};
  try { body = await request.json(); } catch { /* defaults */ }
  const dryRun = body.dryRun !== false;
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 300);
  const delayMs = Math.max(Number(body.delayMs) || 300, 0);

  if (dryRun) {
    const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly: true });
    db.pragma('busy_timeout = 15000');
    db.pragma('journal_mode = WAL');
    try {
      const eligible = (db.prepare(`SELECT COUNT(*) AS n FROM (${UPC_ELIGIBLE_SQL})`).get() as { n: number }).n;
      const samples = (db.prepare(`${UPC_ELIGIBLE_SQL} ORDER BY p.asin LIMIT 10`).all() as { asin: string }[]).map(r => r.asin);
      return NextResponse.json({ dryRun: true, eligible, attempted: 0, found: 0, samples });
    } finally {
      db.close();
    }
  }

  const creds = getCredentials();
  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
    return NextResponse.json({ error: 'Missing SP-API credentials. Enter them in Settings.' }, { status: 400 });
  }

  const result = await backfillUpcs(creds, { limit, delayMs });
  return NextResponse.json({ dryRun: false, ...result });
}
