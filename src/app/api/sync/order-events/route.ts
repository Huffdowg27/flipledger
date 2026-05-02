import { NextRequest, NextResponse } from 'next/server';
import { spApiRequest } from '@/lib/sp-api/auth';
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

export async function GET(request: NextRequest) {
  const orderId = new URL(request.url).searchParams.get('orderId');
  if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 });

  const credentials = getCredentials();
  if (!credentials.refreshToken) {
    return NextResponse.json({ error: 'Missing SP-API credentials' }, { status: 400 });
  }

  try {
    const response = await spApiRequest(
      credentials,
      `/finances/v0/orders/${orderId}/financialEvents`
    );
    const events = response?.payload?.FinancialEvents || {};
    const summary: Record<string, number> = {};
    for (const [k, v] of Object.entries(events)) {
      if (Array.isArray(v)) summary[k] = v.length;
    }
    return NextResponse.json({
      orderId,
      summary,
      shipmentEvents: events.ShipmentEventList || [],
      refundEvents: events.RefundEventList || [],
      raw: events,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
