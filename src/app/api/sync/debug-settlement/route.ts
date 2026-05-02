import { NextResponse } from 'next/server';
import { getSettlementReports, downloadReport } from '@/lib/sp-api/reports';
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

/**
 * GET /api/sync/debug-settlement
 * Downloads settlement reports and shows the unique row types
 * so we can understand the format for service fee extraction.
 */
export async function GET() {
  const credentials = getCredentials();

  try {
    const startDate = new Date(Date.now() - 85 * 86400000).toISOString();
    const reports = await getSettlementReports(credentials, startDate);

    if (reports.length === 0) {
      return NextResponse.json({ error: 'No settlement reports found', startDate });
    }

    // List all reports first
    const reportList = reports.map((r: any) => ({
      id: r.reportId,
      start: r.dataStartTime,
      end: r.dataEndTime,
      docId: r.reportDocumentId,
    }));

    // Try a biweekly report with actual order volume
    const targetId = '921179020519'; // Feb 22 - Mar 7
    const report = reports.find((r: any) => r.reportId === targetId) || reports[0];
    const content = await downloadReport(credentials, report.reportDocumentId);

    const lines = content.split('\n');
    const headers = lines[0].split('\t').map((h: string) => h.trim().replace(/"/g, ''));

    const colIndex = (name: string) => headers.indexOf(name);
    const ttIdx = colIndex('transaction-type');
    const atIdx = colIndex('amount-type');
    const adIdx = colIndex('amount-description');
    const amtIdx = colIndex('amount');
    const pdIdx = colIndex('posted-date') >= 0 ? colIndex('posted-date') : colIndex('posted-date-time');
    const oidIdx = colIndex('order-id');

    // Collect all unique combos with sample data
    const combos: Record<string, { count: number; sampleAmount: string; sampleDate: string; sampleOrderId: string }> = {};

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t').map((c: string) => c.trim().replace(/"/g, ''));
      if (cols.length < 3) continue;

      const tt = ttIdx >= 0 ? cols[ttIdx] : '';
      const at = atIdx >= 0 ? cols[atIdx] : '';
      const ad = adIdx >= 0 ? cols[adIdx] : '';
      const amt = amtIdx >= 0 ? cols[amtIdx] : '';
      const pd = pdIdx >= 0 ? cols[pdIdx] : '';
      const oid = oidIdx >= 0 ? cols[oidIdx] : '';

      const key = `${tt} | ${at} | ${ad}`;
      if (!combos[key]) {
        combos[key] = { count: 0, sampleAmount: amt, sampleDate: pd, sampleOrderId: oid };
      }
      combos[key].count++;
    }

    // Find service-fee-like rows (non-order transactions)
    const serviceFeeRows: string[] = [];
    for (let i = 1; i < Math.min(lines.length, 2000); i++) {
      const cols = lines[i].split('\t').map((c: string) => c.trim().replace(/"/g, ''));
      if (cols.length < 3) continue;
      const tt = ttIdx >= 0 ? cols[ttIdx] : '';
      const oid = oidIdx >= 0 ? cols[oidIdx] : '';
      // Non-order rows are likely service fees
      if (tt && !oid && tt !== 'Order' && tt !== 'Refund') {
        serviceFeeRows.push(lines[i]);
      }
    }

    return NextResponse.json({
      allReports: reportList,
      reportId: report.reportId,
      dateRange: `${report.dataStartTime} to ${report.dataEndTime}`,
      totalLines: lines.length,
      columns: headers,
      uniqueCombos: Object.entries(combos)
        .map(([key, info]) => ({ key, ...info }))
        .sort((a, b) => b.count - a.count),
      serviceFeeRowCount: serviceFeeRows.length,
      sampleServiceFeeRows: serviceFeeRows.slice(0, 10),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
