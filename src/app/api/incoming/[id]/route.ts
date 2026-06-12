/**
 * POST /api/incoming/[id]  — actions on one incoming purchase.
 *
 * { action: 'receive', quantityGood, quantityIssue?, issueType?, issueNote?,
 *   sku?, binLocation? }
 *   Good units become a real inventory_ledger lot (this is the moment the
 *   purchase enters FIFO/valuation). Issue units land in receiving_issues —
 *   they arrived, so they count toward quantity_received, but they create NO
 *   lot until their issue resolves (resolution decides the accounting).
 *   `sku` overrides/relinks the SKU (the receive-time mismatch fix).
 *   Writes the new received count back to Airtable's "Received" field
 *   (best-effort) so his existing views stay truthful.
 *
 * { action: 'cancel', note? }   — refunded/never coming; no lot, locked.
 * { action: 'snooze', days }    — still waiting; re-ages from today.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { recalculateFIFO } from '@/lib/fifo';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

async function writeBackReceived(db: Database.Database, airtableRecordId: string | null, received: number, damaged: number) {
  if (!airtableRecordId) return;
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('airtable_api_key','airtable_purchases_base','airtable_purchases_table')").all() as { key: string; value: string }[];
    const s: Record<string, string> = {};
    for (const r of rows) s[r.key] = r.value;
    if (!s.airtable_api_key) return;
    const baseId = s.airtable_purchases_base || 'app1G29Xd3K6S5swV';
    const table = s.airtable_purchases_table || '💳 Orders';
    const fields: Record<string, number> = { Received: received };
    if (damaged > 0) fields['Damaged'] = damaged;
    await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${airtableRecordId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${s.airtable_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
  } catch (err) {
    console.warn('[incoming] Airtable write-back failed (non-fatal):', err);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const purchaseId = parseInt(id);
  if (!Number.isFinite(purchaseId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const db = getDb();
  try {
    const p = db.prepare('SELECT * FROM incoming_purchases WHERE id = ?').get(purchaseId) as any;
    if (!p) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });
    const now = new Date().toISOString();

    if (body.action === 'snooze') {
      const days = Math.max(1, parseInt(body.days) || 7);
      const until = new Date(Date.now() + days * 86400000).toISOString();
      db.prepare('UPDATE incoming_purchases SET snoozed_until = ?, updated_at = ? WHERE id = ?').run(until, now, purchaseId);
      return NextResponse.json({ success: true, snoozedUntil: until });
    }

    if (body.action === 'cancel') {
      if (p.status === 'received') return NextResponse.json({ error: 'Already received' }, { status: 400 });
      db.prepare(`
        UPDATE incoming_purchases SET status = 'cancelled', notes = COALESCE(notes || char(10), '') || ?, updated_at = ? WHERE id = ?
      `).run(`Cancelled ${now.slice(0, 10)}${body.note ? `: ${body.note}` : ''}`, now, purchaseId);
      return NextResponse.json({ success: true });
    }

    if (body.action !== 'receive') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

    const good = Math.max(0, Math.floor(Number(body.quantityGood) || 0));
    const issue = Math.max(0, Math.floor(Number(body.quantityIssue) || 0));
    if (good + issue === 0) return NextResponse.json({ error: 'Nothing to receive' }, { status: 400 });
    const remaining = p.quantity - p.quantity_received;
    if (good + issue > remaining) {
      return NextResponse.json({ error: `Receiving ${good + issue} but only ${remaining} outstanding` }, { status: 400 });
    }
    if (issue > 0 && !body.issueType) return NextResponse.json({ error: 'issueType required when receiving issue units' }, { status: 400 });

    // SKU: explicit override (relink) > stored > adopt live SC SKU by ASIN.
    let sku: string | null = (typeof body.sku === 'string' && body.sku.trim()) ? body.sku.trim() : (p.sku || null);
    if (!sku && p.asin) {
      const live = db.prepare(
        "SELECT sku FROM merchant_listings WHERE asin = ? AND marketplace = 'amazon' ORDER BY last_synced DESC"
      ).all(p.asin) as { sku: string }[];
      if (live.length === 1) sku = live[0].sku;
    }
    if (!sku && good > 0) {
      return NextResponse.json({ error: 'No SKU known for this purchase — pick a Seller Central SKU (or enter one) to receive against.' }, { status: 400 });
    }
    const skuChanged = sku !== p.sku;

    let inventoryLedgerId: number | null = p.inventory_ledger_id;
    const tx = db.transaction(() => {
      if (good > 0) {
        if (inventoryLedgerId) {
          // Subsequent partial receive: grow the existing lot.
          db.prepare(`
            UPDATE inventory_ledger SET quantity = quantity + ?, quantity_remaining = quantity_remaining + ?,
              quantity_received = COALESCE(quantity_received, 0) + ?, received_at = ?
            WHERE id = ?
          `).run(good, good, good, now, inventoryLedgerId);
        } else {
          const lot = db.prepare(`
            INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, quantity_received,
              date_purchased, received_at, bin_location, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(p.asin, sku, p.unit_cost_cents, good, good, good, p.ordered_at || now, now, body.binLocation || null, now);
          inventoryLedgerId = Number(lot.lastInsertRowid);
        }
      }

      if (issue > 0) {
        db.prepare(`
          INSERT INTO receiving_issues (incoming_purchase_id, inventory_ledger_id, asin, sku, quantity, issue_type, note, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
        `).run(purchaseId, inventoryLedgerId, p.asin, sku, issue, String(body.issueType), body.issueNote || null, now, now);
      }

      const newReceived = p.quantity_received + good + issue;
      db.prepare(`
        UPDATE incoming_purchases SET quantity_received = ?, status = ?, received_at = ?,
          inventory_ledger_id = ?, sku = ?, updated_at = ?
        WHERE id = ?
      `).run(
        newReceived,
        newReceived >= p.quantity ? 'received' : 'partial',
        newReceived >= p.quantity ? now : p.received_at,
        inventoryLedgerId,
        sku,
        now,
        purchaseId
      );
      return newReceived;
    });
    const newReceived = tx();

    // FIFO sees the new lot (runs in-process where FIFO_IL_INFINITE is set).
    if (good > 0 && sku) {
      try { recalculateFIFO({ sku }); } catch (err) { console.warn('[incoming] FIFO recalc failed:', err); }
    }

    const damagedTotal = (db.prepare(
      "SELECT COALESCE(SUM(quantity), 0) as q FROM receiving_issues WHERE incoming_purchase_id = ?"
    ).get(purchaseId) as any).q;
    await writeBackReceived(db, p.airtable_record_id, newReceived, damagedTotal);

    return NextResponse.json({
      success: true,
      inventoryLedgerId,
      skuChanged,
      sku,
      status: newReceived >= p.quantity ? 'received' : 'partial',
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
