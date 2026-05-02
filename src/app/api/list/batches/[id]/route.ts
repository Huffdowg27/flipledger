/**
 * Single batch API.
 *
 * GET    /api/list/batches/[id]  - get batch + its items
 * PATCH  /api/list/batches/[id]  - update batch (name, status, ship-from, etc.)
 * DELETE /api/list/batches/[id]  - delete a draft batch
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

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  const db = getDb();
  try {
    const batch = db.prepare(`
      SELECT
        id, name, status, channel, marketplace,
        inbound_plan_id as inboundPlanId,
        inbound_operation_id as inboundOperationId,
        plan_status as planStatus,
        send_error as sendError,
        sent_at as sentAt,
        ship_from_name as shipFromName,
        ship_from_address_line1 as shipFromAddressLine1,
        ship_from_city as shipFromCity,
        ship_from_state as shipFromState,
        ship_from_postal_code as shipFromPostalCode,
        ship_from_country_code as shipFromCountryCode,
        ship_from_phone as shipFromPhone,
        packing_operation_id as packingOperationId,
        packing_option_id as packingOptionId,
        packing_group_id as packingGroupId,
        packing_status as packingStatus,
        packing_confirmed_at as packingConfirmedAt,
        packing_error as packingError,
        placement_operation_id as placementOperationId,
        placement_option_id as placementOptionId,
        placement_status as placementStatus,
        placement_fee_cents as placementFeeCents,
        placement_confirmed_at as placementConfirmedAt,
        placement_error as placementError,
        notes,
        created_at as createdAt,
        updated_at as updatedAt
      FROM listing_batches WHERE id = ?
    `).get(batchId);

    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });

    const items = db.prepare(`
      SELECT
        id, batch_id as batchId, asin, sku, msku, product_name as productName, image_url as imageUrl,
        condition, quantity, list_price_cents as listPriceCents, buy_price_cents as buyPriceCents,
        supplier, purchase_date as purchaseDate,
        estimated_fee_cents as estimatedFeeCents,
        estimated_ship_cents as estimatedShipCents,
        listing_status as listingStatus,
        listing_submission_id as listingSubmissionId,
        listing_error as listingError,
        listing_updated_at as listingUpdatedAt,
        labels_printed_at as labelsPrintedAt,
        created_at as createdAt
      FROM listing_batch_items
      WHERE batch_id = ?
      ORDER BY created_at ASC
    `).all(batchId);

    // Phase 3: include boxes + box-item assignments if any exist
    const boxes = db.prepare(`
      SELECT id, box_index as boxIndex, length_in as lengthIn, width_in as widthIn,
             height_in as heightIn, weight_lb as weightLb,
             packing_group_id as packingGroupId
      FROM listing_batch_boxes
      WHERE batch_id = ?
      ORDER BY box_index ASC
    `).all(batchId) as any[];

    const boxItems = db.prepare(`
      SELECT bi.id, bi.box_id as boxId, bi.item_id as itemId, bi.quantity
      FROM listing_batch_box_items bi
      INNER JOIN listing_batch_boxes b ON b.id = bi.box_id
      WHERE b.batch_id = ?
    `).all(batchId) as any[];

    const boxesWithItems = boxes.map((box) => ({
      ...box,
      items: boxItems.filter((bi) => bi.boxId === box.id),
    }));

    // Phase 3 multi-group: pack groups Amazon assigned for this batch.
    // Empty for batches that haven't initialized boxing yet, or for batches
    // where Amazon proposed a single group.
    const packGroups = db.prepare(`
      SELECT id, packing_group_id as packingGroupId, group_index as groupIndex
      FROM listing_batch_pack_groups WHERE batch_id = ?
      ORDER BY group_index ASC
    `).all(batchId) as any[];

    const packGroupItems = db.prepare(`
      SELECT pgi.pack_group_id as packGroupId, pgi.item_id as itemId, pgi.quantity,
             lbi.sku, lbi.product_name as productName
      FROM listing_batch_pack_group_items pgi
      INNER JOIN listing_batch_items lbi ON lbi.id = pgi.item_id
      INNER JOIN listing_batch_pack_groups pg ON pg.id = pgi.pack_group_id
      WHERE pg.batch_id = ?
    `).all(batchId) as any[];

    const packGroupsWithItems = packGroups.map((g) => ({
      ...g,
      items: packGroupItems.filter((it) => it.packGroupId === g.id),
    }));

    return NextResponse.json({
      batch,
      items,
      boxes: boxesWithItems,
      packGroups: packGroupsWithItems,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  const body = await request.json();
  const db = getDb();
  try {
    // Build a dynamic update — only patch the columns present in the body
    const fieldMap: Record<string, string> = {
      name: 'name',
      status: 'status',
      channel: 'channel',
      shipFromName: 'ship_from_name',
      shipFromAddressLine1: 'ship_from_address_line1',
      shipFromCity: 'ship_from_city',
      shipFromState: 'ship_from_state',
      shipFromPostalCode: 'ship_from_postal_code',
      shipFromCountryCode: 'ship_from_country_code',
      shipFromPhone: 'ship_from_phone',
      inboundPlanId: 'inbound_plan_id',
      notes: 'notes',
    };

    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, col] of Object.entries(fieldMap)) {
      if (body[key] !== undefined) {
        sets.push(`${col} = ?`);
        values.push(body[key]);
      }
    }
    if (sets.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(batchId);

    db.prepare(`UPDATE listing_batches SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  const db = getDb();
  const affectedSkus = new Set<string>();
  try {
    // Allow deleting batches that haven't been successfully sent to Amazon.
    // Draft: never sent. Failed: send attempt didn't complete. Both are safe
    // to delete — no Amazon state was committed. Block delete on ready/sending
    // so we don't accidentally nuke a batch Amazon already has.
    const batch = db.prepare('SELECT status FROM listing_batches WHERE id = ?').get(batchId) as any;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.status !== 'draft' && batch.status !== 'failed') {
      return NextResponse.json({ error: `Cannot delete batch in status: ${batch.status}` }, { status: 400 });
    }

    // Roll back every item's inventory_ledger contribution, then delete.
    const cascade = db.transaction(() => {
      const items = db.prepare('SELECT sku, quantity FROM listing_batch_items WHERE batch_id = ?').all(batchId) as any[];
      for (const item of items) {
        affectedSkus.add(item.sku);
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
      }
      db.prepare('DELETE FROM listing_batch_items WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM listing_batches WHERE id = ?').run(batchId);
    });

    cascade();
    db.close();

    // Re-run FIFO for every affected SKU
    for (const sku of affectedSkus) {
      try { recalculateFIFO({ sku }); } catch { /* best effort */ }
    }

    return NextResponse.json({ success: true, rolledBackSkus: Array.from(affectedSkus) });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
