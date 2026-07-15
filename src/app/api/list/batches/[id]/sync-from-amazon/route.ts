/**
 * POST /api/list/batches/[id]/sync-from-amazon
 *
 * Reconciles FlipLedger's batch state with whatever Amazon currently has.
 * Used when the user finished the workflow (boxing → packing → placement →
 * shipments) in Seller Central instead of FlipLedger — typically because
 * setPackingInformation 403'd and the user had to detour.
 *
 * What we do:
 *   1. GET the inbound plan from Amazon
 *   2. listShipments — if any exist, the plan is past placement
 *   3. Update batch.status / packing_status / placement_status to match
 *
 * After this runs, the existing /shipments and /labels endpoints will work
 * because the batch is now in 'shipping' status.
 */
import { NextRequest, NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import { clearTokenCache } from '@/lib/sp-api/auth';
import {
  getInboundPlan,
  listInboundPlanItems,
  listInboundPlans,
  listShipments,
} from '@/lib/sp-api/inboundPlansV2';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import {
  buildInboundPlanName,
  compareInboundPlanManifest,
  selectRecoverableInboundPlan,
} from '@/lib/inbound-plan-recovery';
import { openFlipLedgerDb } from '@/lib/sqlite';

function getDb() {
  return openFlipLedgerDb();
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

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });

  const db = getDb();
  let creds: SPAPICredentials | null;
  let inboundPlanId: string | null;
  let inboundPlanName: string;
  let expectedItems: Array<{ msku: string; quantity: number }>;
  try {
    const batch = db.prepare(`
      SELECT id, name, status, channel, inbound_plan_id as inboundPlanId
      FROM listing_batches WHERE id = ?
    `).get(batchId) as {
      id: number;
      name: string;
      status: string;
      channel: string;
      inboundPlanId: string | null;
    } | undefined;
    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.channel !== 'FBA') {
      return NextResponse.json({ error: 'Sync only applies to FBA batches' }, { status: 400 });
    }
    creds = getAmazonCredentials(db);
    inboundPlanId = batch.inboundPlanId;
    inboundPlanName = buildInboundPlanName(batchId, batch.name);
    expectedItems = db.prepare(`
      SELECT sku AS msku, quantity
      FROM listing_batch_items
      WHERE batch_id = ?
      ORDER BY id
    `).all(batchId) as Array<{ msku: string; quantity: number }>;
  } finally {
    db.close();
  }

  if (!creds) {
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  clearTokenCache();
  let recovered = false;

  if (!inboundPlanId) {
    let recoveryMatch;
    try {
      recoveryMatch = selectRecoverableInboundPlan(
        await listInboundPlans(creds, { status: 'ACTIVE' }),
        inboundPlanName,
      );
    } catch (err) {
      return NextResponse.json({
        error: `Could not search Amazon for the missing inbound plan: ${err}`,
      }, { status: 502 });
    }

    if (recoveryMatch.kind === 'none') {
      return NextResponse.json({
        error: `Amazon has no active inbound plan named "${inboundPlanName}".`,
      }, { status: 404 });
    }
    if (recoveryMatch.kind === 'ambiguous') {
      return NextResponse.json({
        error: `Amazon has multiple active plans named "${inboundPlanName}". `
          + 'Recovery is ambiguous and was stopped without changing FlipLedger.',
        planIds: recoveryMatch.plans.map((plan) => plan.inboundPlanId),
      }, { status: 409 });
    }

    inboundPlanId = recoveryMatch.plan.inboundPlanId;
    let remoteItems;
    try {
      remoteItems = await listInboundPlanItems(creds, inboundPlanId);
    } catch (err) {
      return NextResponse.json({
        error: `Found the Amazon plan but could not verify its contents: ${err}`,
      }, { status: 502 });
    }
    const manifestCheck = compareInboundPlanManifest(expectedItems, remoteItems);
    if (!manifestCheck.ok) {
      return NextResponse.json({ error: manifestCheck.error }, { status: 409 });
    }
    recovered = true;
  }

  let plan: {
    status?: string;
    placementOptions?: Array<{ status?: string }>;
    packingOptions?: Array<{ status?: string }>;
    shipments?: Array<{ shipmentId?: string; status?: string }>;
  };
  try {
    plan = await getInboundPlan(creds, inboundPlanId);
  } catch (err) {
    return NextResponse.json({ error: `getInboundPlan failed: ${err}` }, { status: 500 });
  }

  // Two sources of truth for shipments — the plan has a short list, the
  // separate listShipments endpoint has full detail. Prefer the separate
  // endpoint, fall back to the plan's embedded array.
  let shipments: Array<{ shipmentId?: string; status?: string }> = [];
  try {
    shipments = await listShipments(creds, inboundPlanId);
  } catch (err) {
    console.warn(`[sync-from-amazon] listShipments failed: ${err}`);
  }
  if (shipments.length === 0 && plan.shipments && plan.shipments.length > 0) {
    shipments = plan.shipments;
  }

  // Amazon v2024 uses "ACCEPTED" (not "CONFIRMED") once the seller picks an
  // option and the workflow advances to the next stage. Treat both as "done."
  const isDone = (s?: string) => s === 'CONFIRMED' || s === 'ACCEPTED';
  const confirmedPlacement = (plan.placementOptions || []).some((p) => isDone(p.status));
  const confirmedPacking = (plan.packingOptions || []).some((p) => isDone(p.status));

  let newStatus: string | null = recovered ? 'ready' : null;
  let newPackingStatus: string | null = null;
  let newPlacementStatus: string | null = null;

  if (shipments.length > 0) {
    newStatus = 'shipping';
    newPackingStatus = 'SUCCESS';
    newPlacementStatus = 'SUCCESS';
  } else if (confirmedPlacement) {
    newStatus = 'shipping';
    newPackingStatus = 'SUCCESS';
    newPlacementStatus = 'SUCCESS';
  } else if (confirmedPacking) {
    newStatus = 'placement';
    newPackingStatus = 'SUCCESS';
  }

  if (newStatus || recovered) {
    const db2 = getDb();
    try {
      db2.prepare(`
      UPDATE listing_batches
      SET status = ?,
          inbound_plan_id = COALESCE(?, inbound_plan_id),
          inbound_operation_id = CASE WHEN ? THEN NULL ELSE inbound_operation_id END,
          plan_status = CASE WHEN ? THEN 'SUCCESS' ELSE plan_status END,
          packing_status = COALESCE(?, packing_status),
          placement_status = COALESCE(?, placement_status),
          packing_error = NULL,
          placement_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `).run(
        newStatus,
        inboundPlanId,
        recovered ? 1 : 0,
        recovered ? 1 : 0,
        newPackingStatus,
        newPlacementStatus,
        batchId,
      );
    } finally {
      db2.close();
    }
  }

  return NextResponse.json({
    success: true,
    recovered,
    planStatus: plan.status,
    confirmedPacking,
    confirmedPlacement,
    shipmentCount: shipments.length,
    shipmentIds: shipments.map((s) => s.shipmentId).filter(Boolean),
    newStatus,
    newPackingStatus,
    newPlacementStatus,
    message: newStatus
      ? `Batch synced — now in '${newStatus}' status with ${shipments.length} shipment(s).`
      : 'Plan is still pre-packing on Amazon\'s side; nothing to update.',
    rawPlan: plan,
    rawShipments: shipments,
  });
}
