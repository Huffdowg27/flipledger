/**
 * Placement options for an FBA inbound plan.
 *
 * GET  /api/list/batches/[id]/placement — read the current placement options
 *                                          from Amazon (calls listPlacementOptions).
 *                                          If they haven't been generated yet,
 *                                          this returns { generated: false }.
 *
 * POST /api/list/batches/[id]/placement — actions:
 *   { action: 'generate' }                       → generatePlacementOptions (async)
 *   { action: 'confirm', placementOptionId: X }  → confirmPlacementOption
 *
 * Placement is Amazon's post-packing optimization: given the declared boxes,
 * where should they go? Amazon returns 3 options ranging from "Optimized"
 * (cheap + multiple destinations) to "Minimal" (pricey + one destination).
 * The seller picks one and Amazon commits shipment IDs.
 *
 * This endpoint does NOT yet load the map-visualization data. The frontend
 * will call GET /api/list/batches/[id]/status (or a new /shipments endpoint
 * in Phase 3 Part B) to fetch the shipment destinations once a placement
 * option has been confirmed.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import {
  generatePlacementOptions,
  listPlacementOptions,
  confirmPlacementOption,
  getInboundOperation,
  type PlacementOption,
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

// ─── GET: read the current placement options ─────────────────────────────

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
    const batch = db.prepare(`
      SELECT id, status, channel, inbound_plan_id as inboundPlanId,
             placement_status as placementStatus,
             placement_option_id as placementOptionId
      FROM listing_batches WHERE id = ?
    `).get(batchId) as any;

    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.channel !== 'FBA') {
      return NextResponse.json({ error: 'Placement is only for FBA batches' }, { status: 400 });
    }
    if (!batch.inboundPlanId) {
      return NextResponse.json({ error: 'Batch has no inbound plan id' }, { status: 400 });
    }

    const creds = getAmazonCredentials(db);
    if (!creds) {
      return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
    }
    db.close();

    clearTokenCache();

    // If we haven't started generating yet, there's nothing to list.
    if (!batch.placementStatus) {
      return NextResponse.json({
        generated: false,
        placementStatus: null,
        options: [],
      });
    }

    // Options should exist on Amazon's side now.
    let options: PlacementOption[] = [];
    try {
      options = await listPlacementOptions(creds, batch.inboundPlanId);
    } catch (err) {
      return NextResponse.json({ error: `listPlacementOptions failed: ${err}` }, { status: 500 });
    }

    return NextResponse.json({
      generated: true,
      placementStatus: batch.placementStatus,
      confirmedOptionId: batch.placementOptionId,
      options,
    });
  } catch (err) {
    try { db.close(); } catch {}
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// ─── POST: generate or confirm ────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  let body: { action: 'generate' | 'confirm'; placementOptionId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.action !== 'generate' && body.action !== 'confirm') {
    return NextResponse.json({ error: "action must be 'generate' or 'confirm'" }, { status: 400 });
  }

  const db = getDb();
  let batch: any;
  let creds: SPAPICredentials | null;
  try {
    batch = db.prepare(`
      SELECT id, status, channel, inbound_plan_id as inboundPlanId,
             packing_status as packingStatus
      FROM listing_batches WHERE id = ?
    `).get(batchId);
    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.channel !== 'FBA') {
      return NextResponse.json({ error: 'Placement is only for FBA batches' }, { status: 400 });
    }
    if (!batch.inboundPlanId) {
      return NextResponse.json({ error: 'Batch has no inbound plan id' }, { status: 400 });
    }
    // Batch must have packing confirmed before placement can run.
    if (batch.packingStatus !== 'SUCCESS') {
      return NextResponse.json({
        error: `Packing must be confirmed before placement. Current packing_status: ${batch.packingStatus || 'not started'}`,
      }, { status: 400 });
    }
    creds = getAmazonCredentials(db);
  } finally {
    db.close();
  }

  if (!creds) {
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  clearTokenCache();

  if (body.action === 'generate') {
    return handleGenerate(batchId, batch.inboundPlanId, creds);
  }

  // action === 'confirm'
  if (!body.placementOptionId) {
    return NextResponse.json({ error: 'placementOptionId is required for confirm' }, { status: 400 });
  }
  return handleConfirm(batchId, batch.inboundPlanId, body.placementOptionId, creds);
}

async function handleGenerate(
  batchId: number,
  inboundPlanId: string,
  creds: SPAPICredentials
): Promise<NextResponse> {
  // Mark placement in-progress
  updateBatchPlacement(batchId, { status: 'IN_PROGRESS', error: null });

  // 1. generatePlacementOptions
  let op: { operationId: string };
  try {
    op = await generatePlacementOptions(creds, inboundPlanId);
  } catch (err) {
    updateBatchPlacement(batchId, { status: 'FAILED', error: `generatePlacementOptions: ${err}` });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  updateBatchPlacement(batchId, { operationId: op.operationId });

  // 2. Wait for op to finish
  const result = await waitForOperation(creds, op.operationId, 180_000);
  if (!result.success) {
    updateBatchPlacement(batchId, { status: 'FAILED', error: `generatePlacementOptions op failed: ${result.error}` });
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  // 3. List the options so the frontend can display them immediately.
  let options: PlacementOption[] = [];
  try {
    options = await listPlacementOptions(creds, inboundPlanId);
  } catch (err) {
    updateBatchPlacement(batchId, { status: 'FAILED', error: `listPlacementOptions: ${err}` });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  // Mark as generated (success at the generate step, but not yet confirmed).
  updateBatchPlacement(batchId, { status: 'GENERATED', error: null });

  return NextResponse.json({
    success: true,
    placementStatus: 'GENERATED',
    options,
  });
}

async function handleConfirm(
  batchId: number,
  inboundPlanId: string,
  placementOptionId: string,
  creds: SPAPICredentials
): Promise<NextResponse> {
  // We need to know the fee for the option they chose so we can persist it.
  let chosenOption: PlacementOption | null = null;
  try {
    const options = await listPlacementOptions(creds, inboundPlanId);
    chosenOption = options.find((o) => o.placementOptionId === placementOptionId) || null;
  } catch {
    // Non-fatal — we'll still attempt the confirm even if the list call fails.
  }

  // Sum the fee totals for the option (single currency assumed: USD).
  let placementFeeCents = 0;
  if (chosenOption?.fees) {
    for (const f of chosenOption.fees) {
      const dollars = f.value?.amount;
      if (typeof dollars === 'number') placementFeeCents += Math.round(dollars * 100);
    }
  }

  // Confirm
  let confirmOp: { operationId: string };
  try {
    confirmOp = await confirmPlacementOption(creds, inboundPlanId, placementOptionId);
  } catch (err) {
    updateBatchPlacement(batchId, { status: 'FAILED', error: `confirmPlacementOption: ${err}` });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  if (confirmOp.operationId) {
    const result = await waitForOperation(creds, confirmOp.operationId, 120_000);
    if (!result.success) {
      updateBatchPlacement(batchId, { status: 'FAILED', error: `confirmPlacementOption op failed: ${result.error}` });
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
  }

  // Persist: mark placement SUCCESS + transition batch to 'shipping'.
  const db = getDb();
  try {
    db.prepare(`
      UPDATE listing_batches SET
        status = 'shipping',
        placement_status = 'SUCCESS',
        placement_option_id = ?,
        placement_fee_cents = ?,
        placement_confirmed_at = ?,
        placement_error = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(
      placementOptionId,
      placementFeeCents,
      new Date().toISOString(),
      new Date().toISOString(),
      batchId
    );
  } finally {
    db.close();
  }

  return NextResponse.json({
    success: true,
    placementOptionId,
    placementFeeCents,
  });
}

function updateBatchPlacement(
  batchId: number,
  fields: { status?: string; error?: string | null; operationId?: string }
) {
  const db = getDb();
  try {
    const sets: string[] = [];
    const values: any[] = [];
    if (fields.status !== undefined) { sets.push('placement_status = ?'); values.push(fields.status); }
    if (fields.error !== undefined) { sets.push('placement_error = ?'); values.push(fields.error); }
    if (fields.operationId !== undefined) { sets.push('placement_operation_id = ?'); values.push(fields.operationId); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(batchId);
    db.prepare(`UPDATE listing_batches SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  } finally {
    db.close();
  }
}
