import { NextRequest, NextResponse } from 'next/server';
import { syncFinancialEvents, resetServiceFeeTracker } from '@/lib/sp-api/finances';
import { dedupAmazonReimbursements } from '@/lib/sp-api/dedupReimbursements';
import Database from 'better-sqlite3';
import path from 'path';

function getCredentials() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  return {
    clientId: settings.clientId || '',
    clientSecret: settings.clientSecret || '',
    refreshToken: settings.refreshToken || '',
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

/**
 * POST /api/sync/backfill
 * Syncs financial events for a full year by splitting into 90-day chunks.
 * Body: { year: 2025 }
 * This is a BLOCKING endpoint — waits until all chunks are done.
 */
export async function POST(request: NextRequest) {
  const credentials = getCredentials();
  if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
    return NextResponse.json({ error: 'Missing SP-API credentials' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const year = body.year || 2025;

  // Split year into 90-day chunks
  const chunks: { start: string; end: string }[] = [];
  const yearStart = new Date(`${year}-01-01T00:00:00Z`);
  const yearEnd = new Date(`${year + 1}-01-01T00:00:00Z`);

  let current = new Date(yearStart);
  while (current < yearEnd) {
    const chunkEnd = new Date(Math.min(current.getTime() + 90 * 86400000, yearEnd.getTime()));
    chunks.push({
      start: current.toISOString(),
      end: chunkEnd.toISOString(),
    });
    current = chunkEnd;
  }

  resetServiceFeeTracker();
  console.log(`[Backfill] Starting ${year} sync in ${chunks.length} chunks`);

  const results: { chunk: string; events: number; errors: string[] }[] = [];
  let totalEvents = 0;

  for (const chunk of chunks) {
    console.log(`[Backfill] Syncing ${chunk.start} → ${chunk.end}...`);
    try {
      const result = await syncFinancialEvents(credentials, chunk.start, chunk.end);
      results.push({
        chunk: `${chunk.start} → ${chunk.end}`,
        events: result.eventsProcessed,
        errors: result.errors,
      });
      totalEvents += result.eventsProcessed;
      console.log(`[Backfill] Chunk done: ${result.eventsProcessed} events, ${result.errors.length} errors`);
    } catch (err) {
      results.push({
        chunk: `${chunk.start} → ${chunk.end}`,
        events: 0,
        errors: [String(err)],
      });
      console.error(`[Backfill] Chunk error:`, err);
    }
  }

  console.log(`[Backfill] Complete. ${totalEvents} total events for ${year}.`);

  // Self-healing: ADJ-* placeholders may have been inserted; sweep any covered
  // by a canonical numeric reimbursement.
  dedupAmazonReimbursements();

  return NextResponse.json({
    year,
    chunks: chunks.length,
    totalEvents,
    results,
  });
}
