import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { syncSalesTrafficDaily } from '@/lib/sp-api/salesTraffic';

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

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const credentials = getCredentials();

  if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
    return NextResponse.json({ error: 'Missing SP-API credentials' }, { status: 400 });
  }

  try {
    const snapshot = await syncSalesTrafficDaily(credentials, body.day, {
      force: body.force === true,
    });
    return NextResponse.json({ success: true, snapshot });
  } catch (error) {
    console.error('[SalesTraffic] sync error:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
