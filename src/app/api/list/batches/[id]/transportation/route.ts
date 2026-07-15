/**
 * Transportation options for an FBA inbound plan.
 *
 * Amazon requires all four operations to be completed via API before
 * Seller Central will allow shipment completion:
 *   1. generatePlacementOptions  ✓ (placement route)
 *   2. generateTransportationOptions  ← this route
 *   3. confirmPlacementOption    ✓ (placement route)
 *   4. confirmTransportationOptions   ← this route
 *
 * GET  /api/list/batches/[id]/transportation
 *   Returns { transportationStatus, options } for the current batch.
 *
 * POST /api/list/batches/[id]/transportation
 *   { action: 'generate-and-confirm' }
 *     Full flow: generateTransportationOptions → poll → listTransportationOptions
 *     → auto-select first available option per shipment → confirmTransportationOptions → poll.
 *     Use this for non-partnered shipments (one option per shipment) or the repair action.
 *
 *   { action: 'generate' }
 *     Only generates options, returns them for user to review. Does not confirm.
 *
 *   { action: 'confirm', selections: [{shipmentId, transportationOptionId}] }
 *     Confirms user-chosen selections.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import {
  generateTransportationOptions,
  listTransportationOptions,
  confirmTransportationOptions,
  generateDeliveryWindowOptions,
  listDeliveryWindowOptions,
  confirmDeliveryWindowOptions,
  listShipments,
  getShipment,
  getInboundOperation,
  type LtlConfiguration,
  type LtlContactInformation,
} from '@/lib/sp-api/inboundPlansV2';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function ensureTransportationColumns(db: Database.Database) {
  const cols = [
    'transportation_operation_id TEXT',
    'transportation_option_id TEXT',
    'transportation_status TEXT',
    'transportation_confirmed_at TEXT',
    'transportation_error TEXT',
    'confirmed_shipments TEXT', // JSON array of {shipmentId, confirmationId, destinationFC, ...}
  ];
  for (const col of cols) {
    try { db.exec(`ALTER TABLE listing_batches ADD COLUMN ${col}`); } catch { /* already exists */ }
  }
}

function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  if (!s.clientId || !s.clientSecret || !s.refreshToken) return null;
  return { clientId: s.clientId, clientSecret: s.clientSecret, refreshToken: s.refreshToken, marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER' };
}

