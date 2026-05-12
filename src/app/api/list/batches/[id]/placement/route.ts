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
import { clearTokenCache, spApiRequest } from '@/lib/sp-api/auth';
import {
  generatePlacementOptions,
  listPlacementOptions,
  confirmPlacementOption,
  listShipments,
  getInboundPlan,
  getInboundOperation,
  type PlacementOption,
} from '@/lib/sp-api/inboundPlansV2';
import { lookupFC } from '@/lib/fc-lookup';

// Approximate geographic center (lat, lng) for each US state.
const STATE_CENTROIDS: Record<string, [number, number]> = {
  AL:[32.81,-86.79],AK:[64.20,-153.37],AZ:[34.17,-111.09],AR:[34.74,-92.26],
  CA:[36.17,-119.75],CO:[39.00,-105.55],CT:[41.60,-72.69],DE:[39.16,-75.51],
  FL:[28.63,-82.45],GA:[32.64,-83.44],HI:[20.29,-156.37],ID:[44.35,-114.61],
  IL:[40.05,-89.20],IN:[39.85,-86.26],IA:[42.08,-93.50],KS:[38.53,-96.73],
  KY:[37.67,-84.87],LA:[31.17,-92.00],ME:[45.37,-69.24],MD:[39.06,-76.80],
  MA:[42.23,-71.53],MI:[44.35,-85.41],MN:[46.28,-94.31],MS:[32.74,-89.68],
  MO:[38.46,-92.29],MT:[47.03,-109.64],NE:[41.49,-99.90],NV:[39.33,-116.62],
  NH:[43.45,-71.56],NJ:[40.04,-74.27],NM:[34.52,-105.87],NY:[42.17,-74.95],
  NC:[35.63,-79.81],ND:[47.53,-99.78],OH:[40.39,-82.76],OK:[35.59,-97.49],
  OR:[44.57,-122.07],PA:[40.59,-77.21],RI:[41.68,-71.51],SC:[33.90,-80.90],
  SD:[44.30,-99.44],TN:[35.75,-86.69],TX:[31.05,-97.56],UT:[40.15,-111.86],
  VT:[44.05,-72.71],VA:[37.77,-78.17],WA:[47.40,-120.74],WV:[38.49,-80.95],
  WI:[44.27,-89.62],WY:[42.76,-107.30],DC:[38.90,-77.03],
};

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export interface ShipmentMeta {
  shipmentId: string;
  fcCode: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  distanceMiles: number | null;
}

