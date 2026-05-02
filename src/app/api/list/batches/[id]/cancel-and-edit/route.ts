/**
 * POST /api/list/batches/[id]/cancel-and-edit
 *
 * Cancels the inbound plan on Amazon and resets the batch to 'draft' state
 * so the user can add/edit items and re-send.
 *
 * Use case: user clicks Send to Amazon, gets to 'ready' or 'boxing' state,
 * then realizes they forgot a SKU. Without this endpoint they'd have to
 * complete this batch + create a separate batch for the missed item — annoying.
 *
 * What stays untouched on Amazon's side:
 *   - All listings (with their MSKUs, FNSKUs, prep classifications, attributes)
 *   - Compliance attributes (batteries_required, etc.)
 * What gets cancelled:
 *   - The inbound plan record (Amazon marks it CANCELLED in account history)
 *   - Any boxes that were declared (FlipLedger-local — wiped from listing_batch_boxes)
 * What gets reset locally:
 *   - Batch status → 'draft'
 *   - inbound_plan_id, inbound_operation_id, plan_status, packing_*, placement_* → null
 *   - listing_status on each item stays 'ACTIVE' (listings still exist on Amazon)
 *
 * Re-send after this is fast — the listings + FNSKUs already exist, so the
 * send flow takes a "replenishment" path (skips PUT validation delays) and
 * createInboundPlan succeeds on first try (no propagation wait).
 *
 * Allowed states: ready, boxing, placement.
 *   - draft: nothing to cancel
 *   - sending: plan creation in flight, can't cleanly cancel mid-flow
 *   - shipping/shipped: placement confirmed, real shipments exist — different
 *     workflow (would need to cancel each shipment separately)
 *   - failed/closed: terminal, doesn't make sense
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache, getAccessToken, getEndpoint } from '@/lib/sp-api/auth';
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

async function cancelInboundPlan(creds: SPAPICredentials, planId: string): Promise<{ ok: boolean; error?: string }> {
  const endpoint = getEndpoint(creds.marketplaceId);
  const accessToken = await getAccessToken(creds);
  const r = await fetch(`${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(planId)}/cancellation`, {
    method: 'PUT',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
  });
  // 202 = accepted, 200 = ok. 400 if already cancelled — also fine.
  if (r.status === 202 || r.status === 200) return { ok: true };
  if (r.status === 400) {
    const body = await r.text();
    // Already cancelled → treat as success
    if (body.includes('already cancelled') || body.includes('cannot be cancelled')) {
      return { ok: true };
    }
    return { ok: false, error: body };
  }
  return { ok: false, error: `HTTP ${r.status}: ${await r.text()}` };
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
  try {
    const batch = db.prepare(`
      SELECT id, status, channel, inbound_plan_id as inboundPlanId
      FROM listing_batches WHERE id = ?
    `).get(batchId) as { id: number; status: string; channel: string; inboundPlanId: string | null } | undefined;

    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    // Allowed: ready/boxing/placement (active plan to cancel) OR failed
    // (send hit a snag, no plan to cancel — just unlock for editing).
    const allowedStates = ['ready', 'boxing', 'placement', 'failed'];
    if (!allowedStates.includes(batch.status)) {
      return NextResponse.json({
        error: `Cancel & Edit is only allowed in ready/boxing/placement/failed (current status: ${batch.status}).`,
      }, { status: 400 });
    }
    inboundPlanId = batch.inboundPlanId;
    creds = getAmazonCredentials(db);
  } finally {
    db.close();
  }

  if (!creds) {
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  // Cancel the plan on Amazon (best-effort — even if this fails, we'll
  // reset the batch locally so the user isn't stuck. Amazon's plan will
  // expire on its own if not used.)
  let amazonCancelled = false;
  let amazonError: string | undefined;
  if (inboundPlanId) {
    clearTokenCache();
    const result = await cancelInboundPlan(creds, inboundPlanId);
    amazonCancelled = result.ok;
    amazonError = result.error;
    if (!amazonCancelled) {
      console.warn(`[cancel-and-edit] Amazon cancellation failed (proceeding with local reset): ${amazonError}`);
    }
  }

  // Reset batch state to draft. Wipe plan/packing/placement metadata.
  // Keep the items + their listing_status (listings still exist on Amazon).
  // Wipe boxes (those were FlipLedger-local).
  const db2 = getDb();
  try {
    const now = new Date().toISOString();
    const tx = db2.transaction(() => {
      // Wipe boxes (cascades to box_items)
      db2.prepare('DELETE FROM listing_batch_boxes WHERE batch_id = ?').run(batchId);

      // Reset batch metadata to draft
      db2.prepare(`
        UPDATE listing_batches SET
          status = 'draft',
          inbound_plan_id = NULL,
          inbound_operation_id = NULL,
          plan_status = NULL,
          send_error = NULL,
          sent_at = NULL,
          packing_operation_id = NULL,
          packing_option_id = NULL,
          packing_group_id = NULL,
          packing_status = NULL,
          packing_confirmed_at = NULL,
          packing_error = NULL,
          placement_operation_id = NULL,
          placement_option_id = NULL,
          placement_status = NULL,
          placement_fee_cents = NULL,
          placement_confirmed_at = NULL,
          placement_error = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(now, batchId);

      // Note: listing_status stays ACTIVE — the listings still exist on Amazon.
      // We just clear submission metadata since those are stale.
      db2.prepare(`
        UPDATE listing_batch_items SET
          listing_submission_id = NULL,
          listing_error = NULL,
          listing_updated_at = ?
        WHERE batch_id = ?
      `).run(now, batchId);
    });
    tx();
  } finally {
    db2.close();
  }

  return NextResponse.json({
    success: true,
    amazonCancelled,
    amazonError,
    cancelledPlanId: inboundPlanId,
    note: amazonCancelled
      ? 'Inbound plan cancelled on Amazon. Batch is now in draft state — add items and re-send.'
      : 'Local batch reset to draft. Amazon-side cancellation failed (plan may expire on its own).',
  });
}
