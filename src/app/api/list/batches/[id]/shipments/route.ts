/**
 * GET /api/list/batches/[id]/shipments
 *
 * Returns the shipments Amazon created for this batch's inbound plan after
 * placement was confirmed. Each shipment has a destination fulfillment
 * center address — this is what powers the "Print labels for shipment
 * FBA15PFFGT1U" UI in the boxing workflow, and (later) the placement map.
 *
 * Returns: { shipments: [{ shipmentId, name, status, destinationCity, ... }] }
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import { getInboundPlan, listShipments } from '@/lib/sp-api/inboundPlansV2';
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

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  const db = getDb();
  let creds: SPAPICredentials | null;
  let inboundPlanId: string | null;
  let batchStatus: string;
  try {
    const batch = db.prepare(`
      SELECT id, status, channel, inbound_plan_id as inboundPlanId
      FROM listing_batches WHERE id = ?
    `).get(batchId) as { id: number; status: string; channel: string; inboundPlanId: string | null } | undefined;
    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.channel !== 'FBA') {
      return NextResponse.json({ error: 'Shipments are only for FBA batches' }, { status: 400 });
    }
    if (!batch.inboundPlanId) {
      return NextResponse.json({ shipments: [], note: 'No inbound plan yet' });
    }
    creds = getAmazonCredentials(db);
    inboundPlanId = batch.inboundPlanId;
    batchStatus = batch.status;
  } finally {
    db.close();
  }

  if (!creds) {
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  // Shipments only exist after placement confirmed. Bail early on earlier
  // statuses — saves an SP-API call for an empty array.
  if (batchStatus !== 'shipping' && batchStatus !== 'shipped') {
    return NextResponse.json({ shipments: [], note: `Batch status is '${batchStatus}'; shipments appear after placement confirmation.` });
  }

  clearTokenCache();

  let raw: any[] = [];
  try {
    raw = await listShipments(creds, inboundPlanId);
  } catch (err) {
    console.warn(`[shipments] listShipments failed, will fall back to inbound plan: ${err}`);
  }
  // listShipments sometimes returns [] when the plan was advanced through
  // Seller Central. Fall back to the plan's embedded shipments array.
  if (raw.length === 0) {
    try {
      const plan = await getInboundPlan(creds, inboundPlanId);
      if (plan?.shipments?.length) raw = plan.shipments;
    } catch (err) {
      return NextResponse.json({ error: `getInboundPlan failed: ${err}` }, { status: 500 });
    }
  }

  // Normalize to a shape the UI can use directly. Amazon's response includes
  // tons of fields; we project just what's useful.
  const shipments = raw.map((s: any) => ({
    shipmentId: s.shipmentId,
    name: s.name || s.shipmentId,
    status: s.status,
    destination: s.destination?.address || null,
    destinationFC: s.destination?.warehouseId || null,
    boxCount: (s.placementOptions?.[0]?.shipmentIds || []).length || s.boxes?.length || null,
    contentInformationSource: s.contentInformationSource,
  }));

  return NextResponse.json({ shipments });
}
