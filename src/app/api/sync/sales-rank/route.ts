/**
 * POST /api/sync/sales-rank
 *
 * Manually trigger a sales rank sync. Useful for the first run (instead
 * of waiting up to 24h for auto-sync) and for re-syncing on demand from
 * the UI. Rate-limited to ~150 ASINs/min by the Catalog API.
 */
import { NextResponse } from 'next/server';
import { syncSalesRanks } from '@/lib/sp-api/salesRank';
import { getAmazonCredentials, upsertSetting } from '@/lib/settings';
import { openFlipLedgerDb } from '@/lib/sqlite';

export async function POST() {
  const credsDb = openFlipLedgerDb({ readonly: true });
  let creds;
  try {
    creds = getAmazonCredentials(credsDb);
  } finally {
    credsDb.close();
  }
  if (!creds) return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });

  const result = await syncSalesRanks(creds);

  // Update last-sync marker so auto-sync doesn't re-run immediately
  const db = openFlipLedgerDb();
  try {
    upsertSetting(db, 'sales_rank_last_sync', new Date().toISOString());
  } finally {
    db.close();
  }

  return NextResponse.json({ success: true, ...result });
}
