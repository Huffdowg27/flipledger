/**
 * GET  /api/list/batches/[id]/boxes  — read all boxes (and the items in each)
 * POST /api/list/batches/[id]/boxes  — replace the boxes for a batch
 * PATCH /api/list/batches/[id]/boxes — update one box (dimensions/weight or assignments)
 *
 * This is pure FlipLedger state: dimensions, weight, and item-to-box
 * assignments for a ready FBA batch. No SP-API calls here. The separate
 * /api/list/batches/[id]/pack endpoint is what actually pushes this data up
 * to Amazon.
 *
 * Valid batch states for editing boxes: 'ready' and 'boxing'. 'ready' is the
 * state a batch is in right after Phase 2 (all listings live, inbound plan
 * created). 'boxing' is the state the batch transitions into the first time
 * the user saves boxes.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

interface BoxPayload {
  id?: number; // optional — present on update
  packingGroupId?: string; // Amazon pack group this box belongs to
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightLb: number;
  items: Array<{ itemId: number; quantity: number }>;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  const db = getDb();
  try {
    const batch = db.prepare('SELECT id, status, channel FROM listing_batches WHERE id = ?').get(batchId) as any;
    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }

    const boxes = db.prepare(`
      SELECT id, box_index as boxIndex, length_in as lengthIn, width_in as widthIn,
             height_in as heightIn, weight_lb as weightLb,
             packing_group_id as packingGroupId,
             created_at as createdAt, updated_at as updatedAt
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

    // Group box items by boxId
    const boxesWithItems = boxes.map((box) => ({
      ...box,
      items: boxItems.filter((bi) => bi.boxId === box.id),
    }));

    return NextResponse.json({ boxes: boxesWithItems });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}

/**
 * POST replaces all boxes for a batch in a single transaction. Simpler than
 * fine-grained CRUD — the frontend always sends the complete list.
 *
 * Validates:
 *   - batch exists and is in 'ready' or 'boxing' status
 *   - every item in every box references an existing batch item
 *   - the sum of (item_id, qty) across all boxes exactly matches the batch
 *     items' quantities (no item under- or over-allocated)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  let body: { boxes: BoxPayload[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(body.boxes)) {
    return NextResponse.json({ error: 'Body must include a boxes array' }, { status: 400 });
  }

  const db = getDb();
  try {
    const batch = db.prepare('SELECT id, status, channel FROM listing_batches WHERE id = ?').get(batchId) as any;
    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.channel !== 'FBA') {
      return NextResponse.json({ error: 'Boxing is only for FBA batches' }, { status: 400 });
    }
    if (batch.status !== 'ready' && batch.status !== 'boxing') {
      return NextResponse.json({
        error: `Batch is in '${batch.status}' status — boxing is only allowed after the batch is ready and before packing is confirmed.`,
      }, { status: 400 });
    }

    // Load batch items to validate quantities
    const batchItems = db.prepare(`
      SELECT id, quantity FROM listing_batch_items WHERE batch_id = ?
    `).all(batchId) as { id: number; quantity: number }[];
    const itemQtyMap = new Map<number, number>();
    for (const it of batchItems) itemQtyMap.set(it.id, it.quantity);

    // Multi-pack-group: load pack groups + their item allocations.
    // For batches Amazon split into multiple groups, each box must declare
    // which group it belongs to, AND the items in that box must come from
    // that group's allocated items.
    const packGroups = db.prepare(`
      SELECT id, packing_group_id as packingGroupId
      FROM listing_batch_pack_groups WHERE batch_id = ?
    `).all(batchId) as Array<{ id: number; packingGroupId: string }>;
    const isMultiGroup = packGroups.length > 1;
    const validGroupIds = new Set(packGroups.map((g) => g.packingGroupId));

    // Map: packingGroupId → Map<itemId, qtyInGroup>
    const groupItemQtyMap: Record<string, Map<number, number>> = {};
    if (packGroups.length > 0) {
      for (const g of packGroups) {
        const items = db.prepare(`
          SELECT item_id as itemId, quantity FROM listing_batch_pack_group_items
          WHERE pack_group_id = ?
        `).all(g.id) as Array<{ itemId: number; quantity: number }>;
        const m = new Map<number, number>();
        for (const it of items) m.set(it.itemId, it.quantity);
        groupItemQtyMap[g.packingGroupId] = m;
      }
    }

    // Validate box items all reference real batch items
    const allocMap = new Map<number, number>(); // itemId → total quantity allocated overall
    // Per-group allocation: groupId → (itemId → allocated)
    const allocPerGroup: Record<string, Map<number, number>> = {};
    for (const box of body.boxes) {
      if (!box.items || !Array.isArray(box.items)) {
        return NextResponse.json({ error: 'Each box must include an items array' }, { status: 400 });
      }
      if (box.lengthIn == null || box.widthIn == null || box.heightIn == null || box.weightLb == null) {
        return NextResponse.json({ error: 'Each box needs length, width, height, and weight' }, { status: 400 });
      }
      if (box.lengthIn <= 0 || box.widthIn <= 0 || box.heightIn <= 0 || box.weightLb <= 0) {
        return NextResponse.json({ error: 'Box dimensions and weight must be greater than 0' }, { status: 400 });
      }
      // Multi-group validation
      if (isMultiGroup) {
        if (!box.packingGroupId) {
          return NextResponse.json({
            error: 'Each box must specify packingGroupId — this batch was split into multiple pack groups by Amazon.',
          }, { status: 400 });
        }
        if (!validGroupIds.has(box.packingGroupId)) {
          return NextResponse.json({
            error: `packingGroupId '${box.packingGroupId}' is not a valid group for this batch.`,
          }, { status: 400 });
        }
      }
      const groupKey = box.packingGroupId || (packGroups[0]?.packingGroupId || '__single__');
      if (!allocPerGroup[groupKey]) allocPerGroup[groupKey] = new Map();
      for (const bi of box.items) {
        if (!itemQtyMap.has(bi.itemId)) {
          return NextResponse.json({ error: `Unknown item id ${bi.itemId} in box` }, { status: 400 });
        }
        if (bi.quantity <= 0) {
          return NextResponse.json({ error: `Box item quantity must be > 0 (got ${bi.quantity})` }, { status: 400 });
        }
        // For multi-group: this item must be allocated to this group by Amazon
        if (isMultiGroup && box.packingGroupId) {
          const groupMap = groupItemQtyMap[box.packingGroupId];
          if (!groupMap || !groupMap.has(bi.itemId)) {
            return NextResponse.json({
              error: `Item ${bi.itemId} doesn't belong to pack group ${box.packingGroupId}. Check Amazon's group allocation.`,
            }, { status: 400 });
          }
        }
        allocMap.set(bi.itemId, (allocMap.get(bi.itemId) || 0) + bi.quantity);
        allocPerGroup[groupKey].set(bi.itemId, (allocPerGroup[groupKey].get(bi.itemId) || 0) + bi.quantity);
      }
    }

    // Every batch item must be fully allocated across boxes — no more, no less.
    for (const [itemId, expectedQty] of itemQtyMap.entries()) {
      const allocatedQty = allocMap.get(itemId) || 0;
      if (allocatedQty !== expectedQty) {
        return NextResponse.json({
          error: `Item ${itemId} has ${expectedQty} units in the batch but ${allocatedQty} allocated across boxes`,
        }, { status: 400 });
      }
    }

    // Multi-group: per-group allocations must match Amazon's group allocations
    if (isMultiGroup) {
      for (const g of packGroups) {
        const expected = groupItemQtyMap[g.packingGroupId];
        const actual = allocPerGroup[g.packingGroupId] || new Map();
        for (const [itemId, expectedQty] of expected.entries()) {
          const actualQty = actual.get(itemId) || 0;
          if (actualQty !== expectedQty) {
            return NextResponse.json({
              error: `Pack group ${g.packingGroupId}: item ${itemId} expected ${expectedQty} units but ${actualQty} allocated`,
            }, { status: 400 });
          }
        }
      }
    }

    // All good — replace boxes in a transaction.
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      // Wipe existing boxes (cascades to box_items via FK)
      db.prepare('DELETE FROM listing_batch_boxes WHERE batch_id = ?').run(batchId);

      // Insert new boxes (with optional packingGroupId for multi-group batches)
      const insertBox = db.prepare(`
        INSERT INTO listing_batch_boxes (batch_id, box_index, length_in, width_in, height_in, weight_lb, packing_group_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertBoxItem = db.prepare(`
        INSERT INTO listing_batch_box_items (box_id, item_id, quantity)
        VALUES (?, ?, ?)
      `);

      body.boxes.forEach((box, idx) => {
        const result = insertBox.run(
          batchId,
          idx + 1,
          box.lengthIn,
          box.widthIn,
          box.heightIn,
          box.weightLb,
          box.packingGroupId || null,
          now,
          now
        );
        const boxId = result.lastInsertRowid as number;
        for (const bi of box.items) {
          insertBoxItem.run(boxId, bi.itemId, bi.quantity);
        }
      });

      // Transition batch → boxing (if it was ready). Don't touch if already boxing.
      if (batch.status === 'ready') {
        db.prepare(`UPDATE listing_batches SET status = 'boxing', updated_at = ? WHERE id = ?`)
          .run(now, batchId);
      } else {
        db.prepare(`UPDATE listing_batches SET updated_at = ? WHERE id = ?`)
          .run(now, batchId);
      }
    });

    tx();

    return NextResponse.json({ success: true, boxCount: body.boxes.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
