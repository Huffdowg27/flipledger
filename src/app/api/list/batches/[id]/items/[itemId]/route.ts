/**
 * Single batch item API.
 *
 * PATCH  /api/list/batches/[id]/items/[itemId] - update quantity/price/condition
 * DELETE /api/list/batches/[id]/items/[itemId] - remove an item from a batch
 *
 * Note: PATCH does NOT re-touch inventory_ledger — that's only on add.
 * Quantity edits on a batch item just change the listed qty, not the purchase history.
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id, itemId } = await params;
  const batchId = parseInt(id);
  const itemIdNum = parseInt(itemId);
  if (!Number.isFinite(batchId) || !Number.isFinite(itemIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const body = await request.json();
  const db = getDb();
  try {
    // Verify the batch is in an editable state
    const batch = db.prepare('SELECT status FROM listing_batches WHERE id = ?').get(batchId) as any;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });

    // Edit rules by status:
    //   draft: any field editable (full edit set — pre-Amazon)
    //   ready, boxing, placement: only quantity + buyPrice editable.
    //     These are FlipLedger-local — qty reconciles at FBA receipt and
    //     buyPrice only affects FIFO/COGS. Other fields (listPrice,
    //     condition, MSKU) are baked into the live Amazon listing and would
    //     silently diverge if changed locally — to change those, edit in
    //     Seller Central.
    //   sending, shipping, shipped, failed, closed: no edits.
    const isDraft = batch.status === 'draft';
    const isPostDraftEditable = ['ready', 'boxing', 'placement'].includes(batch.status);
    if (!isDraft && !isPostDraftEditable) {
      return NextResponse.json({ error: `Cannot edit items in status: ${batch.status}` }, { status: 400 });
    }

    // Whitelist of fields per status. The frontend mirrors these rules but
    // we enforce them server-side too — if a misbehaving client sends a
    // locked field, reject explicitly so the divergence is impossible.
    //
    // labelsPrintedAt is a purely-local UI tracking field (when the user marks
    // a row as physically labeled) — always editable, never touches Amazon.
    const allowedFields = isDraft
      ? new Set(['msku', 'condition', 'quantity', 'supplier', 'purchaseDate', 'listPrice', 'buyPrice', 'labelsPrintedAt'])
      : new Set(['quantity', 'buyPrice', 'labelsPrintedAt']);

    for (const k of Object.keys(body)) {
      if (!allowedFields.has(k)) {
        return NextResponse.json({
          error: `Field '${k}' is not editable in '${batch.status}' status. Allowed: ${[...allowedFields].join(', ')}.`,
        }, { status: 400 });
      }
    }

    const sets: string[] = [];
    const values: any[] = [];

    const fieldMap: Record<string, string> = {
      msku: 'msku',
      condition: 'condition',
      quantity: 'quantity',
      supplier: 'supplier',
      purchaseDate: 'purchase_date',
    };
    for (const [key, col] of Object.entries(fieldMap)) {
      if (body[key] !== undefined && allowedFields.has(key)) {
        if (key === 'quantity') {
          const newQty = parseInt(String(body.quantity), 10);
          if (!Number.isFinite(newQty) || newQty < 0) {
            return NextResponse.json({ error: 'quantity must be a non-negative integer' }, { status: 400 });
          }
          // Boxing guard: don't reduce qty below the units already allocated
          // to boxes. The user has to free them up first.
          const allocatedRow = db.prepare(`
            SELECT COALESCE(SUM(bi.quantity), 0) as allocated
            FROM listing_batch_box_items bi
            INNER JOIN listing_batch_boxes b ON b.id = bi.box_id
            WHERE b.batch_id = ? AND bi.item_id = ?
          `).get(batchId, itemIdNum) as { allocated: number };
          if (allocatedRow.allocated > newQty) {
            return NextResponse.json({
              error: `Quantity ${newQty} is below the ${allocatedRow.allocated} units already allocated to boxes. Remove some from boxes first, then reduce quantity.`,
            }, { status: 400 });
          }
          sets.push('quantity = ?');
          values.push(newQty);
        } else {
          sets.push(`${col} = ?`);
          values.push(body[key]);
        }
      }
    }
    if (body.listPrice !== undefined && allowedFields.has('listPrice')) {
      sets.push('list_price_cents = ?');
      values.push(Math.round(Number(body.listPrice) * 100));
    }
    if (body.buyPrice !== undefined && allowedFields.has('buyPrice')) {
      sets.push('buy_price_cents = ?');
      values.push(Math.round(Number(body.buyPrice) * 100));
    }
    // labelsPrintedAt: pass null to clear, true/timestamp to set
    if (body.labelsPrintedAt !== undefined && allowedFields.has('labelsPrintedAt')) {
      sets.push('labels_printed_at = ?');
      // Accept boolean true or string. true → current ISO timestamp, false/null → cleared
      let val: string | null = null;
      if (body.labelsPrintedAt === true) val = new Date().toISOString();
      else if (typeof body.labelsPrintedAt === 'string' && body.labelsPrintedAt.length > 0) val = body.labelsPrintedAt;
      values.push(val);
    }

    if (sets.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    values.push(itemIdNum, batchId);
    db.prepare(`UPDATE listing_batch_items SET ${sets.join(', ')} WHERE id = ? AND batch_id = ?`).run(...values);
    db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), batchId);

    return NextResponse.json({
      success: true,
      status: batch.status,
      editScope: isDraft ? 'full' : 'qty-and-buy-only',
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id, itemId } = await params;
  const batchId = parseInt(id);
  const itemIdNum = parseInt(itemId);
  if (!Number.isFinite(batchId) || !Number.isFinite(itemIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const db = getDb();
  let affectedSku: string | null = null;
  try {
    const batch = db.prepare('SELECT status FROM listing_batches WHERE id = ?').get(batchId) as any;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.status !== 'draft') {
      return NextResponse.json({ error: `Cannot remove items in status: ${batch.status}` }, { status: 400 });
    }

    // Roll back the inventory_ledger add that happened when this item was created,
    // so deleting a mistakenly-added batch item doesn't leave zombie inventory.
    const rollback = db.transaction(() => {
      const item = db.prepare('SELECT sku, quantity FROM listing_batch_items WHERE id = ? AND batch_id = ?')
        .get(itemIdNum, batchId) as any;
      if (!item) return null;

      affectedSku = item.sku;

      // Decrement inventory_ledger by the item's quantity.
      // The listing tool's POST handler either INSERTs a new row or INCREMENTs an existing one,
      // so we roll back the same way: decrement quantity and quantity_remaining. If the row
      // ends up at 0/0, delete it entirely (it was created by this add).
      const ledger = db.prepare('SELECT id, quantity, quantity_remaining FROM inventory_ledger WHERE sku = ?').get(item.sku) as any;
      if (ledger) {
        const newQty = Math.max(0, ledger.quantity - item.quantity);
        const newRemaining = Math.max(0, ledger.quantity_remaining - item.quantity);
        if (newQty === 0) {
          db.prepare('DELETE FROM inventory_ledger WHERE id = ?').run(ledger.id);
        } else {
          db.prepare('UPDATE inventory_ledger SET quantity = ?, quantity_remaining = ? WHERE id = ?')
            .run(newQty, newRemaining, ledger.id);
        }
      }

      db.prepare('DELETE FROM listing_batch_items WHERE id = ? AND batch_id = ?').run(itemIdNum, batchId);
      db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), batchId);
      return item;
    });

    const removed = rollback();
    db.close();

    // Re-run FIFO for the affected SKU so order_items cogs_per_unit rebalances
    // against the reduced ledger.
    if (affectedSku) {
      try { recalculateFIFO({ sku: affectedSku }); } catch { /* best effort */ }
    }

    return NextResponse.json({ success: true, removed });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
