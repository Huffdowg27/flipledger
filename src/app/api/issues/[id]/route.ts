/**
 * POST /api/issues/[id] — resolve a receiving issue. Each resolution is a
 * money event that keeps the ledger honest:
 *
 *   refunded_returned   — units went back, money came back. No lot, no COGS.
 *   disposed            — junked, no refund. Cost becomes a write-off expense.
 *   kept_partial_refund — kept the units at a reduced basis: lot created at
 *                         (cost − refund)/qty, plus refund recorded.
 *   kept_as_is          — kept and sellable after all: lot at full basis.
 *   no_impact           — note-only close.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { recalculateFIFO } from '@/lib/fifo';

const RESOLUTIONS = new Set(['refunded_returned', 'disposed', 'kept_partial_refund', 'kept_as_is', 'no_impact']);

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const issueId = parseInt(id);
  if (!Number.isFinite(issueId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: { resolution: string; refundCents?: number; note?: string; sku?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (!RESOLUTIONS.has(body.resolution)) {
    return NextResponse.json({ error: `resolution must be one of: ${[...RESOLUTIONS].join(', ')}` }, { status: 400 });
  }

  const db = getDb();
  try {
    const issue = db.prepare(`
      SELECT ri.*, ip.unit_cost_cents as unitCostCents, ip.ordered_at as orderedAt, ip.product_name as productName
      FROM receiving_issues ri
      LEFT JOIN incoming_purchases ip ON ip.id = ri.incoming_purchase_id
      WHERE ri.id = ?
    `).get(issueId) as any;
    if (!issue) return NextResponse.json({ error: 'Issue not found' }, { status: 404 });
    if (issue.status === 'resolved') return NextResponse.json({ error: 'Already resolved' }, { status: 400 });

    const now = new Date().toISOString();
    const refundCents = Math.max(0, Math.round(Number(body.refundCents) || 0));
    const unitCost: number = issue.unitCostCents || 0;
    const totalCost = unitCost * issue.quantity;
    const sku = (typeof body.sku === 'string' && body.sku.trim()) ? body.sku.trim() : issue.sku;
    let recalcSku: string | null = null;

    const tx = db.transaction(() => {
      if (body.resolution === 'disposed') {
        // Loss with no refund: write the cost off so P&L sees it.
        db.prepare(`
          INSERT INTO expenses (category, amount, description, date, created_at)
          VALUES ('Inventory Write-off', ?, ?, ?, ?)
        `).run(totalCost, `Receiving issue #${issueId}: ${issue.quantity}× ${sku || issue.asin || 'unknown'} disposed (${issue.issue_type})`, now.slice(0, 10), now);
      }

      if (body.resolution === 'kept_partial_refund' || body.resolution === 'kept_as_is') {
        if (!sku) throw new Error('SKU required to create a lot for kept units');
        const basisTotal = body.resolution === 'kept_partial_refund'
          ? Math.max(0, totalCost - refundCents)
          : totalCost;
        const perUnit = issue.quantity > 0 ? Math.round(basisTotal / issue.quantity) : 0;
        db.prepare(`
          INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, quantity_received,
            date_purchased, received_at, receive_notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          issue.asin, sku, perUnit, issue.quantity, issue.quantity, issue.quantity,
          issue.orderedAt || now, now,
          `From issue #${issueId} (${issue.issue_type}) — ${body.resolution}${refundCents ? `, refund $${(refundCents / 100).toFixed(2)}` : ''}`,
          now
        );
        recalcSku = sku;
      }

      db.prepare(`
        UPDATE receiving_issues SET status = 'resolved', resolution = ?, refund_cents = ?,
          note = COALESCE(note || char(10), '') || ?, resolved_at = ?, updated_at = ?
        WHERE id = ?
      `).run(body.resolution, refundCents || null, body.note || `Resolved: ${body.resolution}`, now, now, issueId);
    });
    tx();

    if (recalcSku) {
      try { recalculateFIFO({ sku: recalcSku }); } catch (err) { console.warn('[issues] FIFO recalc failed:', err); }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
