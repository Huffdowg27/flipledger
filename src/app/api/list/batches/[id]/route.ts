/**
 * Single batch API.
 *
 * GET    /api/list/batches/[id]  - get batch + its items
 * PATCH  /api/list/batches/[id]  - update batch (name, status, ship-from, etc.)
 * DELETE /api/list/batches/[id]  - delete a draft batch
 */
import { NextRequest, NextResponse } from 'next/server';
import { recalculateFIFO } from '@/lib/fifo';
import { pushBatchCostToInformed } from '@/lib/informed';
import { deleteListingBatchChildren } from '@/lib/listing-batch-cleanup';
import { manualBatchTransitionError } from '@/lib/listing-batch-lifecycle';
import { openFlipLedgerDb } from '@/lib/sqlite';

function getDb() {
  return openFlipLedgerDb();
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
        transportation_operation_id as transportationOperationId,
        transportation_option_id as transportationOptionId,
        transportation_status as transportationStatus,
        transportation_confirmed_at as transportationConfirmedAt,
        transportation_error as transportationError,
        confirmed_shipments as confirmedShipments,
        confirmed_shipment_ids as confirmedShipmentIds,
        notes,
        closed_at as closedAt,
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
        listing_mode as listingMode,
        fnsku,
        labels_printed_at as labelsPrintedAt,
        created_at as createdAt
      FROM listing_batch_items
      WHERE batch_id = ?
      ORDER BY created_at DESC, id DESC
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
    if (body.status !== undefined) {
      if (Object.keys(body).some((key) => key !== 'status')) {
        return NextResponse.json({
          error: 'A manual status transition must be requested by itself',
        }, { status: 400 });
      }
      const existing = db.prepare(`
        SELECT status, channel
        FROM listing_batches
        WHERE id = ?
      `).get(batchId) as { status: string; channel: 'FBA' | 'MFN' } | undefined;
      if (!existing) {
        return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
      }
      const transitionError = manualBatchTransitionError({
        from: existing.status,
        to: String(body.status),
        channel: existing.channel,
      });
      if (transitionError) {
        return NextResponse.json({ error: transitionError }, { status: 409 });
      }
    }

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

    const now = new Date().toISOString();

    // Lifecycle: stamp closed_at the first time a batch transitions to 'closed'
    // (idempotent — re-closing keeps the original timestamp); clear it if the
    // batch is reopened to any non-closed status.
    let justClosed = false;
    if (body.status === 'closed') {
      const existing = db.prepare('SELECT closed_at FROM listing_batches WHERE id = ?').get(batchId) as { closed_at: string | null } | undefined;
      if (existing && !existing.closed_at) {
        sets.push('closed_at = ?');
        values.push(now);
        justClosed = true;
      }
    } else if (body.status !== undefined) {
      sets.push('closed_at = NULL');
    }

    sets.push('updated_at = ?');
    values.push(now);
    values.push(batchId);

    db.prepare(`UPDATE listing_batches SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    // On the first close (auto or manual), push this batch's per-unit buy cost
    // to Informed Repricer. Best-effort — never blocks the close.
    let informed: Awaited<ReturnType<typeof pushBatchCostToInformed>> | undefined;
    if (justClosed) {
      informed = await pushBatchCostToInformed(db, batchId);
      if (!informed.ok && !informed.skipped) {
        console.error(`[informed] batch ${batchId} cost push failed:`, informed.error);
      }
    }

    return NextResponse.json({ success: true, informed });
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
  // Thrown inside the transaction to abort the WHOLE delete (fail closed) when
  // a created lot has already had units consumed by FIFO — never corrupt real
  // inventory to satisfy a delete.
  const LOT_CONSUMED = 'LOT_CONSUMED_FIFO_ALREADY_RAN';
  try {
    // Draft/failed batches are deletable only when no remote workflow step has
    // succeeded. A draft may already have prepared listings, and a failed send
    // may have created some listings or an inbound plan before a later step
    // failed. Preserve those batches as the local audit trail.
    const batch = db.prepare(`
      SELECT status, inbound_plan_id, inbound_operation_id, plan_status,
             packing_operation_id, packing_option_id, packing_status,
             placement_operation_id, placement_option_id, placement_status,
             transportation_operation_id, transportation_option_id, transportation_status,
             confirmed_shipment_ids
      FROM listing_batches
      WHERE id = ?
    `).get(batchId) as {
      status: string;
      inbound_plan_id: string | null;
      inbound_operation_id: string | null;
      plan_status: string | null;
      packing_operation_id: string | null;
      packing_option_id: string | null;
      packing_status: string | null;
      placement_operation_id: string | null;
      placement_option_id: string | null;
      placement_status: string | null;
      transportation_operation_id: string | null;
      transportation_option_id: string | null;
      transportation_status: string | null;
      confirmed_shipment_ids: string | null;
    } | undefined;
    if (!batch) {
      db.close();
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.status !== 'draft' && batch.status !== 'failed') {
      db.close();
      return NextResponse.json({ error: `Cannot delete batch in status: ${batch.status}` }, { status: 400 });
    }
    const remoteBatchState = Object.entries(batch)
      .some(([key, value]) => key !== 'status' && value != null && value !== '');
    // Replenishment drafts can prefill fnsku before any Amazon work. Treat
    // fnsku as remote evidence only once Amazon has accepted a submission.
    const remoteItemState = !!db.prepare(`
      SELECT 1
      FROM listing_batch_items
      WHERE batch_id = ?
        AND (
          listing_submission_id IS NOT NULL
          OR listing_status IN ('PROCESSING', 'ACTIVE')
        )
      LIMIT 1
    `).get(batchId);
    if (remoteBatchState || remoteItemState) {
      db.close();
      return NextResponse.json({
        error: 'Cannot delete this batch because Amazon/listing work has already partially succeeded. Preserve the audit trail; use Cancel & Edit or close the batch instead.',
      }, { status: 409 });
    }

    // Roll back each item's inventory contribution using the SAME lot-aware
    // logic as the item-level DELETE (items/[itemId]/route.ts), then delete the
    // batch and its associated rows — all in one transaction.
    //
    // Branch per item on created_lot + inventory_ledger_id:
    //   - created_lot false: the lot was a pre-existing real lot the POST only
    //     replenished against (REPLENISH_EXISTING). The POST never grew it, so
    //     deleting the batch must NOT touch inventory_ledger.
    //   - created_lot true + inventory_ledger_id present: roll back ONLY that
    //     linked lot. If FIFO already consumed from it, fail closed (409).
    //   - inventory_ledger_id NULL (legacy rows): isolated SKU-based fallback
    //     with Math.max guards, preserving pre-bridge behavior.
    const cascade = db.transaction(() => {
      const items = db.prepare(`
        SELECT id, sku, quantity, listing_mode, inventory_ledger_id, created_lot
        FROM listing_batch_items WHERE batch_id = ?
      `).all(batchId) as Array<{
        id: number;
        sku: string;
        quantity: number;
        listing_mode: string | null;
        inventory_ledger_id: number | null;
        created_lot: number | null;
      }>;

      for (const item of items) {
        const mode = item.listing_mode || 'CREATE_NEW';
        // Pre-column rows have created_lot NULL — for those, CREATE_NEW was the
        // only mode that inserted a lot.
        const createdLot = item.created_lot != null
          ? item.created_lot === 1
          : mode !== 'REPLENISH_EXISTING';

        if (!createdLot) {
          // Pre-existing real inventory. Touch nothing.
          continue;
        }

        if (item.inventory_ledger_id != null) {
          // Created lot with an explicit link (current path) — roll back only it.
          const ledger = db.prepare(
            'SELECT id, quantity, quantity_remaining FROM inventory_ledger WHERE id = ?'
          ).get(item.inventory_ledger_id) as
            { id: number; quantity: number; quantity_remaining: number } | undefined;
          if (!ledger) continue;
          if (ledger.quantity < item.quantity || ledger.quantity_remaining < item.quantity) {
            // FIFO has already consumed units from this lot; rolling back would
            // go negative or contradict COGS attributed to orders. Fail closed.
            throw new Error(LOT_CONSUMED);
          }
          const newQty = ledger.quantity - item.quantity;
          const newRemaining = ledger.quantity_remaining - item.quantity;
          if (newQty === 0) {
            db.prepare('DELETE FROM inventory_ledger WHERE id = ?').run(ledger.id);
          } else {
            db.prepare('UPDATE inventory_ledger SET quantity = ?, quantity_remaining = ? WHERE id = ?')
              .run(newQty, newRemaining, ledger.id);
          }
          affectedSkus.add(item.sku);
        } else {
          // Legacy fallback (isolated + documented): batch item predates the
          // inventory_ledger_id column. Decrement by SKU with Math.max guards.
          const ledger = db.prepare(
            'SELECT id, quantity, quantity_remaining FROM inventory_ledger WHERE sku = ?'
          ).get(item.sku) as { id: number; quantity: number; quantity_remaining: number } | undefined;
          if (!ledger) continue;
          const newQty = Math.max(0, ledger.quantity - item.quantity);
          const newRemaining = Math.max(0, ledger.quantity_remaining - item.quantity);
          if (newQty === 0) {
            db.prepare('DELETE FROM inventory_ledger WHERE id = ?').run(ledger.id);
          } else {
            db.prepare('UPDATE inventory_ledger SET quantity = ?, quantity_remaining = ? WHERE id = ?')
              .run(newQty, newRemaining, ledger.id);
          }
          affectedSkus.add(item.sku);
        }
      }

      // Delete explicit children first. This mirrors the item-level route and
      // keeps cleanup safe even if a future connection forgets foreign_keys.
      deleteListingBatchChildren(db, batchId);
      db.prepare('DELETE FROM listing_batch_items WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM listing_batches WHERE id = ?').run(batchId);
    });

    try {
      cascade();
    } catch (txErr) {
      db.close();
      const msg = txErr instanceof Error ? txErr.message : String(txErr);
      if (msg === LOT_CONSUMED) {
        return NextResponse.json({
          error: 'Cannot delete this batch: one of its inventory lots has already had units consumed by recorded sales. Resolve those lots via the inventory-lots admin path first.',
        }, { status: 409 });
      }
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    db.close();

    // Re-run FIFO only for SKUs whose ledger rows actually changed.
    for (const sku of affectedSkus) {
      try { recalculateFIFO({ sku }); } catch { /* best effort */ }
    }

    return NextResponse.json({ success: true, rolledBackSkus: Array.from(affectedSkus) });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
