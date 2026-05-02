/**
 * GET   /api/data/amazon-dispute-candidates  — list with summary totals
 * PATCH /api/data/amazon-dispute-candidates  — update status (file/dismiss/received/reopen)
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
  const tab = searchParams.get('tab') || 'eligible';

  const db = getDb();

  let where = '';
  if (tab === 'eligible') where = `WHERE eligibility = 'eligible' AND status IN ('pending', 'filed')`;
  else if (tab === 'maybe') where = `WHERE eligibility = 'maybe' AND status IN ('pending', 'filed')`;
  else if (tab === 'filed') where = `WHERE status = 'filed'`;
  else if (tab === 'not_eligible') where = `WHERE eligibility = 'not_eligible' OR status = 'expired'`;

  const rows = db.prepare(`
    SELECT id, refund_id as refundId, order_id as orderId, refund_date as refundDate,
           return_reason as returnReason, asin, sku, product_name as productName,
           refund_amount_cents as refundAmountCents, fulfillment_channel as fulfillmentChannel,
           eligibility, eligibility_reasons as eligibilityReasons,
           dispute_window_until as disputeWindowUntil, status,
           filed_at as filedAt, claim_notes as claimNotes,
           created_at as createdAt, updated_at as updatedAt
    FROM amazon_dispute_candidates
    ${where}
    ORDER BY
      CASE eligibility WHEN 'eligible' THEN 1 WHEN 'maybe' THEN 2 ELSE 3 END,
      CASE status WHEN 'pending' THEN 1 WHEN 'filed' THEN 2 ELSE 3 END,
      dispute_window_until ASC
  `).all() as any[];

  for (const r of rows) {
    try { r.eligibilityReasons = JSON.parse(r.eligibilityReasons || '[]'); } catch { r.eligibilityReasons = []; }
  }

  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN eligibility = 'eligible' AND status = 'pending' THEN 1 ELSE 0 END) as eligible_pending,
      SUM(CASE WHEN eligibility = 'eligible' AND status = 'pending' THEN refund_amount_cents ELSE 0 END) as eligible_value,
      SUM(CASE WHEN eligibility = 'maybe' AND status = 'pending' THEN 1 ELSE 0 END) as maybe_pending,
      SUM(CASE WHEN eligibility = 'maybe' AND status = 'pending' THEN refund_amount_cents ELSE 0 END) as maybe_value,
      SUM(CASE WHEN status = 'filed' THEN 1 ELSE 0 END) as filed_count,
      SUM(CASE WHEN status = 'filed' THEN refund_amount_cents ELSE 0 END) as filed_value,
      SUM(CASE WHEN status = 'received' THEN refund_amount_cents ELSE 0 END) as recovered_value,
      SUM(CASE WHEN
        status = 'pending'
        AND eligibility IN ('eligible','maybe')
        AND date(dispute_window_until) < date('now', '+14 days')
        THEN 1 ELSE 0 END) as urgent_count
    FROM amazon_dispute_candidates
  `).get() as any;

  const lastSync = (db.prepare(`SELECT value FROM settings WHERE key = 'amazon_disputes_last_sync'`).get() as { value: string } | undefined)?.value || null;

  db.close();

  return NextResponse.json({
    candidates: rows,
    totals: {
      eligiblePending: totals.eligible_pending || 0,
      eligibleValueCents: totals.eligible_value || 0,
      maybePending: totals.maybe_pending || 0,
      maybeValueCents: totals.maybe_value || 0,
      filedCount: totals.filed_count || 0,
      filedValueCents: totals.filed_value || 0,
      recoveredValueCents: totals.recovered_value || 0,
      urgentCount: totals.urgent_count || 0,
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
      db.prepare(`UPDATE amazon_dispute_candidates SET status = 'filed', filed_at = datetime('now'), claim_notes = ?, updated_at = datetime('now') WHERE id = ?`).run(claimNotes || null, id);
    } else if (action === 'dismiss') {
      db.prepare(`UPDATE amazon_dispute_candidates SET status = 'dismissed', claim_notes = ?, updated_at = datetime('now') WHERE id = ?`).run(claimNotes || null, id);
    } else if (action === 'received') {
      db.prepare(`UPDATE amazon_dispute_candidates SET status = 'received', updated_at = datetime('now') WHERE id = ?`).run(id);
    } else if (action === 'reopen') {
      db.prepare(`UPDATE amazon_dispute_candidates SET status = 'pending', filed_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } finally {
    db.close();
  }
}
