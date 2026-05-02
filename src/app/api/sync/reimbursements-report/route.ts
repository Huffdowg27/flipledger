/**
 * POST /api/sync/reimbursements-report
 *
 * Pulls the GET_FBA_REIMBURSEMENTS_DATA report and upserts every row
 * into the reimbursements table. Idempotent — re-running for the same
 * window updates rows by reimbursement_id rather than duplicating.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { syncReimbursementsReport } from '@/lib/sp-api/reimbursementsReport';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getCredentials(): SPAPICredentials | null {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;
  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    refreshToken: settings.refreshToken,
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

export async function POST(req: NextRequest) {
  const creds = getCredentials();
  if (!creds) return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });

  let body: { startDate?: string; endDate?: string } = {};
  try { body = await req.json(); } catch { /* no body */ }

  // Default lookback: 18 months. Reimbursements report supports long ranges
  // and we want a complete history so the candidate matcher can find old
  // reimbursements paired with recent adjustments.
  const endDate = body.endDate || new Date().toISOString();
  const startDate = body.startDate || new Date(Date.now() - 540 * 86400000).toISOString();

  try {
    const result = await syncReimbursementsReport(creds, startDate, endDate);

    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('reimbursements_report_last_sync', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(new Date().toISOString());
    db.close();

    return NextResponse.json({ success: true, startDate, endDate, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
