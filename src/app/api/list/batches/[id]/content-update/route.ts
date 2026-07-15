/**
 * POST /api/list/batches/[id]/content-update
 *
 * Adjust item quantities on a CONFIRMED shipment — the v2024 content-update
 * flow (what 2DWorkflow's "adjust Qty any time" is built on, modernized):
 *
 *   { shipmentId, action: 'preview', items: [{ msku, quantity }] }
 *     → fetches the shipment's current boxes from Amazon, applies the
 *       requested per-SKU totals to the box contents (greedy from the last
 *       box), generates a content update preview, and returns it — including
 *       any transportation requote. Nothing is committed.
 *
 *   { shipmentId, action: 'confirm', contentUpdatePreviewId, items }
 *     → confirms the preview with Amazon, then syncs the new quantities onto
 *       listing_batch_items so local totals/labels match.
 *
 * Amazon tolerance: ±5% or 6 units per SKU (whichever is higher). Amazon
 * rejects previews outside tolerance — the error is surfaced verbatim.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import {
  listShipmentBoxes,
  generateShipmentContentUpdatePreviews,
  listShipmentContentUpdatePreviews,
  confirmShipmentContentUpdatePreview,
  getInboundOperation,
  type ContentUpdateBoxInput,
  type ContentUpdateItemInput,
} from '@/lib/sp-api/inboundPlansV2';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import {
  applyShipmentQuantityPlan,
  planShipmentQuantityUpdate,
  type ShipmentItemQuantity,
  type ShipmentQuantityPlanItem,
} from '@/lib/shipment-content-quantities';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  if (!s.clientId || !s.clientSecret || !s.refreshToken) return null;
  return {
    clientId: s.clientId,
    clientSecret: s.clientSecret,
    refreshToken: s.refreshToken,
    marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
  };
}

async function waitForOperation(creds: SPAPICredentials, operationId: string, timeoutMs: number): Promise<{ success: boolean; error?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const op = await getInboundOperation(creds, operationId);
    if (op.operationStatus === 'SUCCESS') return { success: true };
    if (op.operationStatus === 'FAILED') {
      return { success: false, error: JSON.stringify(op.operationProblems || 'operation failed') };
    }
  }
  return { success: false, error: `Operation ${operationId} timed out after ${timeoutMs / 1000}s` };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });

  let body: {
    action: 'load' | 'preview' | 'confirm';
    shipmentId: string;
    items?: Array<{ msku: string; quantity: number }>;
    contentUpdatePreviewId?: string;
  };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (!body.shipmentId) return NextResponse.json({ error: 'shipmentId required' }, { status: 400 });

  const db = getDb();
  let batch: any;
  let creds: SPAPICredentials | null;
  try {
    batch = db.prepare(`
      SELECT id, channel, inbound_plan_id as inboundPlanId FROM listing_batches WHERE id = ?
    `).get(batchId);
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (!batch.inboundPlanId) return NextResponse.json({ error: 'No inbound plan' }, { status: 400 });
    creds = getAmazonCredentials(db);
  } finally {
    db.close();
  }
  if (!creds) return NextResponse.json({ error: 'Amazon credentials not configured' }, { status: 400 });
  clearTokenCache();

  // load: current per-SKU totals for this shipment straight from Amazon's
  // boxes — the editing baseline (batch-level quantities can differ when a
  // batch produced multiple shipments).
  if (body.action === 'load') {
    try {
      const boxes = await listShipmentBoxes(creds, batch.inboundPlanId, body.shipmentId);
      const totals = new Map<string, number>();
      for (const b of boxes) {
        for (const it of b.items || []) {
          totals.set(it.msku, (totals.get(it.msku) || 0) + (it.quantity || 0) * (b.quantity || 1));
        }
      }
      return NextResponse.json({
        success: true,
        boxCount: boxes.length,
        currentItems: [...totals.entries()].map(([msku, quantity]) => ({ msku, quantity })),
      });
    } catch (err) {
      return NextResponse.json({ error: `listShipmentBoxes: ${err}` }, { status: 500 });
    }
  }

  if (body.action === 'preview') {
    if (!body.items?.length) return NextResponse.json({ error: 'items required for preview' }, { status: 400 });
    return handlePreview(creds, batch.inboundPlanId, body.shipmentId, body.items);
  }

  if (body.action === 'confirm') {
    if (!body.contentUpdatePreviewId) return NextResponse.json({ error: 'contentUpdatePreviewId required' }, { status: 400 });
    if (!body.items?.length) return NextResponse.json({ error: 'items required for confirm' }, { status: 400 });
    return handleConfirm(creds, batchId, batch.inboundPlanId, body.shipmentId, body.contentUpdatePreviewId, body.items);
  }

  return NextResponse.json({ error: "action must be 'load', 'preview', or 'confirm'" }, { status: 400 });
}

async function handlePreview(
  creds: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string,
  requested: Array<{ msku: string; quantity: number }>,
): Promise<NextResponse> {
  // 1. Current boxes are the baseline — the update request must describe the
  //    FULL post-update contents (any packageId omitted = box removed).
  let boxes: any[];
  try {
    boxes = await listShipmentBoxes(creds, inboundPlanId, shipmentId);
  } catch (err) {
    return NextResponse.json({ error: `listShipmentBoxes: ${err}` }, { status: 500 });
  }
  if (boxes.length === 0) {
    return NextResponse.json({ error: 'Amazon returned no boxes for this shipment — content update needs the existing box contents as a baseline.' }, { status: 400 });
  }

  const requestedBySku = new Map(requested.map((r) => [r.msku, Math.max(0, Math.floor(r.quantity))]));

  // Current totals per SKU across boxes.
  const currentBySku = new Map<string, number>();
  for (const box of boxes) {
    for (const it of box.items || []) {
      currentBySku.set(it.msku, (currentBySku.get(it.msku) || 0) + (it.quantity || 0) * (box.quantity || 1));
    }
  }
  for (const msku of requestedBySku.keys()) {
    if (!currentBySku.has(msku)) {
      return NextResponse.json({ error: `SKU ${msku} is not in this shipment — content updates can only adjust existing SKUs.` }, { status: 400 });
    }
  }

  // 2. Apply deltas to box contents. Greedy: shrink from the last box that
  //    holds the SKU; grow on the last box that holds it. Boxes that end up
  //    empty are dropped (removes the box from the shipment).
  const workBoxes = boxes.map((b) => ({
    packageId: b.packageId as string | undefined,
    contentInformationSource: (b.contentInformationSource || 'BOX_CONTENT_PROVIDED') as ContentUpdateBoxInput['contentInformationSource'],
    dimensions: b.dimensions,
    weight: b.weight,
    quantity: b.quantity || 1,
    items: (b.items || []).map((it: any) => ({
      msku: it.msku as string,
      quantity: (it.quantity || 0) as number,
      labelOwner: (it.labelOwner || 'SELLER') as string,
      prepOwner: (it.prepInstructions?.[0]?.prepOwner || 'SELLER') as string,
      ...(it.expiration ? { expiration: it.expiration } : {}),
    })),
  }));

  const multiCountBox = workBoxes.find((b) => (b.quantity || 1) > 1 && b.items.length > 0);
  if (multiCountBox) {
    return NextResponse.json({ error: 'This shipment uses template boxes (quantity > 1 per box row) — per-box adjustment is not supported yet. Adjust in Seller Central.' }, { status: 400 });
  }

  for (const [msku, want] of requestedBySku) {
    let delta = want - (currentBySku.get(msku) || 0);
    if (delta === 0) continue;
    if (delta < 0) {
      // Remove units from the last boxes first.
      for (let i = workBoxes.length - 1; i >= 0 && delta < 0; i--) {
        const entry = workBoxes[i].items.find((it: any) => it.msku === msku);
        if (!entry) continue;
        const take = Math.min(entry.quantity, -delta);
        entry.quantity -= take;
        delta += take;
      }
    } else {
      // Add units to the last box that already holds this SKU.
      for (let i = workBoxes.length - 1; i >= 0; i--) {
        const entry = workBoxes[i].items.find((it: any) => it.msku === msku);
        if (entry) { entry.quantity += delta; delta = 0; break; }
      }
    }
  }

  const boxInputs: ContentUpdateBoxInput[] = workBoxes
    .map((b) => ({ ...b, items: b.items.filter((it: any) => it.quantity > 0) }))
    .filter((b) => b.items.length > 0)
    .map((b) => ({
      ...(b.packageId ? { packageId: b.packageId } : {}),
      contentInformationSource: b.contentInformationSource,
      dimensions: b.dimensions,
      weight: b.weight,
      quantity: b.quantity,
      items: b.items as ContentUpdateItemInput[],
    }));

  if (boxInputs.length === 0) {
    return NextResponse.json({ error: 'Update would empty every box — cancel the shipment instead of zeroing it out.' }, { status: 400 });
  }

  // 3. Shipment-level item totals (post-update).
  const itemTotals = new Map<string, ContentUpdateItemInput>();
  for (const b of boxInputs) {
    for (const it of b.items || []) {
      const prev = itemTotals.get(it.msku);
      if (prev) prev.quantity += it.quantity;
      else itemTotals.set(it.msku, { ...it });
    }
  }
  const itemInputs = [...itemTotals.values()];
  const requestedItems = [...currentBySku.keys()].map((msku) => ({
    msku,
    quantity: itemTotals.get(msku)?.quantity || 0,
  }));

  // 4. Generate + poll + fetch the preview.
  let op: { operationId: string };
  try {
    op = await generateShipmentContentUpdatePreviews(creds, inboundPlanId, shipmentId, boxInputs, itemInputs);
  } catch (err) {
    return NextResponse.json({ error: `generateContentUpdatePreviews: ${err}` }, { status: 500 });
  }
  const result = await waitForOperation(creds, op.operationId, 120_000);
  if (!result.success) {
    return NextResponse.json({ error: `Amazon rejected the content update: ${result.error}` }, { status: 500 });
  }

  let previews: any[];
  try {
    previews = await listShipmentContentUpdatePreviews(creds, inboundPlanId, shipmentId);
  } catch (err) {
    return NextResponse.json({ error: `listContentUpdatePreviews: ${err}` }, { status: 500 });
  }
  // Newest preview is the one we just generated (previews expire quickly).
  const preview = previews[previews.length - 1];
  if (!preview) return NextResponse.json({ error: 'Amazon returned no content update preview' }, { status: 500 });

  return NextResponse.json({
    success: true,
    contentUpdatePreviewId: preview.contentUpdatePreviewId,
    expiration: preview.expiration,
    transportationOption: preview.transportationOption ?? null,
    requestedItems,
    boxCount: boxInputs.length,
  });
}

async function handleConfirm(
  creds: SPAPICredentials,
  batchId: number,
  inboundPlanId: string,
  shipmentId: string,
  contentUpdatePreviewId: string,
  items: ShipmentItemQuantity[],
): Promise<NextResponse> {
  // Read the shipment baseline immediately before confirmation. The local
  // batch stores totals across every shipment, so reconciliation must apply
  // this shipment's delta instead of replacing the whole-batch quantity.
  let quantityPlan: ShipmentQuantityPlanItem[];
  try {
    const boxes = await listShipmentBoxes(creds, inboundPlanId, shipmentId);
    const currentTotals = new Map<string, number>();
    for (const box of boxes) {
      for (const item of box.items || []) {
        currentTotals.set(
          item.msku,
          (currentTotals.get(item.msku) || 0) + (item.quantity || 0) * (box.quantity || 1),
        );
      }
    }
    const beforeItems = [...currentTotals.entries()].map(([msku, quantity]) => ({ msku, quantity }));
    const db = getDb();
    try {
      quantityPlan = planShipmentQuantityUpdate(db, batchId, beforeItems, items);
    } finally {
      db.close();
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Cannot safely reconcile shipment quantities: ${err}` },
      { status: 409 },
    );
  }

  let op: { operationId: string };
  try {
    op = await confirmShipmentContentUpdatePreview(creds, inboundPlanId, shipmentId, contentUpdatePreviewId);
  } catch (err) {
    return NextResponse.json({ error: `confirmContentUpdatePreview: ${err}` }, { status: 500 });
  }
  const result = await waitForOperation(creds, op.operationId, 120_000);
  if (!result.success) {
    return NextResponse.json({ error: `Confirm failed: ${result.error}` }, { status: 500 });
  }

  // Sync local batch item quantities so totals, labels, and profit numbers
  // match what's actually shipping. Inventory lots stay untouched — the units
  // are still owned either way; only the shipment contents changed.
  const db = getDb();
  let itemsUpdated: number;
  try {
    const now = new Date().toISOString();
    itemsUpdated = applyShipmentQuantityPlan(db, quantityPlan, now);
    if (itemsUpdated > 0) {
      db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(now, batchId);
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Amazon confirmed, but local batch reconciliation failed: ${err}` },
      { status: 500 },
    );
  } finally {
    db.close();
  }

  return NextResponse.json({ success: true, itemsUpdated });
}
