/**
 * POST /api/sync/settlement-transactions
 *
 * Re-downloads settlement flat-file reports and runs the full parser
 * (parseSettlementReport), which now stores every transaction line into
 * settlement_transactions tagged with its real settlement-id. This is the
 * backbone for settlement-accurate Profit First / returns reconciliation.
 *
 * Optional body: { "lookbackDays": 60 }   (default: 60)
 */
import { NextRequest, NextResponse } from 'next/server';
import { syncSettlementReports } from '@/lib/sp-api/reports';
import Database from 'better-sqlite3';
import path from 'path';

function getCredentials() {
  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly: true });
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
  const credentials = getCredentials();
  if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
    return NextResponse.json({ error: 'Missing SP-API credentials.' }, { status: 400 });
  }
  let lookbackDays = 60;
  try { const b = await request.json().catch(() => ({})); if (b?.lookbackDays) lookbackDays = Number(b.lookbackDays); } catch {}
  const startDate = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  try {
    const result = await syncSettlementReports(credentials, startDate);
    // summary of what landed
    const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly: true });
    const stats = db.prepare('SELECT COUNT(*) rows, COUNT(DISTINCT settlement_id) settlements FROM settlement_transactions').get();
    db.close();
    return NextResponse.json({ lookbackDays, startDate, ...result, settlement_transactions: stats });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
