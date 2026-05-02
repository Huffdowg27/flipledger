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
    // Download all settlement reports and extract per-order net amounts
    const response = await spApiRequest(credentials, '/reports/2021-06-30/reports', {
      reportTypes: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
      processingStatuses: 'DONE',
      pageSize: '100',
    });

    const reports = response.reports || [];
    const orderNetAmounts: Record<string, { revenue: number; fees: number; net: number }> = {};

    for (const report of reports) {
      try {
        if (!report.reportDocumentId) continue;
        const docResponse = await spApiRequest(credentials, `/reports/2021-06-30/documents/${report.reportDocumentId}`);
        const reportResponse = await fetch(docResponse.url);
        const content = await reportResponse.text();

        const lines = content.split('\n');
        const headers = lines[0].split('\t').map((h: string) => h.trim());
        const oi = headers.indexOf('order-id');
        const tt = headers.indexOf('transaction-type');
        const at = headers.indexOf('amount-type');
        const ad = headers.indexOf('amount-description');
        const ai = headers.indexOf('amount');

        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split('\t').map((c: string) => c.trim());
          if (cols.length < Math.max(oi, ai) + 1) continue;

          const orderId = cols[oi];
          const txType = cols[tt];
          const amtType = cols[at];
          const amtDesc = cols[ad];
          const amount = parseFloat(cols[ai] || '0');

          if (!orderId || txType !== 'Order') continue;

          if (!orderNetAmounts[orderId]) {
            orderNetAmounts[orderId] = { revenue: 0, fees: 0, net: 0 };
          }

          if (amtType === 'ItemPrice' && amtDesc === 'Principal') {
            orderNetAmounts[orderId].revenue += amount;
          } else if (amtType === 'ItemFees') {
            orderNetAmounts[orderId].fees += amount; // negative
          }
          orderNetAmounts[orderId].net += amount;
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      } catch {}
    }

    // Check specific orders
    const checkOrders = ['REDACTED-ORDER', 'REDACTED-ORDER', 'REDACTED-ORDER'];
    const results: any[] = [];
    for (const oid of checkOrders) {
      if (orderNetAmounts[oid]) {
        results.push({ orderId: oid, ...orderNetAmounts[oid] });
      }
    }

    return NextResponse.json({
      totalOrders: Object.keys(orderNetAmounts).length,
      rachioOrders: results,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) });
  }
}
