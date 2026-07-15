/**
 * POST /api/sync/backfill-settlement-periods
 *
 * Metadata-only backfill: fetches settlement reports from SP-API and stores
 * period boundaries (settlement_id, start_date, end_date, deposit_date) in
 * settlement_periods. Touches NO financial data tables.
 *
 * Optional body: { "lookbackDays": 365 }   (default: 365)
 */
import { NextRequest, NextResponse } from 'next/server';
import { backfillSettlementPeriods } from '@/lib/sp-api/reports';
import Database from 'better-sqlite3';
import path from 'path';

function getCredentials() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  return {
    clientId:      settings.clientId      || '',
    clientSecret:  settings.clientSecret  || '',
    refreshToken:  settings.refreshToken  || '',
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

function getStoredPeriods() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  const rows = db.prepare(
    'SELECT settlement_id, marketplace, start_date, end_date, deposit_date FROM settlement_periods ORDER BY end_date DESC'
  ).all();
  db.close();
  return rows;
}

export async function POST(request: NextRequest) {
  const credentials = getCredentials();
  if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
    return NextResponse.json(
      { error: 'Missing SP-API credentials. Configure them in Settings first.' },
      { status: 400 }
    );
  }

  let lookbackDays = 365;
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.lookbackDays) lookbackDays = Number(body.lookbackDays);
  } catch { /* no body is fine */ }

  const startDate = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  try {
    const result = await backfillSettlementPeriods(credentials, startDate);
    const periods = getStoredPeriods();

    return NextResponse.json({
      lookbackDays,
      startDate,
      processed:  result.processed,
      upserted:   result.upserted,
      skipped:    result.skipped,
      errors:     result.errors,
      total_periods_stored: periods.length,
      periods,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
