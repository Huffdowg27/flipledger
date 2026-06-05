/**
 * POST /api/sync/backfill-upcs
 *
 * Fills products.upc from Amazon's Catalog Items API for ASINs that appear on
 * merchant-fulfilled (MFN) orders and don't have a UPC yet. Read-only SP-API.
 *
 * Body (all optional): { dryRun=true, limit=50, delayMs=300 }
 *   dryRun=true  → returns the eligible count + samples, no SP-API calls / writes.
 *   dryRun=false → fetches UPC for up to `limit` ASINs and stores them.
 *
 * Rate-limited (Catalog API ~2/s) via delayMs. Run repeatedly to work through the
 * backlog; UPCs persist so re-runs only touch what's still missing.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { fetchUpcByAsin } from '@/lib/sp-api/catalog';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb(readonly = false) {
  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly });
  db.pragma('journal_mode = WAL');
  return db;
}

function getCredentials(db: InstanceType<typeof Database>): SPAPICredentials {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    clientId: s.clientId || '', clientSecret: s.clientSecret || '',
    refreshToken: s.refreshToken || '', marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
  };
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ASINs on MFN orders that have a products row with no UPC yet.
const ELIGIBLE_SQL = `
  SELECT DISTINCT p.asin
  FROM products p
  JOIN order_items oi ON oi.asin = p.asin
  JOIN orders o ON o.order_id = oi.order_id
  WHERE (p.upc IS NULL OR p.upc = '')
    AND o.marketplace = 'amazon'
    AND o.fulfillment_channel IN ('MFN', 'DEFAULT')
`;

export async function POST(request: NextRequest) {
  let body: { dryRun?: unknown; limit?: unknown; delayMs?: unknown } = {};
  try { body = await request.json(); } catch { /* defaults */ }
  const dryRun = body.dryRun !== false;
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 300);
  const delayMs = Math.max(Number(body.delayMs) || 300, 0);

  const db = getDb(dryRun);
  try {
    const eligible = (db.prepare(`SELECT COUNT(*) AS n FROM (${ELIGIBLE_SQL})`).get() as { n: number }).n;
    const asins = (db.prepare(`${ELIGIBLE_SQL} ORDER BY p.asin LIMIT ?`).all(limit) as { asin: string }[]).map(r => r.asin);

    if (dryRun) {
      db.close();
      return NextResponse.json({ dryRun: true, eligible, attempted: 0, found: 0, samples: asins.slice(0, 10) });
    }

    const creds = getCredentials(db);
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
      db.close();
      return NextResponse.json({ error: 'Missing SP-API credentials. Enter them in Settings.' }, { status: 400 });
    }

    const update = db.prepare(`UPDATE products SET upc = ?, updated_at = ? WHERE asin = ?`);
    let found = 0, missing = 0, failed = 0;
    const errors: { asin: string; error: string }[] = [];

    for (let i = 0; i < asins.length; i++) {
      if (i > 0 && delayMs > 0) await delay(delayMs);
      try {
        const upc = await fetchUpcByAsin(creds, asins[i]);
        if (upc) { update.run(upc, new Date().toISOString(), asins[i]); found++; }
        else { update.run('-', new Date().toISOString(), asins[i]); missing++; } // sentinel '-' = checked, no UPC (won't re-fetch; not shown)
      } catch (err) {
        failed++;
        errors.push({ asin: asins[i], error: String(err) });
      }
    }

    db.close();
    return NextResponse.json({ dryRun: false, eligible, attempted: asins.length, found, missing, failed, errors });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