function updateTransportation(
  batchId: number,
  fields: { status?: string; error?: string | null; operationId?: string; optionId?: string; confirmedAt?: string; confirmedShipments?: any[] }
) {
  const db = getDb();
  try {
    ensureTransportationColumns(db);
    const parts: string[] = ['updated_at = ?'];
    const vals: any[] = [new Date().toISOString()];
    if (fields.status !== undefined) { parts.push('transportation_status = ?'); vals.push(fields.status); }
    if (fields.error !== undefined) { parts.push('transportation_error = ?'); vals.push(fields.error); }
    if (fields.operationId !== undefined) { parts.push('transportation_operation_id = ?'); vals.push(fields.operationId); }
    if (fields.optionId !== undefined) { parts.push('transportation_option_id = ?'); vals.push(fields.optionId); }
    if (fields.confirmedAt !== undefined) { parts.push('transportation_confirmed_at = ?'); vals.push(fields.confirmedAt); }
    if (fields.confirmedShipments !== undefined) { parts.push('confirmed_shipments = ?'); vals.push(JSON.stringify(fields.confirmedShipments)); }
    vals.push(batchId);
    db.prepare(`UPDATE listing_batches SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
  } finally {
    db.close();
  }
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

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });

  const db = getDb();
  try {
    ensureTransportationColumns(db);
    const batch = db.prepare(`
      SELECT id, status, channel, inbound_plan_id as inboundPlanId,
             placement_option_id as placementOptionId,
             transportation_status as transportationStatus,
             transportation_option_id as transportationOptionId,
             transportation_error as transportationError
      FROM listing_batches WHERE id = ?
    `).get(batchId) as any;

    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.channel !== 'FBA') return NextResponse.json({ error: 'FBA only' }, { status: 400 });
    if (!batch.inboundPlanId) return NextResponse.json({ error: 'No inbound plan' }, { status: 400 });
    if (!batch.placementOptionId) return NextResponse.json({ error: 'Placement not confirmed yet' }, { status: 400 });

    const creds = getAmazonCredentials(db);
    db.close();
    if (!creds) return NextResponse.json({ error: 'Amazon credentials not configured' }, { status: 400 });

    clearTokenCache();

    let options: any[] = [];
    try {
      options = await listTransportationOptions(creds, batch.inboundPlanId, batch.placementOptionId);
    } catch (err) {
      return NextResponse.json({
        transportationStatus: batch.transportationStatus,
        transportationOptionId: batch.transportationOptionId,
        options: [],
        listError: String(err),
      });
    }

    return NextResponse.json({
      transportationStatus: batch.transportationStatus,
      transportationOptionId: batch.transportationOptionId,
      options,
    });
  } catch (err) {
    try { db.close(); } catch {}
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });

  let body: {
    action: string;
    placementOptionId?: string;
    shipmentIds?: string[];
    readyToShipStart?: string;
    selections?: Array<{ shipmentId: string; transportationOptionId: string; contactInformation?: LtlContactInformation }>;
    selectedOptions?: any[];
    /** LTL: pallets + freight info unlock FREIGHT_LTL quotes on preview/generate. */
    ltl?: LtlConfiguration;
  };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  // Persist LTL contact info for prefill next time (best-effort).
  if (body.ltl?.contactInformation) {
    try {
      const dbC = getDb();
      const c = body.ltl.contactInformation;
      const up = dbC.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      if (c.name) up.run('ltl_contact_name', c.name);
      if (c.email) up.run('ltl_contact_email', c.email);
      if (c.phoneNumber) up.run('ltl_contact_phone', c.phoneNumber);
      dbC.close();
    } catch { /* best effort */ }
  }

  const db = getDb();
  let batch: any;
  let creds: SPAPICredentials | null;
  try {
    ensureTransportationColumns(db);
    batch = db.prepare(`
      SELECT id, status, channel, inbound_plan_id as inboundPlanId,
             placement_option_id as placementOptionId,
             confirmed_shipment_ids as confirmedShipmentIds
      FROM listing_batches WHERE id = ?
    `).get(batchId);
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.channel !== 'FBA') return NextResponse.json({ error: 'FBA only' }, { status: 400 });
    if (!batch.inboundPlanId) return NextResponse.json({ error: 'No inbound plan' }, { status: 400 });
    creds = getAmazonCredentials(db);
  } finally {
    db.close();
  }

  if (!creds) return NextResponse.json({ error: 'Amazon credentials not configured' }, { status: 400 });
  clearTokenCache();

  // preview: generate+list options for a candidate placementOptionId without saving anything.
  // shipmentIds come from the client (listPlacementOptions response) — no listShipments needed.
  if (body.action === 'preview') {
    if (!body.placementOptionId) return NextResponse.json({ error: 'placementOptionId required for preview' }, { status: 400 });
    if (!body.shipmentIds?.length) return NextResponse.json({ error: 'shipmentIds required for preview' }, { status: 400 });
    if (body.readyToShipStart !== undefined && body.readyToShipStart === '') {
      return NextResponse.json({ error: 'Choose a ship date before generating transportation options' }, { status: 400 });
    }
    return handlePreview(batch.inboundPlanId, body.placementOptionId, body.shipmentIds, body.readyToShipStart, creds, body.ltl);
  }

  if (!batch.placementOptionId) return NextResponse.json({ error: 'Confirm placement first' }, { status: 400 });

  if (body.action === 'confirm') {
    if (!body.selections?.length) return NextResponse.json({ error: 'selections required' }, { status: 400 });
    return handleConfirm(batchId, batch.inboundPlanId, body.selections, creds, body.selectedOptions);
  }

  if (body.action === 'generate' || body.action === 'generate-and-confirm') {
    // Resolve shipment IDs: prefer client-provided, then DB (saved after placement confirm),
    // then fallback to listShipments which may 403 on some accounts.
    let resolvedShipmentIds: string[] | undefined = body.shipmentIds;
    if (!resolvedShipmentIds?.length && batch.confirmedShipmentIds) {
      try {
        resolvedShipmentIds = JSON.parse(batch.confirmedShipmentIds);
        console.log('[transportation] using saved confirmedShipmentIds:', resolvedShipmentIds);
      } catch {}
    }
    return handleGenerate(batchId, batch.inboundPlanId, batch.placementOptionId, creds, body.action === 'generate-and-confirm', resolvedShipmentIds, body.readyToShipStart, body.ltl);
  }

  return NextResponse.json({ error: "action must be 'preview', 'generate', 'generate-and-confirm', or 'confirm'" }, { status: 400 });
}

async function handlePreview(
  inboundPlanId: string,
  placementOptionId: string,
  shipmentIds: string[],
  readyToShipStart: string | undefined,
  creds: SPAPICredentials,
  ltl?: LtlConfiguration,
): Promise<NextResponse> {
  let genOp: { operationId: string };
  try {
    genOp = await generateTransportationOptions(creds, inboundPlanId, placementOptionId, shipmentIds, readyToShipStart, ltl);
  } catch (err) {
    return NextResponse.json({ error: `generateTransportationOptions: ${err}` }, { status: 500 });
  }

  const genResult = await waitForOperation(creds, genOp.operationId, 180_000);
  if (!genResult.success) {
    return NextResponse.json({ error: genResult.error }, { status: 500 });
  }

  let options: any[];
  try {
    options = await listTransportationOptions(creds, inboundPlanId, placementOptionId);
    console.log('[transportation/preview] options:', JSON.stringify(options, null, 2));
  } catch (err) {
    return NextResponse.json({ error: `listTransportationOptions: ${err}` }, { status: 500 });
  }

  // Destinations for the preview UI — getShipment returns the destination
  // warehouse + address even before placement confirmation. Normalized to the
  // destinationWarehouseAddress shape buildTransportSummary expects.
  const shipments = (
    await Promise.allSettled(shipmentIds.map((sid) => getShipment(creds, inboundPlanId, sid)))
  )
    .flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
    .map((s: any) => ({
      shipmentId: s.shipmentId,
      destinationFC: s.destination?.warehouseId ?? null,
      destinationWarehouseAddress: s.destinationWarehouseAddress ?? s.destination?.address ?? null,
      status: s.status ?? null,
    }));

  return NextResponse.json({ success: true, options, shipments });
}

async function handleGenerate(
  batchId: number,
  inboundPlanId: string,
  placementOptionId: string,
  creds: SPAPICredentials,
  autoConfirm: boolean,
  clientShipmentIds?: string[],
  readyToShipStart?: string,
  ltl?: LtlConfiguration,
): Promise<NextResponse> {
  updateTransportation(batchId, { status: 'IN_PROGRESS', error: null });

  // Use shipmentIds provided by the client (from placement options) when available.
  // Fall back to listShipments, which may 403 on some accounts.
  let shipmentIds: string[];
  if (clientShipmentIds && clientShipmentIds.length > 0) {
    shipmentIds = clientShipmentIds;
    console.log('[transportation] shipmentIds from client:', shipmentIds);
  } else {
    try {
      const shipments = await listShipments(creds, inboundPlanId);
      shipmentIds = shipments.map((s) => s.shipmentId).filter(Boolean);
      if (shipmentIds.length === 0) throw new Error('No shipments found for this inbound plan');
      console.log('[transportation] shipmentIds from listShipments:', shipmentIds);
    } catch (err) {
      updateTransportation(batchId, { status: 'FAILED', error: `listShipments: ${err}` });
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  // Generate transportation options
  let genOp: { operationId: string };
  try {
    genOp = await generateTransportationOptions(creds, inboundPlanId, placementOptionId, shipmentIds, readyToShipStart, ltl);
  } catch (err) {
    updateTransportation(batchId, { status: 'FAILED', error: `generateTransportationOptions: ${err}` });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  updateTransportation(batchId, { operationId: genOp.operationId });

  // Poll until generated
  const genResult = await waitForOperation(creds, genOp.operationId, 180_000);
  if (!genResult.success) {
    updateTransportation(batchId, { status: 'FAILED', error: `generateTransportationOptions op: ${genResult.error}` });
    return NextResponse.json({ error: genResult.error }, { status: 500 });
  }

  // List the generated options
  let options: any[];
  try {
    options = await listTransportationOptions(creds, inboundPlanId, placementOptionId);
    console.log('[transportation] options returned:', options.length);
  } catch (err) {
    updateTransportation(batchId, { status: 'FAILED', error: `listTransportationOptions: ${err}` });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  // If every option for at least one shipment requires a delivery window,
  // retry with readyToShipStart = today + 14 days. Amazon sometimes only offers
  // partnered SPD (no delivery window needed) when the ship window is farther out.
  let effectiveShipDate = readyToShipStart || (() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(12, 0, 0, 0); return d.toISOString();
  })();
  let fallbackWarning: string | undefined;

  const shipmentsMissingPartnered = shipmentIds.filter(sid => {
    const sidOpts = options.filter(o => o.shipmentId === sid);
    return sidOpts.length > 0 && sidOpts.every(o => requiresDeliveryWindow(o));
  });

  if (shipmentsMissingPartnered.length > 0) {
    const fallbackDate = new Date();
    fallbackDate.setUTCDate(fallbackDate.getUTCDate() + 14);
    fallbackDate.setUTCHours(12, 0, 0, 0);
    const fallbackDateStr = fallbackDate.toISOString();
    console.log('[transportation] all options require delivery window for', shipmentsMissingPartnered, '— retrying with', fallbackDateStr);
    try {
      const fbGenOp = await generateTransportationOptions(creds, inboundPlanId, placementOptionId, shipmentIds, fallbackDateStr, ltl);
      if (fbGenOp.operationId) await waitForOperation(creds, fbGenOp.operationId, 180_000);
      const fallbackOptions = await listTransportationOptions(creds, inboundPlanId, placementOptionId);
      const hasNewPartnered = fallbackOptions.some(o => !requiresDeliveryWindow(o));
      if (hasNewPartnered) {
        options = fallbackOptions;
        effectiveShipDate = fallbackDateStr;
        fallbackWarning = `Amazon did not return partnered SPD for the requested ship date. Partnered SPD became available with ship date ${fallbackDateStr.slice(0, 10)}.`;
        console.log('[transportation] fallback date produced partnered options:', fallbackOptions.length);
      }
    } catch (err) {
      console.warn('[transportation] fallback date retry failed:', err);
    }
  }

  // Annotate options with computed fields for the UI
  const annotatedOptions = options.map(o => ({
    ...o,
    requiresDeliveryWindow: requiresDeliveryWindow(o),
    effectiveShipDate,
  }));

  // Fetch shipment details for destination address — the source of truth post-confirmation.
  // Best-effort: failures are logged but don't block the response.
  const shipments: any[] = [];
  for (const sid of shipmentIds) {
    try {
      const s = await getShipment(creds, inboundPlanId, sid);
      if (s) shipments.push(s);
    } catch (err) {
      console.warn('[transportation] getShipment failed for', sid, err);
    }
  }

  if (!autoConfirm) {
    updateTransportation(batchId, { status: 'GENERATED' });
    return NextResponse.json({
      success: true, status: 'GENERATED',
      options: annotatedOptions, shipments, effectiveShipDate,
      ...(fallbackWarning ? { warning: fallbackWarning } : {}),
    });
  }

  // Auto-confirm: per shipment, prefer non-delivery-window options first,
  // then among those prefer AMAZON_PARTNERED_CARRIER + GROUND_SMALL_PARCEL.
  // Ranking: partnered SPD (1) > partnered other (2) > non-partnered SPD (3) > non-partnered LTL (4) > delivery-window-required (5)
  function optionRank(opt: any): number {
    const needsWindow = requiresDeliveryWindow(opt);
    const partnered = opt.shippingSolution === 'AMAZON_PARTNERED_CARRIER';
    const spd = opt.shippingMode === 'GROUND_SMALL_PARCEL';
    if (!needsWindow && partnered && spd) return 1;
    if (!needsWindow && partnered) return 2;
    if (!needsWindow && spd) return 3;
    if (!needsWindow) return 4;
    return 5;
  }

  const selectionMap = new Map<string, any>(); // shipmentId → full option object
  for (const opt of options) {
    const sid: string = opt.shipmentId;
    if (!sid) continue;
    const existing = selectionMap.get(sid);
    if (!existing || optionRank(opt) < optionRank(existing)) {
      selectionMap.set(sid, opt);
    }
  }

  if (selectionMap.size === 0) {
    updateTransportation(batchId, { status: 'FAILED', error: 'No transportation options returned from Amazon' });
    return NextResponse.json({
      error: 'No transportation options returned from Amazon. Check pm2 logs for listTransportationOptions response.',
      options,
    }, { status: 500 });
  }

  const selections = Array.from(selectionMap.entries()).map(([shipmentId, opt]) => ({
    shipmentId,
    transportationOptionId: opt.transportationOptionId,
  }));

  // Pass full options + shipment details so handleConfirm can detect delivery window
  // requirements and persist confirmed shipment data.
  return handleConfirm(batchId, inboundPlanId, selections, creds, options, shipments);
}

// Returns true if a transportation option requires delivery window confirmation
// before it can be confirmed. Non-partnered carrier options always need this.
function requiresDeliveryWindow(opt: any): boolean {
  if (!opt) return false;
  const preconditions: string[] = Array.isArray(opt.preconditions) ? opt.preconditions : [];
  if (preconditions.some((p: string) => p.toUpperCase().includes('DELIVERY_WINDOW'))) return true;
  if (opt.shippingSolution === 'USE_YOUR_OWN_CARRIER') return true;
  return false;
}

// Generate, list, and confirm delivery window options for a single shipment.
async function confirmDeliveryWindowForShipment(
  creds: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string,
): Promise<{ success: boolean; error?: string }> {
  // Step 1: generate
  let genOp: { operationId: string };
  try {
    genOp = await generateDeliveryWindowOptions(creds, inboundPlanId, shipmentId);
  } catch (err) {
    return { success: false, error: `generateDeliveryWindowOptions: ${err}` };
  }
  if (genOp.operationId) {
    const r = await waitForOperation(creds, genOp.operationId, 60_000);
    if (!r.success) return { success: false, error: `generateDeliveryWindowOptions op: ${r.error}` };
  }

  // Step 2: list options
  let windows: any[];
  try {
    windows = await listDeliveryWindowOptions(creds, inboundPlanId, shipmentId);
  } catch (err) {
    return { success: false, error: `listDeliveryWindowOptions: ${err}` };
  }
  if (!windows || windows.length === 0) {
    return { success: false, error: `No delivery window options returned for shipment ${shipmentId}` };
  }

  // Step 3: confirm first available window
  const chosen = windows[0];
  console.log('[deliveryWindow] all options for', shipmentId, JSON.stringify(windows, null, 2));
  console.log('[deliveryWindow] confirming window for', shipmentId, JSON.stringify(chosen, null, 2));
  const windowId: string = chosen.deliveryWindowOptionId || chosen.deliveryWindowId || '';
  if (!windowId) return { success: false, error: `Cannot find deliveryWindowOptionId in: ${JSON.stringify(chosen)}` };

  let confirmOp: { operationId: string };
  try {
    confirmOp = await confirmDeliveryWindowOptions(creds, inboundPlanId, shipmentId, windowId);
  } catch (err) {
    return { success: false, error: `confirmDeliveryWindowOptions: ${err}` };
  }
  if (confirmOp.operationId) {
    const r = await waitForOperation(creds, confirmOp.operationId, 60_000);
    if (!r.success) return { success: false, error: `confirmDeliveryWindowOptions op: ${r.error}` };
  }

  console.log('[deliveryWindow] confirmed for', shipmentId, 'windowId:', windowId);
  return { success: true };
}

async function handleConfirm(
  batchId: number,
  inboundPlanId: string,
  // contactInformation per selection is required by Amazon for FREIGHT_*
  // options (carrier pickup coordination) — passed through untouched.
  selections: Array<{ shipmentId: string; transportationOptionId: string; contactInformation?: LtlContactInformation }>,
  creds: SPAPICredentials,
  selectedOptions?: any[],  // full option objects — delivery window detection + persist carrier/cost
  shipmentDetails?: any[],  // from getShipment — persist confirmationId, destination
): Promise<NextResponse> {
  // Determine which shipments need delivery windows confirmed before transportation confirm.
  const shipmentsNeedingWindow: string[] = [];
  for (const { shipmentId, transportationOptionId } of selections) {
    const opt = selectedOptions?.find(
      (o: any) => o.transportationOptionId === transportationOptionId && o.shipmentId === shipmentId
    );
    if (requiresDeliveryWindow(opt)) {
      shipmentsNeedingWindow.push(shipmentId);
    }
  }

  if (shipmentsNeedingWindow.length > 0) {
    console.log('[transportation] delivery windows required for:', shipmentsNeedingWindow);
    for (const shipmentId of shipmentsNeedingWindow) {
      const r = await confirmDeliveryWindowForShipment(creds, inboundPlanId, shipmentId);
      if (!r.success) {
        updateTransportation(batchId, { status: 'FAILED', error: `deliveryWindow ${shipmentId}: ${r.error}` });
        return NextResponse.json({ error: `Delivery window failed for ${shipmentId}: ${r.error}` }, { status: 500 });
      }
    }
  }

  let confirmOp: { operationId: string };
  try {
    confirmOp = await confirmTransportationOptions(creds, inboundPlanId, selections);
  } catch (err) {
    updateTransportation(batchId, { status: 'FAILED', error: `confirmTransportationOptions: ${err}` });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  if (confirmOp.operationId) {
    const result = await waitForOperation(creds, confirmOp.operationId, 120_000);
    if (!result.success) {
      updateTransportation(batchId, { status: 'FAILED', error: `confirmTransportationOptions op: ${result.error}` });
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
  }

  const now = new Date().toISOString();

  // Build confirmed shipment records from selections + options + shipment details
  const confirmedShipments = selections.map(({ shipmentId, transportationOptionId }) => {
    const opt = selectedOptions?.find((o: any) => o.transportationOptionId === transportationOptionId);
    const detail = shipmentDetails?.find((s: any) => s.shipmentId === shipmentId);
    return {
      shipmentId,
      confirmationId: detail?.shipmentConfirmationId || null,
      destinationFC: detail?.destination?.warehouseId || null,
      destinationCity: detail?.destination?.address?.city || null,
      destinationState: detail?.destination?.address?.stateOrProvinceCode || null,
      destinationAddress: detail?.destination?.address || null,
      carrier: opt?.carrier?.name || null,
      carrierCode: opt?.carrier?.alphaCode || null,
      shippingMode: opt?.shippingMode || null,
      shippingSolution: opt?.shippingSolution || null,
      transportationOptionId,
      cost: opt?.quote?.cost?.amount ?? null,
      costCurrency: opt?.quote?.cost?.code || 'USD',
      readyToShipWindow: detail?.dates?.readyToShipWindow?.start || null,
      confirmedAt: now,
    };
  });

  updateTransportation(batchId, {
    status: 'SUCCESS',
    error: null,
    optionId: selections[0]?.transportationOptionId || undefined,
    confirmedAt: now,
    confirmedShipments,
  });

  return NextResponse.json({
    success: true,
    status: 'SUCCESS',
    selections,
    confirmedShipments,
    message: 'Transportation confirmed. Seller Central shipment workflow is now unlocked.',
  });
}
