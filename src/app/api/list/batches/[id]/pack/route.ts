/**
 * POST /api/list/batches/[id]/pack
 *
 * Pushes the user's declared boxes to Amazon. Flow:
 *   1. Read the boxes from listing_batch_boxes (must exist; user goes through
 *      the Boxing UI first, which populates them via POST /boxes).
 *   2. Call generatePackingOptions — Amazon runs async optimization, returns
 *      an operationId. Save it and poll until SUCCESS.
 *   3. Call listPackingOptions to get the packingOptionId we'll confirm.
 *      (For basic FBA batches there's usually just one option — the one
 *      implied by our single pack group.)
 *   4. Call setPackingInformation with our boxes: dimensions, weight,
 *      contents. This tells Amazon what's physically in the boxes.
 *   5. Call confirmPackingOption with the option ID from step 3. This gates
 *      the inbound plan from packing → placement.
 *   6. Persist packing_status = SUCCESS + packing_option_id on the batch.
 *   7. Transition batch: boxing → placement.
 *
 * On any SP-API failure, the batch stays in 'boxing' status with
 * packing_error set so the user can retry.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import {
  generatePackingOptions,
  listPackingOptions,
  setPackingInformation,
  confirmPackingOption,
  getInboundOperation,
} from '@/lib/sp-api/inboundPlansV2';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;
  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    refreshToken: settings.refreshToken,
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

/**
 * Small helper: block on an async operationId until it reaches SUCCESS/FAILED
 * or we hit maxWaitMs. Polls at 3s intervals.
 */
async function waitForOperation(
  creds: SPAPICredentials,
  operationId: string,
  maxWaitMs: number
): Promise<{ success: boolean; error?: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const op = await getInboundOperation(creds, operationId);
      if (op.operationStatus === 'SUCCESS') return { success: true };
      if (op.operationStatus === 'FAILED') {
        return { success: false, error: JSON.stringify(op.operationProblems) };
      }
    } catch (err) {
      return { success: false, error: String(err) };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { success: false, error: `Operation ${operationId} still IN_PROGRESS after ${maxWaitMs}ms` };
}

