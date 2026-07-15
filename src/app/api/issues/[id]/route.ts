/**
 * POST /api/issues/[id] — resolve a receiving issue. Each resolution is a
 * money event that keeps the ledger honest:
 *
 *   refunded_returned   — units went back, money came back. No lot, no COGS.
 *   disposed            — junked, no refund. Cost becomes a write-off expense.
 *   kept_partial_refund — kept the units at a reduced basis: lot created at
 *                         (cost − refund)/qty, plus refund recorded.
 *   kept_as_is          — kept and sellable after all: lot at full basis.
 *   no_impact           — note-only close. For lot-shrunk issues (MFN batch
 *                         path) this RESTORES the shrunk lot — "no impact"
 *                         means the report was a false alarm, so the units
 *                         and their basis go back on the books.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { recalculateFIFO } from '@/lib/fifo';

const RESOLUTIONS = new Set(['refunded_returned', 'disposed', 'kept_partial_refund', 'kept_as_is', 'no_impact']);

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
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
      SELECT ri.*, ip.unit_cost_cents as unitCostCents, il.buy_price as lotUnitCostCents,
             ip.ordered_at as orderedAt, ip.product_name as productName
      FROM receiving_issues ri
      LEFT JOIN incoming_purchases ip ON ip.id = ri.incoming_purchase_id
      LEFT JOIN inventory_ledger il ON il.id = ri.inventory_ledger_id
      WHERE ri.id = ?
    `).get(issueId) as any;
    if (!issue) return NextResponse.json({ error: 'Issue not found' }, { status: 404 });
    if (issue.status === 'resolved') return NextResponse.json({ error: 'Already resolved' }, { status: 400 });

    const now = new Date().toISOString();
    const refundCents = Math.max(0, Math.round(Number(body.refundCents) || 0));
    // Cost basis: for lot-shrunk issues (MFN batch path) the report
    // snapshotted the exact per-unit basis it removed, so use that — a later
    // buy_price edit or a blank (0) Airtable cost on the incoming row must
    // not change what resolution restores or writes off. /incoming-originated
    // issues keep pricing from the purchase.
    const unitCost: number = issue.lot_shrunk
      ? (issue.removed_unit_cost_cents ?? issue.lotUnitCostCents ?? issue.unitCostCents ?? 0)
      : (issue.unitCostCents ?? issue.lotUnitCostCents ?? 0);
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

      if (body.resolution === 'no_impact' && issue.lot_shrunk) {
        // False alarm on a lot-shrunk issue: put the units and their basis
        // back. Without this, closing "no impact" would silently lose the
        // basis the report removed.
        const restore = db.prepare(`
          UPDATE inventory_ledger
          SET quantity = quantity + ?, quantity_remaining = quantity_remaining + ?
          WHERE id = ?
        `).run(issue.quantity, issue.quantity, issue.inventory_ledger_id);
        if (restore.changes !== 1) {
          throw new Error(
            'Cannot close as no-impact: the original lot no longer exists to restore the units to. Resolve as kept/disposed/refunded instead.',
          );
        }
        // The lot is whole again — clear the flag so the buy-list
        // conservation carve-out stops adding these units back.
        db.prepare('UPDATE receiving_issues SET lot_shrunk = 0 WHERE id = ?').run(issueId);
        if (issue.sku) recalcSku = issue.sku;
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
