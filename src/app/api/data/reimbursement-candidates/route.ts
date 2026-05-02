/**
 * GET  /api/data/reimbursement-candidates  — list candidates
 * PATCH /api/data/reimbursement-candidates  — update one (mark filed/dismissed)
 */
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
  const status = searchParams.get('status'); // pending | matched | filed | received | expired | dismissed | all
  const db = getDb();

  const where = status && status !== 'all' ? `WHERE status = '${status.replace(/'/g, "''")}'` : '';
  const rows = db.prepare(`
    SELECT id, adjustment_date as adjustmentDate, asin, sku, fnsku,
           product_name as productName, fulfillment_center_id as fcId,
           reason, disposition, quantity, estimated_value_cents as estimatedValueCents,
           eligible_until as eligibleUntil, status, matched_reimbursement_id as matchedReimbursementId,
           filed_at as filedAt, claim_notes as claimNotes,
           created_at as createdAt, updated_at as updatedAt
    FROM reimbursement_candidates
    ${where}
    ORDER BY
      CASE status
        WHEN 'pending' THEN 1
        WHEN 'filed' THEN 2
        WHEN 'matched' THEN 3
        WHEN 'received' THEN 4
        WHEN 'dismissed' THEN 5
        WHEN 'expired' THEN 6
        ELSE 7
      END,
      eligible_until ASC
  `).all() as any[];

  // Summary stats for the page header
  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN status = 'pending' THEN estimated_value_cents ELSE 0 END) as pending_value_cents,
      SUM(CASE WHEN status = 'pending' AND date(eligible_until) < date('now', '+14 days') THEN 1 ELSE 0 END) as urgent_count,
      SUM(CASE WHEN status = 'filed' THEN 1 ELSE 0 END) as filed_count,
      SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END) as matched_count,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired_count
    FROM reimbursement_candidates
  `).get() as any;

  const lastSync = (db.prepare(`SELECT value FROM settings WHERE key = 'reimbursement_candidates_last_sync'`).get() as { value: string } | undefined)?.value || null;

  db.close();

  return NextResponse.json({
    candidates: rows,
    totals: {
      pendingCount: totals.pending_count || 0,
      pendingValueCents: totals.pending_value_cents || 0,
      urgentCount: totals.urgent_count || 0,
      filedCount: totals.filed_count || 0,
      matchedCount: totals.matched_count || 0,
      expiredCount: totals.expired_count || 0,
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
      db.prepare(`
        UPDATE reimbursement_candidates
        SET status = 'filed', filed_at = datetime('now'), claim_notes = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(claimNotes || null, id);
    } else if (action === 'dismiss') {
      db.prepare(`UPDATE reimbursement_candidates SET status = 'dismissed', claim_notes = ?, updated_at = datetime('now') WHERE id = ?`).run(claimNotes || null, id);
    } else if (action === 'received') {
      db.prepare(`UPDATE reimbursement_candidates SET status = 'received', updated_at = datetime('now') WHERE id = ?`).run(id);
    } else if (action === 'reopen') {
      db.prepare(`UPDATE reimbursement_candidates SET status = 'pending', filed_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } finally {
    db.close();
  }
}
