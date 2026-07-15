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
import { recalculateFIFO } from '@/lib/fifo';
import { deleteListingBatchItemChildren } from '@/lib/listing-batch-cleanup';
import { openFlipLedgerDb } from '@/lib/sqlite';

function getDb() {
  return openFlipLedgerDb();
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
  let ledgerChanged = false;
  try {
    const batch = db.prepare('SELECT status FROM listing_batches WHERE id = ?').get(batchId) as { status?: string } | undefined;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.status !== 'draft') {
      return NextResponse.json({ error: `Cannot remove items in status: ${batch.status}` }, { status: 400 });
    }

    // Branch on whether the POST created the linked lot (created_lot), with
    // listing_mode as the fallback signal for rows that predate the column:
    //
    // - Linked-but-not-created (replenish against an open pre-existing lot):
    //   the lot was never grown by the POST. Do not touch inventory_ledger.
    //   Just remove the batch item.
    //
    // - Created lot (CREATE_NEW always; REPLENISH_EXISTING restock fallback):
    //   Decrement quantity and quantity_remaining by item.quantity. If the lot
    //   has already had units consumed by FIFO (quantity_remaining < quantity
    //   sold's worth), fail closed so we never roll back inventory that's
    //   already attributed to a sale.
    //
    // - Legacy rows (inventory_ledger_id IS NULL): fall back to the pre-bridge
    //   behavior — decrement by SKU with Math.max guards. Preserves correctness
    //   for batch items created before this commit.
    const LOT_CONSUMED = 'LOT_CONSUMED_FIFO_ALREADY_RAN';

    const rollback = db.transaction(() => {
      const item = db.prepare(`
        SELECT sku, quantity, listing_mode, inventory_ledger_id, created_lot
        FROM listing_batch_items
        WHERE id = ? AND batch_id = ?
      `).get(itemIdNum, batchId) as {
        sku: string;
        quantity: number;
        listing_mode: string | null;
        inventory_ledger_id: number | null;
        created_lot: number | null;
      } | undefined;
      if (!item) return null;

      affectedSku = item.sku;
      const mode = item.listing_mode || 'CREATE_NEW';
      // Pre-column rows have created_lot NULL — for those, CREATE_NEW was the
      // only mode that inserted a lot.
      const createdLot = item.created_lot != null
        ? item.created_lot === 1
        : mode !== 'REPLENISH_EXISTING';

      if (!createdLot) {
        // Pre-existing real inventory. Touch nothing on inventory_ledger.
      } else if (item.inventory_ledger_id != null) {
        // CREATE_NEW with a linked lot (new path from this commit forward).
        const ledger = db.prepare(
          'SELECT id, quantity, quantity_remaining FROM inventory_ledger WHERE id = ?'
        ).get(item.inventory_ledger_id) as
          { id: number; quantity: number; quantity_remaining: number } | undefined;
        if (ledger) {
          if (ledger.quantity < item.quantity || ledger.quantity_remaining < item.quantity) {
            // FIFO has already consumed units from this lot. Rolling back the
            // decrement would either go negative or contradict cogs already
            // attributed to orders. Fail closed; the user can resolve via the
            // inventory-lots admin path.
            throw new Error(LOT_CONSUMED);
          }
          const newQty = ledger.quantity - item.quantity;
          const newRemaining = ledger.quantity_remaining - item.quantity;
          if (newQty === 0) {
            db.prepare('DELETE FROM inventory_ledger WHERE id = ?').run(ledger.id);
          } else {
            db.prepare(
              'UPDATE inventory_ledger SET quantity = ?, quantity_remaining = ? WHERE id = ?'
            ).run(newQty, newRemaining, ledger.id);
          }
          ledgerChanged = true;
        }
      } else {
        // Legacy fallback: batch item predates inventory_ledger_id population.
        // Use the pre-bridge SKU-based decrement so existing rows keep working.
        const ledger = db.prepare(
          'SELECT id, quantity, quantity_remaining FROM inventory_ledger WHERE sku = ?'
        ).get(item.sku) as { id: number; quantity: number; quantity_remaining: number } | undefined;
        if (ledger) {
          const newQty = Math.max(0, ledger.quantity - item.quantity);
          const newRemaining = Math.max(0, ledger.quantity_remaining - item.quantity);
          if (newQty === 0) {
            db.prepare('DELETE FROM inventory_ledger WHERE id = ?').run(ledger.id);
          } else {
            db.prepare(
              'UPDATE inventory_ledger SET quantity = ?, quantity_remaining = ? WHERE id = ?'
            ).run(newQty, newRemaining, ledger.id);
          }
          ledgerChanged = true;
        }
      }

      // Be explicit instead of relying only on ON DELETE CASCADE; this route
      // has historically been used by connections with foreign_keys disabled.
      deleteListingBatchItemChildren(db, itemIdNum);
      db.prepare('DELETE FROM listing_batch_items WHERE id = ? AND batch_id = ?').run(itemIdNum, batchId);
      db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), batchId);
      return item;
    });

    let removed;
    try {
      removed = rollback();
    } catch (txErr) {
      db.close();
      const msg = txErr instanceof Error ? txErr.message : String(txErr);
      if (msg === 'LOT_CONSUMED_FIFO_ALREADY_RAN') {
        return NextResponse.json(
          {
            error:
              'Cannot remove this item: its inventory lot has already had units consumed by recorded sales. Adjust the lot directly via the inventory-lots admin path.',
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    db.close();

    // Only re-run FIFO when a lot actually changed. Replenish deletes touch
    // no ledger row, so FIFO has nothing to re-allocate.
    if (ledgerChanged && affectedSku) {
      try { recalculateFIFO({ sku: affectedSku }); } catch { /* best effort */ }
    }

    return NextResponse.json({ success: true, removed });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
