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
    // Get ALL settlement reports
    const response = await spApiRequest(credentials, '/reports/2021-06-30/reports', {
      reportTypes: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
      processingStatuses: 'DONE',
      pageSize: '100',
    });

    const reports = response.reports || [];
    const allCombos = new Set<string>();
    let totalShippingCosts = 0;
    let shippingLines: string[] = [];

    // Download each report and find unique transaction types
    for (const report of reports.slice(0, 5)) {
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
      const at = headers.indexOf('amount-type');
      const ad = headers.indexOf('amount-description');
      const ai = headers.indexOf('amount');
      const oi = headers.indexOf('order-id');

      for (let j = 1; j < lines.length; j++) {
        const cols = lines[j].split('\t');
        if (cols.length < 15) continue;
        const combo = `${cols[ti]}|${cols[at]}|${cols[ad]}`;
        allCombos.add(combo);

        // Look for anything shipping/postage related
        const desc = (cols[ad] || '').toLowerCase();
        const ttype = (cols[ti] || '').toLowerCase();
        if (desc.includes('postage') || desc.includes('label') ||
            ttype.includes('shipping') || ttype.includes('postage')) {
          const amt = parseFloat(cols[ai] || '0');
          totalShippingCosts += amt;
          if (shippingLines.length < 10) {
            shippingLines.push(`${cols[ti]}|${cols[at]}|${cols[ad]}|${cols[ai]}|${cols[oi]}`);
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return NextResponse.json({
      reportsScanned: Math.min(reports.length, 5),
      totalReports: reports.length,
      uniqueCombos: Array.from(allCombos).sort(),
      shippingLines,
      totalShippingCosts,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) });
  }
}
