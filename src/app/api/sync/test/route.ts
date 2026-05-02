import { NextResponse } from 'next/server';
import { testConnection } from '@/lib/sp-api/auth';
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

export async function GET() {
  const credentials = getCredentials();

  if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
    return NextResponse.json({ success: false, error: 'Missing SP-API credentials. Go to Settings and enter your Client ID, Client Secret, and Refresh Token.' });
  }

  const result = await testConnection(credentials);
  return NextResponse.json(result);
}
