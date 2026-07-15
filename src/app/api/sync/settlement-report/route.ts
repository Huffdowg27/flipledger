/**
 * POST /api/sync/settlement-report
 *
 * One-shot settlement report ingestion for a single reportId, or for a
 * settlementId resolvable through the Reports API listing + local period dates.
 * Retries are disabled in the SP-API calls; a 429 or any other failure returns
 * immediately and does not loop.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { getSettlementReports, syncSettlementReportByReportId } from '@/lib/sp-api/reports';
import {
  createdSinceForSettlementPeriod,
  resolveSettlementReportIdentifier,
  type SettlementPeriodForResolution,
} from '@/lib/sp-api/settlement-report-resolution';

function getCredentials() {
  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    clientId: s.clientId || '',
    clientSecret: s.clientSecret || '',
    refreshToken: s.refreshToken || '',
    marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
  };
}

function getSettlementPeriod(settlementId: string): SettlementPeriodForResolution | null {
  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  try {
    const row = db.prepare(`
      SELECT
        settlement_id AS settlementId,
        start_date AS startDate,
        end_date AS endDate
      FROM settlement_periods
      WHERE settlement_id = ?
    `).get(settlementId) as SettlementPeriodForResolution | undefined;
    return row || null;
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const credentials = getCredentials();
  if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
    return NextResponse.json({ error: 'Missing SP-API credentials.' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({})) as {
    reportId?: unknown;
    settlementId?: unknown;
    createdSince?: unknown;
  };
  const reportId = typeof body.reportId === 'string' ? body.reportId.trim() : '';
  const settlementId = typeof body.settlementId === 'string' ? body.settlementId.trim() : '';
  if (!reportId && !settlementId) {
    return NextResponse.json({ error: 'Provide reportId or settlementId.' }, { status: 400 });
  }
  if (reportId && settlementId) {
    return NextResponse.json({ error: 'Provide either reportId or settlementId, not both.' }, { status: 400 });
  }

  try {
    if (reportId) {
      const result = await syncSettlementReportByReportId(credentials, { reportId });
      return NextResponse.json(result);
    }

    const period = getSettlementPeriod(settlementId);
    const createdSince = typeof body.createdSince === 'string' && body.createdSince.trim()
      ? body.createdSince.trim()
      : createdSinceForSettlementPeriod(period);
    const reports = await getSettlementReports(credentials, createdSince);
    const resolution = resolveSettlementReportIdentifier({
      settlementId,
      period,
      reports,
    });
    if (!resolution.ok) {
      return NextResponse.json({
        error: resolution.error,
        settlementId,
        createdSince,
        candidates: resolution.candidates,
      }, { status: resolution.candidates.length > 1 ? 409 : 404 });
    }

    const result = await syncSettlementReportByReportId(credentials, {
      reportId: resolution.report.reportId,
      reportDocumentId: resolution.report.reportDocumentId,
      expectedSettlementId: settlementId,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
