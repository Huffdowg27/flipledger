import { NextResponse } from 'next/server';
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

export async function GET() {
  const credentials = getCredentials();
  try {
    // Try both V1 and V2 settlement report types
    const reportTypes = [
      'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
      'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE',
      'GET_FLAT_FILE_PAYMENT_SETTLEMENT_DATA',
    ];

    const results: any[] = [];
    for (const rt of reportTypes) {
      try {
        const response = await spApiRequest(credentials, '/reports/2021-06-30/reports', {
          reportTypes: rt,
          processingStatuses: 'DONE',
          pageSize: '5',
        }, 3);
        const reports = response.reports || [];
        results.push({ reportType: rt, count: reports.length, sample: reports[0] || null });
      } catch (err) {
        results.push({ reportType: rt, error: String(err) });
      }
    }

    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json({ error: String(err) });
  }
}
