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
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  let totalUpdated = 0;
  let totalReports = 0;
  const errors: string[] = [];

  try {
    // Get ALL settlement reports
    const response = await spApiRequest(credentials, '/reports/2021-06-30/reports', {
      reportTypes: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
      processingStatuses: 'DONE',
      pageSize: '100',
    });

    const reports = response.reports || [];
    console.log(`[ImportShipping] Found ${reports.length} settlement reports`);

    for (const report of reports) {
      try {
        if (!report.reportDocumentId) continue;

        const docResponse = await spApiRequest(
          credentials,
          `/reports/2021-06-30/documents/${report.reportDocumentId}`
        );

        const reportResponse = await fetch(docResponse.url);
        const content = await reportResponse.text();
        const lines = content.split('\n');

        const headers = lines[0].split('\t').map((h: string) => h.trim());
        const ti = headers.indexOf('transaction-type');
        const ad = headers.indexOf('amount-description');
        const ai = headers.indexOf('amount');
        const oi = headers.indexOf('order-id');

        for (let j = 1; j < lines.length; j++) {
          const cols = lines[j].split('\t');
          if (cols.length < Math.max(ti, ad, ai, oi) + 1) continue;

          const transType = cols[ti];
          const desc = cols[ad];
          const amount = parseFloat(cols[ai] || '0');
          const orderId = cols[oi];

          if (transType === 'other-transaction' && desc === 'Shipping label purchase' && amount < 0 && orderId) {
            const costCents = Math.abs(Math.round(amount * 100));
            const result = db.prepare(
              'UPDATE order_items SET shipping_cost = ? WHERE order_id = ? AND shipping_cost = 0'
            ).run(costCents, orderId);
            if (result.changes > 0) totalUpdated++;
          }
        }

        totalReports++;
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        errors.push(`Report ${report.reportId}: ${err}`);
      }
    }
  } catch (err) {
    errors.push(`Listing reports: ${err}`);
  } finally {
    db.close();
  }

  return NextResponse.json({
    reportsProcessed: totalReports,
    shippingCostsUpdated: totalUpdated,
    errors,
  });
}
