import { NextRequest, NextResponse } from 'next/server';
import { runFullSync, getSyncStatus } from '@/lib/sp-api/sync';
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

/** GET — check sync status */
export async function GET() {
  const status = getSyncStatus();
  return NextResponse.json({ status });
}

/** POST — start a sync */
export async function POST(request: NextRequest) {
  const credentials = getCredentials();

  if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
    return NextResponse.json(
      { error: 'Missing SP-API credentials. Go to Settings and enter your Client ID, Client Secret, and Refresh Token.' },
      { status: 400 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const lookbackDays = body.lookbackDays || 90;
  const explicitStartDate = body.startDate; // ISO string e.g. "2025-01-01T00:00:00Z"
  const explicitEndDate = body.endDate;     // ISO string e.g. "2026-01-01T00:00:00Z"

  // Run sync in background — don't await it
  runFullSync(credentials, lookbackDays, explicitStartDate, explicitEndDate).catch(err => {
    console.error('[Sync] Background sync error:', err);
  });

  return NextResponse.json({ message: 'Sync started', lookbackDays, startDate: explicitStartDate, endDate: explicitEndDate });
}
