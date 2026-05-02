import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') || 'pending';

  const db = getDb();

  const where = status === 'all' ? '' : `WHERE status = '${status.replace(/'/g, "''")}'`;

  const rows = db.prepare(`
    SELECT id, reimbursement_id as reimbursementId, reimbursement_date as reimbursementDate,
           asin, sku, product_name as productName, quantity,
           paid_cents as paidCents, expected_cents as expectedCents, gap_cents as gapCents,
           reason, status, filed_at as filedAt, claim_notes as claimNotes
    FROM amazon_reimbursement_reevaluations
    ${where}
    ORDER BY
      CASE status WHEN 'pending' THEN 1 WHEN 'filed' THEN 2 ELSE 3 END,
      gap_cents DESC
  `).all() as any[];

  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN status = 'pending' THEN gap_cents ELSE 0 END) as pending_gap,
      SUM(CASE WHEN status = 'filed' THEN 1 ELSE 0 END) as filed_count,
      SUM(CASE WHEN status = 'filed' THEN gap_cents ELSE 0 END) as filed_gap,
      SUM(CASE WHEN status = 'received' THEN gap_cents ELSE 0 END) as recovered_gap
    FROM amazon_reimbursement_reevaluations
  `).get() as any;

  const lastSync = (db.prepare(`SELECT value FROM settings WHERE key = 'amazon_reevaluations_last_sync'`).get() as { value: string } | undefined)?.value || null;

  db.close();

  return NextResponse.json({
    candidates: rows,
    totals: {
      pendingCount: totals.pending_count || 0,
      pendingGapCents: totals.pending_gap || 0,
      filedCount: totals.filed_count || 0,
      filedGapCents: totals.filed_gap || 0,
      recoveredGapCents: totals.recovered_gap || 0,
    },
    lastSync,
  });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { id, action, claimNotes } = body as { id: number; action: 'file' | 'dismiss' | 'received' | 'reopen'; claimNotes?: string };
  if (!id || !action) return NextResponse.json({ error: 'id and action required' }, { status: 400 });

  const db = getDb();
  try {
    if (action === 'file') {
      db.prepare(`UPDATE amazon_reimbursement_reevaluations SET status = 'filed', filed_at = datetime('now'), claim_notes = ?, updated_at = datetime('now') WHERE id = ?`).run(claimNotes || null, id);
    } else if (action === 'dismiss') {
      db.prepare(`UPDATE amazon_reimbursement_reevaluations SET status = 'dismissed', claim_notes = ?, updated_at = datetime('now') WHERE id = ?`).run(claimNotes || null, id);
    } else if (action === 'received') {
      db.prepare(`UPDATE amazon_reimbursement_reevaluations SET status = 'received', updated_at = datetime('now') WHERE id = ?`).run(id);
    } else if (action === 'reopen') {
      db.prepare(`UPDATE amazon_reimbursement_reevaluations SET status = 'pending', filed_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } finally {
    db.close();
  }
}