export interface PlacementDestination {
  shipmentId: string;
  fcCode: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  distanceMiles: number | null;
  type?: string | null;
  carrier?: string | null;
  shippingCost?: number | null;
  boxes?: number | null;
  units?: number | null;
}
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
             placement_option_id as placementOptionId,
             ship_from_state as shipFromState,
             ship_from_postal_code as shipFromPostalCode
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

    // Ship-from state: prefer batch field, fall back to settings
    let shipFromState = batch.shipFromState as string | null;
    if (!shipFromState) {
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      const s: Record<string, string> = {};
      for (const r of rows) s[r.key] = r.value;
      shipFromState = s.listing_ship_from_state || null;
    }

    if (!creds) {
      return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
    }
    db.close();

    clearTokenCache();

    if (!batch.placementStatus) {
      return NextResponse.json({ generated: false, placementStatus: null, options: [], shipmentMeta: {}, shipFromState });
    }

    // Fire all three SP-API calls in parallel — sequential calls were adding
    // 5-15s of latency on every page load.
    const [rawPlacementResponse, rawShipmentsResponseParallel, rawInboundPlan] = await Promise.all([
      spApiRequest(
        creds,
        `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(batch.inboundPlanId)}/placementOptions`
      ).catch((err) => { throw new Error(`listPlacementOptions failed: ${err}`); }),
      spApiRequest(
        creds,
        `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(batch.inboundPlanId)}/shipments`
      ).catch((err) => {
        console.warn('[placement GET] listShipments failed (non-fatal):', err);
        return null;
      }),
      getInboundPlan(creds, batch.inboundPlanId).catch((err) => {
        console.warn('[placement GET] getInboundPlan failed (non-fatal):', err);
        return null;
      }),
    ]);

    const options: PlacementOption[] = rawPlacementResponse?.placementOptions || [];
    console.log('[placement GET] placement options count:', options.length, '| inboundPlan keys:', Object.keys(rawInboundPlan || {}));

    // ── Enrich each option with split fee totals ───────────────────────────
    const enrichedOptions = options.map((opt) => {
      let placementFeeCents = 0;
      let carrierFeeCents = 0;
      for (const f of opt.fees ?? []) {
        const t = (f.type ?? '').toUpperCase();
        const cents = Math.round((f.value?.amount ?? 0) * 100);
        if (t.includes('PLACEMENT') || t.includes('SERVICE')) {
          placementFeeCents += cents;
        } else if (t.includes('TRANSPORT') || t.includes('INBOUND') || t.includes('CARRIER')) {
          carrierFeeCents += cents;
        } else {
          placementFeeCents += cents;
        }
      }
      return { ...opt, placementFeeCents, carrierFeeCents };
    });

    // ── Process shipments from the parallel fetch ─────────────────────────
    const shipmentMeta: Record<string, ShipmentMeta> = {};
    const rawShipmentsResponse: any = rawShipmentsResponseParallel;
    const rawShipments: any[] = rawShipmentsResponse?.shipments || [];
    const shipFromCoords = shipFromState ? STATE_CENTROIDS[shipFromState.toUpperCase()] : null;

    console.log('[placement GET] shipments count:', rawShipments.length);
    if (rawShipments.length > 0) {
      console.log('[placement GET] rawShipmentsResponse full:', JSON.stringify(rawShipmentsResponse, null, 2));
    }

    if (rawShipments.length > 0) {
      for (const s of rawShipments as any[]) {
        const shipmentId: string = s.shipmentId || s.ShipmentId || '';
        if (!shipmentId) continue;

        // Amazon v2024 returns destination in either `destination.address` or
        // top-level `destinationAddress` depending on the plan state.
        const addr = s.destination?.address || s.destinationAddress || s.destination || null;
        const addrCity: string | null = addr?.city || addr?.City || null;
        const addrState: string | null = addr?.stateOrProvinceCode || addr?.StateOrProvinceCode || null;
        const postalCode: string | null = addr?.postalCode || addr?.PostalCode || null;

        // FC code: try warehouseId fields first, then address name (often "FWA4"), then addr label
        const rawFcCode: string | null =
          s.destination?.warehouseId ||
          s.warehouseId ||
          s.destinationWarehouseId ||
          addr?.name ||
          addr?.label ||
          (shipmentId.startsWith('FBA') ? null : shipmentId) ||
          null;

        // Try FC_LOOKUP for precise city/state/lat/lng; fall back to addr + STATE_CENTROIDS
        const fcInfo = rawFcCode ? lookupFC(rawFcCode) : null;
        const city: string | null = fcInfo?.city ?? addrCity;
        const state: string | null = fcInfo?.state ?? addrState;

        let lat: number | null = fcInfo?.lat ?? null;
        let lng: number | null = fcInfo?.lng ?? null;
        if (lat == null && state) {
          const sc = STATE_CENTROIDS[state.toUpperCase()];
          if (sc) { lat = sc[0]; lng = sc[1]; }
        }

        const distanceMiles =
          shipFromCoords && lat != null && lng != null
            ? haversineMiles(shipFromCoords[0], shipFromCoords[1], lat, lng)
            : null;

        // Also capture shipping cost from any cost field Amazon provides
        const shippingCost: number | null =
          s.shippingCost?.amount != null ? Math.round(s.shippingCost.amount * 100) :
          s.estimatedTransportationCost?.amount != null ? Math.round(s.estimatedTransportationCost.amount * 100) :
          null;

        shipmentMeta[shipmentId] = {
          shipmentId,
          fcCode: rawFcCode,
          city,
          state,
          postalCode,
          lat,
          lng,
          distanceMiles,
        };
      }
    }

    // ── Attach destinations array to each enriched option ─────────────────
    const optionsWithDestinations = enrichedOptions.map((opt) => {
      const destinations: PlacementDestination[] = opt.shipmentIds.map((sid) => {
        const meta = shipmentMeta[sid];
        if (meta) {
          return {
            shipmentId: sid,
            fcCode: meta.fcCode,
            city: meta.city,
            state: meta.state,
            lat: meta.lat,
            lng: meta.lng,
            distanceMiles: meta.distanceMiles,
            type: null,
            carrier: null,
            shippingCost: null,
            boxes: null,
            units: null,
          };
        }
        // Shipment not yet in listShipments response — return stub
        return {
          shipmentId: sid,
          fcCode: null,
          city: null,
          state: null,
          lat: null,
          lng: null,
          distanceMiles: null,
          type: null,
          carrier: null,
          shippingCost: null,
          boxes: null,
          units: null,
        };
      });
      return { ...opt, destinations };
    });

    return NextResponse.json({
      generated: true,
      placementStatus: batch.placementStatus,
      confirmedOptionId: batch.placementOptionId,
      options: optionsWithDestinations,
      shipmentMeta,
      shipFromState,
      shipFromLat: shipFromCoords ? shipFromCoords[0] : null,
      shipFromLng: shipFromCoords ? shipFromCoords[1] : null,
      _debug: {
        rawPlacementResponse,
        rawShipmentsResponse,
        rawInboundPlan,
        shipmentMetaKeys: Object.keys(shipmentMeta),
        optionShipmentIds: options.map(o => ({ id: o.placementOptionId, sids: o.shipmentIds })),
      },
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

  updateBatchPlacement(batchId, { status: 'GENERATED', error: null });

  // Same shipment-meta enrichment as GET so the UI gets location data immediately.
  return NextResponse.json({
    success: true,
    placementStatus: 'GENERATED',
    options,
  });
  // (shipmentMeta will be fetched on next GET — generate is fire-and-done)
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

  // Re-fetch confirmed shipment IDs — Amazon may assign new IDs post-confirmation,
  // so we can't trust the IDs from listPlacementOptions before confirm.
  let confirmedShipmentIds: string[] = [];
  try {
    const confirmedOptions = await listPlacementOptions(creds, inboundPlanId);
    const confirmed = confirmedOptions.find((o) => o.placementOptionId === placementOptionId);
    confirmedShipmentIds = confirmed?.shipmentIds || chosenOption?.shipmentIds || [];
    console.log(`[placement confirm] confirmed shipment IDs: ${JSON.stringify(confirmedShipmentIds)}`);
  } catch (err) {
    // Non-fatal — fall back to pre-confirm IDs if available
    confirmedShipmentIds = chosenOption?.shipmentIds || [];
    console.warn(`[placement confirm] could not re-fetch shipment IDs after confirm: ${err}`);
  }

  // Persist: mark placement SUCCESS + save confirmed shipment IDs + transition to 'shipping'.
  const db = getDb();
  try {
    // Ensure column exists (safe to run each time)
    try { db.exec(`ALTER TABLE listing_batches ADD COLUMN confirmed_shipment_ids TEXT`); } catch {}
    db.prepare(`
      UPDATE listing_batches SET
        status = 'shipping',
        placement_status = 'SUCCESS',
        placement_option_id = ?,
        placement_fee_cents = ?,
        placement_confirmed_at = ?,
        placement_error = NULL,
        confirmed_shipment_ids = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      placementOptionId,
      placementFeeCents,
      new Date().toISOString(),
      JSON.stringify(confirmedShipmentIds),
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
    confirmedShipmentIds,
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
