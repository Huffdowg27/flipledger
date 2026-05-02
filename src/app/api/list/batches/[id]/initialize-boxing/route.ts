/**
 * POST /api/list/batches/[id]/initialize-boxing
 *
 * Called when the user clicks "Box & Ship" on a 'ready' batch. This:
 *   1. Calls generatePackingOptions on Amazon (async op, ~5-30s)
 *   2. Lists the packing options that come back
 *   3. Picks the first option (usually the only one for small/medium batches)
 *   4. For each pack group in that option, calls listPackingGroupItems to
 *      learn which items belong to which group
 *   5. Saves the groups + their items to local DB
 *   6. Saves packing_option_id on the batch
 *
 * Idempotent: if pack groups already exist for this batch, just return them
 * (no Amazon call). Lets the user revisit the page without re-fetching.
 *
 * Why upfront: Amazon may split a batch into multiple pack groups (e.g.,
 * bulky items separate from standard). The user needs to box each group
 * separately, so we must know the group structure BEFORE the boxing UI
 * renders. Doing it lazily during "Confirm packing" is too late.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import {
  generatePackingOptions,
  listPackingOptions,
  listPackingGroupItems,
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

async function waitForOperation(
  creds: SPAPICredentials,
  operationId: string,
  maxWaitMs: number = 120_000
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
  return { success: false, error: `Operation ${operationId} did not complete within ${maxWaitMs}ms` };
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  const db = getDb();
  let creds: SPAPICredentials | null;
  let inboundPlanId: string | null;
  let packingOptionId: string | null;
  try {
    const batch = db.prepare(`
      SELECT id, status, channel, inbound_plan_id as inboundPlanId, packing_option_id as packingOptionId
      FROM listing_batches WHERE id = ?
    `).get(batchId) as { id: number; status: string; channel: string; inboundPlanId: string | null; packingOptionId: string | null } | undefined;

    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.channel !== 'FBA') {
      return NextResponse.json({ error: 'Boxing is only for FBA batches' }, { status: 400 });
    }
    if (!['ready', 'boxing'].includes(batch.status)) {
      return NextResponse.json({
        error: `Cannot initialize boxing in status: ${batch.status}. Must be 'ready' or 'boxing'.`,
      }, { status: 400 });
    }
    if (!batch.inboundPlanId) {
      return NextResponse.json({ error: 'Batch has no inbound plan id' }, { status: 400 });
    }

    // Check if we already have pack groups cached
    const existingGroups = db.prepare(`
      SELECT id, packing_group_id as packingGroupId, group_index as groupIndex
      FROM listing_batch_pack_groups WHERE batch_id = ?
      ORDER BY group_index ASC
    `).all(batchId) as Array<{ id: number; packingGroupId: string; groupIndex: number }>;

    if (existingGroups.length > 0 && batch.packingOptionId) {
      // Idempotent — return existing data
      const groupsWithItems = existingGroups.map((g) => {
        const items = db.prepare(`
          SELECT pgi.item_id as itemId, pgi.quantity, lbi.sku, lbi.product_name as productName
          FROM listing_batch_pack_group_items pgi
          INNER JOIN listing_batch_items lbi ON lbi.id = pgi.item_id
          WHERE pgi.pack_group_id = ?
        `).all(g.id) as any[];
        return { ...g, items };
      });
      return NextResponse.json({
        success: true,
        cached: true,
        packingOptionId: batch.packingOptionId,
        packGroups: groupsWithItems,
      });
    }

    creds = getAmazonCredentials(db);
    inboundPlanId = batch.inboundPlanId;
    packingOptionId = batch.packingOptionId;
  } finally {
    db.close();
  }

  if (!creds) {
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  clearTokenCache();

  // Step 1: Generate packing options if not already done
  let packingOptions: any[];
  try {
    packingOptions = await listPackingOptions(creds, inboundPlanId!);
    if (packingOptions.length === 0) {
      // No options yet — generate them
      console.log('[init-boxing] No packing options found, generating…');
      const op = await generatePackingOptions(creds, inboundPlanId!);
      const result = await waitForOperation(creds, op.operationId, 180_000);
      if (!result.success) {
        return NextResponse.json({ error: `generatePackingOptions failed: ${result.error}` }, { status: 500 });
      }
      packingOptions = await listPackingOptions(creds, inboundPlanId!);
    }
  } catch (err) {
    return NextResponse.json({ error: `Failed to fetch packing options: ${err}` }, { status: 500 });
  }

  if (packingOptions.length === 0) {
    return NextResponse.json({ error: 'Amazon returned no packing options' }, { status: 500 });
  }

  // Step 2: Pick the first option, fetch items per group
  const packingOption = packingOptions[0];
  const newPackingOptionId: string = packingOption.packingOptionId;
  const groupIds: string[] = packingOption.packingGroups || [];

  if (groupIds.length === 0) {
    return NextResponse.json({ error: 'Packing option has no pack groups' }, { status: 500 });
  }

  // Fetch items for each group
  type GroupItem = { msku: string; quantity: number };
  const groupsWithItems: Array<{ packingGroupId: string; items: GroupItem[] }> = [];
  for (const groupId of groupIds) {
    try {
      const items = await listPackingGroupItems(creds, inboundPlanId!, groupId);
      groupsWithItems.push({ packingGroupId: groupId, items: items.map((i) => ({ msku: i.msku, quantity: i.quantity })) });
    } catch (err) {
      return NextResponse.json({ error: `Failed to fetch items for group ${groupId}: ${err}` }, { status: 500 });
    }
  }

  // Step 3: Save to local DB
  const db2 = getDb();
  const now = new Date().toISOString();
  let savedGroups: Array<{ id: number; packingGroupId: string; groupIndex: number; items: any[] }> = [];
  try {
    const tx = db2.transaction(() => {
      // Save packing option ID on batch
      db2.prepare(`UPDATE listing_batches SET packing_option_id = ?, updated_at = ? WHERE id = ?`)
        .run(newPackingOptionId, now, batchId);

      // Wipe any prior pack groups (idempotent reset)
      db2.prepare('DELETE FROM listing_batch_pack_groups WHERE batch_id = ?').run(batchId);

      // For each group: insert and link items
      groupsWithItems.forEach((g, idx) => {
        const groupResult = db2.prepare(`
          INSERT INTO listing_batch_pack_groups (batch_id, packing_group_id, group_index, created_at)
          VALUES (?, ?, ?, ?)
        `).run(batchId, g.packingGroupId, idx, now);
        const localGroupId = groupResult.lastInsertRowid as number;

        // Resolve each MSKU to a batch item id
        const groupItemsForResponse: any[] = [];
        for (const item of g.items) {
          const batchItem = db2.prepare(`
            SELECT id, sku, product_name as productName, quantity FROM listing_batch_items
            WHERE batch_id = ? AND sku = ?
          `).get(batchId, item.msku) as any;
          if (!batchItem) {
            console.warn(`[init-boxing] MSKU ${item.msku} returned by Amazon but not found in batch ${batchId}`);
            continue;
          }
          db2.prepare(`
            INSERT INTO listing_batch_pack_group_items (pack_group_id, item_id, quantity)
            VALUES (?, ?, ?)
          `).run(localGroupId, batchItem.id, item.quantity);
          groupItemsForResponse.push({
            itemId: batchItem.id,
            sku: batchItem.sku,
            productName: batchItem.productName,
            quantity: item.quantity,
          });
        }

        savedGroups.push({
          id: localGroupId,
          packingGroupId: g.packingGroupId,
          groupIndex: idx,
          items: groupItemsForResponse,
        });
      });
    });
    tx();
  } finally {
    db2.close();
  }

  return NextResponse.json({
    success: true,
    cached: false,
    packingOptionId: newPackingOptionId,
    packGroups: savedGroups,
  });
}