export async function POST(
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
    // Load batch and verify state
    const batch = db.prepare(`
      SELECT id, status, channel,
             inbound_plan_id as inboundPlanId,
             packing_option_id
      FROM listing_batches WHERE id = ?
    `).get(batchId) as any;

    if (!batch) {
      db.close();
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.channel !== 'FBA') {
      db.close();
      return NextResponse.json({ error: 'Packing is only for FBA batches' }, { status: 400 });
    }
    if (batch.status !== 'boxing') {
      db.close();
      return NextResponse.json({
        error: `Batch must be in 'boxing' status (currently: ${batch.status}). Save boxes first.`,
      }, { status: 400 });
    }
    if (!batch.inboundPlanId) {
      db.close();
      return NextResponse.json({ error: 'Batch has no inbound plan id' }, { status: 400 });
    }

    // Load boxes + their items + pack group info.
    // packing_group_id is required if the batch is multi-group; for
    // single-group it can be null and we'll fill it from the batch's groups.
    const boxes = db.prepare(`
      SELECT id, box_index as boxIndex, length_in as lengthIn, width_in as widthIn,
             height_in as heightIn, weight_lb as weightLb,
             packing_group_id as packingGroupId
      FROM listing_batch_boxes
      WHERE batch_id = ?
      ORDER BY box_index ASC
    `).all(batchId) as Array<{ id: number; boxIndex: number; lengthIn: number; widthIn: number; heightIn: number; weightLb: number; packingGroupId: string | null }>;

    if (boxes.length === 0) {
      db.close();
      return NextResponse.json({ error: 'Batch has no boxes. Save boxes first.' }, { status: 400 });
    }

    const boxItems = db.prepare(`
      SELECT bi.box_id as boxId, lbi.sku as msku, bi.quantity
      FROM listing_batch_box_items bi
      INNER JOIN listing_batch_items lbi ON lbi.id = bi.item_id
      INNER JOIN listing_batch_boxes b ON b.id = bi.box_id
      WHERE b.batch_id = ?
    `).all(batchId) as { boxId: number; msku: string; quantity: number }[];

    // Pack groups (Amazon's split). For multi-group batches, every box must
    // declare its packingGroupId. For single-group, we'll auto-fill it.
    const packGroups = db.prepare(`
      SELECT packing_group_id as packingGroupId
      FROM listing_batch_pack_groups WHERE batch_id = ?
      ORDER BY group_index ASC
    `).all(batchId) as Array<{ packingGroupId: string }>;

    // Get credentials
    const creds = getAmazonCredentials(db);
    const cachedPackingOptionId = batch.packing_option_id;
    db.close();
    if (!creds) {
      return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
    }
    clearTokenCache();

    // Mark packing in-progress
    updateBatchPacking(batchId, { status: 'IN_PROGRESS', error: null });

    // Step 1: get the packing option ID. If initialize-boxing was already
    // called (which it should have been when the user clicked "Box & Ship"),
    // we have it cached. Otherwise generate fresh.
    let packingOptionId: string;
    let validGroupIds: string[];
    if (cachedPackingOptionId && packGroups.length > 0) {
      packingOptionId = cachedPackingOptionId;
      validGroupIds = packGroups.map((g) => g.packingGroupId);
      console.log(`[pack] Using cached packingOptionId=${packingOptionId} with ${validGroupIds.length} group(s)`);
    } else {
      // Fallback: generate now (legacy path for batches that skipped initialize-boxing)
      let packingOp: { operationId: string };
      try {
        packingOp = await generatePackingOptions(creds, batch.inboundPlanId);
      } catch (err) {
        updateBatchPacking(batchId, { status: 'FAILED', error: `generatePackingOptions: ${err}` });
        return NextResponse.json({ error: String(err) }, { status: 500 });
      }
      updateBatchPacking(batchId, { operationId: packingOp.operationId, status: 'IN_PROGRESS' });
      const op1 = await waitForOperation(creds, packingOp.operationId, 120_000);
      if (!op1.success) {
        updateBatchPacking(batchId, { status: 'FAILED', error: `generatePackingOptions op failed: ${op1.error}` });
        return NextResponse.json({ error: op1.error }, { status: 500 });
      }
      let packingOptions: any[];
      try {
        packingOptions = await listPackingOptions(creds, batch.inboundPlanId);
      } catch (err) {
        updateBatchPacking(batchId, { status: 'FAILED', error: `listPackingOptions: ${err}` });
        return NextResponse.json({ error: String(err) }, { status: 500 });
      }
      if (packingOptions.length === 0) {
        updateBatchPacking(batchId, { status: 'FAILED', error: 'Amazon returned no packing options' });
        return NextResponse.json({ error: 'No packing options available' }, { status: 500 });
      }
      const packingOption = packingOptions[0];
      packingOptionId = packingOption.packingOptionId;
      validGroupIds = packingOption.packingGroups || [];
      if (!packingOptionId || validGroupIds.length === 0) {
        updateBatchPacking(batchId, {
          status: 'FAILED',
          error: `Packing option missing IDs: ${JSON.stringify(packingOption)}`,
        });
        return NextResponse.json({ error: 'Packing option missing required IDs' }, { status: 500 });
      }
    }

    updateBatchPacking(batchId, { optionId: packingOptionId });

    // Step 2: build packageGroupings — ONE entry per pack group, each with
    // its own boxes. For multi-group batches, boxes are filtered by their
    // packing_group_id. For single-group batches, all boxes go into the
    // single group.
    const isMultiGroup = validGroupIds.length > 1;
    const packageGroupings = validGroupIds.map((groupId) => {
      const groupBoxes = isMultiGroup
        ? boxes.filter((b) => b.packingGroupId === groupId)
        : boxes; // single-group: all boxes belong to that group
      return {
        packingGroupId: groupId,
        boxes: groupBoxes.map((box) => ({
          contentInformationSource: 'BOX_CONTENT_PROVIDED' as const,
          dimensions: {
            unitOfMeasurement: 'IN' as const,
            length: box.lengthIn,
            width: box.widthIn,
            height: box.heightIn,
          },
          weight: {
            unit: 'LB' as const,
            value: box.weightLb,
          },
          quantity: 1,
          items: boxItems
            .filter((bi) => bi.boxId === box.id)
            .map((bi) => ({ msku: bi.msku, quantity: bi.quantity })),
        })),
      };
    });

    // Sanity check: every group must have at least one box
    for (const grouping of packageGroupings) {
      if (grouping.boxes.length === 0) {
        updateBatchPacking(batchId, {
          status: 'FAILED',
          error: `Pack group ${grouping.packingGroupId} has no boxes assigned. Pack each group separately.`,
        });
        return NextResponse.json({
          error: `Pack group ${grouping.packingGroupId} has no boxes assigned. Pack each group separately.`,
        }, { status: 400 });
      }
    }

    console.log(`[pack] Sending ${packageGroupings.length} pack group(s) with ${boxes.length} total box(es) to setPackingInformation`);

    let setPackingOp: { operationId: string };
    try {
      setPackingOp = await setPackingInformation(creds, batch.inboundPlanId, packageGroupings);
    } catch (err) {
      updateBatchPacking(batchId, { status: 'FAILED', error: `setPackingInformation: ${err}` });
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }

    // If setPackingInformation returned an operation id, wait for it.
    if (setPackingOp.operationId) {
      const op2 = await waitForOperation(creds, setPackingOp.operationId, 120_000);
      if (!op2.success) {
        updateBatchPacking(batchId, { status: 'FAILED', error: `setPackingInformation op failed: ${op2.error}` });
        return NextResponse.json({ error: op2.error }, { status: 500 });
      }
    }

    // 4. confirmPackingOption — commits to the chosen option.
    let confirmOp: { operationId: string };
    try {
      confirmOp = await confirmPackingOption(creds, batch.inboundPlanId, packingOptionId);
    } catch (err) {
      updateBatchPacking(batchId, { status: 'FAILED', error: `confirmPackingOption: ${err}` });
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }

    if (confirmOp.operationId) {
      const op3 = await waitForOperation(creds, confirmOp.operationId, 120_000);
      if (!op3.success) {
        updateBatchPacking(batchId, { status: 'FAILED', error: `confirmPackingOption op failed: ${op3.error}` });
        return NextResponse.json({ error: op3.error }, { status: 500 });
      }
    }

    // Success — transition batch to 'placement' and mark packing complete.
    const db2 = getDb();
    try {
      db2.prepare(`
        UPDATE listing_batches SET
          status = 'placement',
          packing_status = 'SUCCESS',
          packing_confirmed_at = ?,
          packing_error = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), new Date().toISOString(), batchId);
    } finally {
      db2.close();
    }

    return NextResponse.json({
      success: true,
      packingOptionId,
      packGroups: validGroupIds,
      boxCount: boxes.length,
    });
  } catch (err) {
    try { db.close(); } catch {}
    updateBatchPacking(batchId, { status: 'FAILED', error: `Unexpected error: ${err}` });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function updateBatchPacking(
  batchId: number,
  fields: { status?: string; error?: string | null; operationId?: string; optionId?: string; groupId?: string }
) {
  const db = getDb();
  try {
    const sets: string[] = [];
    const values: any[] = [];
    if (fields.status !== undefined) { sets.push('packing_status = ?'); values.push(fields.status); }
    if (fields.error !== undefined) { sets.push('packing_error = ?'); values.push(fields.error); }
    if (fields.operationId !== undefined) { sets.push('packing_operation_id = ?'); values.push(fields.operationId); }
    if (fields.optionId !== undefined) { sets.push('packing_option_id = ?'); values.push(fields.optionId); }
    if (fields.groupId !== undefined) { sets.push('packing_group_id = ?'); values.push(fields.groupId); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(batchId);
    db.prepare(`UPDATE listing_batches SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  } finally {
    db.close();
  }
}
