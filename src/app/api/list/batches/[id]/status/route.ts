/**
 * GET /api/list/batches/[id]/status
 *
 * Polls Amazon for the current state of a batch that has been sent.
 *   - For each item with listing_status = PROCESSING, call GET /listings to
 *     check if it's gone ACTIVE.
 *   - If the batch has an inbound_operation_id and plan_status != SUCCESS,
 *     call GET /operations/{id} to check the plan state.
 *   - When both all listings are ACTIVE and the operation is SUCCESS,
 *     transition the batch to 'ready'.
 *
 * Called by the frontend on a ~5s interval while the batch is in 'sending'
 * or 'ready' state. Cheap for draft batches (DB-only, no SP-API calls).
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { getListing, getSellerId } from '@/lib/sp-api/listingsItems';
import { getInboundOperation, getInboundPlan } from '@/lib/sp-api/inboundPlansV2';
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

  try {
    // Return the same batch shape as GET /api/list/batches/[id] so the frontend
    // can safely replace `batch` state with this response. (If we return a
    // subset, fields like `createdAt` go undefined and the header renders as
    // "Created Invalid Date".)
    const batch = db.prepare(`
      SELECT
        id, name, status, channel, marketplace,
        inbound_plan_id as inboundPlanId,
        inbound_operation_id as inboundOperationId,
        plan_status as planStatus,
        send_error as sendError,
        sent_at as sentAt,
        ship_from_name as shipFromName,
        ship_from_address_line1 as shipFromAddressLine1,
        ship_from_city as shipFromCity,
        ship_from_state as shipFromState,
        ship_from_postal_code as shipFromPostalCode,
        ship_from_country_code as shipFromCountryCode,
        ship_from_phone as shipFromPhone,
        packing_operation_id as packingOperationId,
        packing_option_id as packingOptionId,
        packing_group_id as packingGroupId,
        packing_status as packingStatus,
        packing_confirmed_at as packingConfirmedAt,
        packing_error as packingError,
        placement_operation_id as placementOperationId,
        placement_option_id as placementOptionId,
        placement_status as placementStatus,
        placement_fee_cents as placementFeeCents,
        placement_confirmed_at as placementConfirmedAt,
        placement_error as placementError,
        notes,
        created_at as createdAt,
        updated_at as updatedAt
      FROM listing_batches WHERE id = ?
    `).get(batchId) as any;

    if (!batch) {
      db.close();
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }

    // Return the same item shape as GET /api/list/batches/[id] so the frontend
    // can safely replace `items` state with this response. (If we return a
    // subset, the items table crashes on missing fields like `condition`.)
    const items = db.prepare(`
      SELECT
        id, batch_id as batchId, asin, sku, msku,
        product_name as productName, image_url as imageUrl,
        condition, quantity,
        list_price_cents as listPriceCents,
        buy_price_cents as buyPriceCents,
        supplier, purchase_date as purchaseDate,
        estimated_fee_cents as estimatedFeeCents,
        estimated_ship_cents as estimatedShipCents,
        listing_status as listingStatus,
        listing_submission_id as listingSubmissionId,
        listing_error as listingError,
        listing_updated_at as listingUpdatedAt,
        labels_printed_at as labelsPrintedAt,
        created_at as createdAt
      FROM listing_batch_items WHERE batch_id = ?
      ORDER BY id ASC
    `).all(batchId) as any[];

    // If the batch isn't in an active state, just return what we have.
    if (batch.status === 'draft' || batch.status === 'failed' || batch.status === 'ready') {
      db.close();
      return NextResponse.json({ batch, items });
    }

    // The batch is in 'sending' — poll Amazon for updates.
    const creds = getAmazonCredentials(db);
    db.close();
    if (!creds) {
      return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
    }

    // Refresh each processing listing. ACTIVE only when Amazon's authoritative
    // summary.status includes 'BUYABLE' — that's the signal that customers can
    // actually purchase. Intermediate states like ['DISCOVERABLE'] mean the
    // listing is registered but not yet buyable. ERROR-severity issues are
    // surfaced as non-fatal warnings (most of them clear on their own — fresh
    // FBM listings can take 30+ min after submission before BUYABLE).
    // Channel-aware "ready" check:
    //   FBA: FNSKU populated = listing is FBA-registered, ready for inbound.
    //        BUYABLE only happens after physical inventory arrives at Amazon.
    //        Waiting for BUYABLE here would hang the batch indefinitely.
    //   MFN: summary.status contains 'BUYABLE' = customer can buy now (seller
    //        manages stock, no warehouse handoff needed).
    const sellerId = await getSellerId(creds).catch(() => null);
    if (sellerId) {
      for (const item of items) {
        if (item.listingStatus !== 'PROCESSING') continue;
        try {
          const listing = await getListing(creds, sellerId, item.sku);
          if (!listing) continue; // still being registered, leave as PROCESSING

          const summary = listing.summaries?.[0];
          const summaryStatus: string[] = summary?.status || [];
          const fnSku: string | undefined = summary?.fnSku;

          const isReady = batch.channel === 'FBA'
            ? !!fnSku
            : summaryStatus.includes('BUYABLE');

          // Capture ERROR-severity issues as informational warnings (e.g.,
          // "child variation needs size attribute") — they don't block FBA
          // inbound and often clear on their own.
          const issues: any[] = listing.issues || [];
          const errorIssues = issues.filter((i: any) => (i?.severity || '').toUpperCase() === 'ERROR');
          const errorNote = errorIssues.length > 0
            ? errorIssues.map((i: any) => i.message).join('; ')
            : null;

          if (isReady) {
            saveListingState(batchId, item.id, { status: 'ACTIVE', error: errorNote });
            item.listingStatus = 'ACTIVE';
            item.listingError = errorNote;
          } else if (errorNote !== item.listingError) {
            saveListingState(batchId, item.id, { status: 'PROCESSING', error: errorNote });
            item.listingError = errorNote;
          }
        } catch (err) {
          console.warn(`[batch status] listing poll failed for ${item.sku}:`, err);
        }
      }
    }

    // For FBA batches, also poll the inbound plan operation state.
    // MFN batches have no operation — readiness is just "all listings ACTIVE".
    let operationStatus: 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | null = null;
    let operationProblems: any[] = [];
    if (batch.channel === 'FBA' && batch.inboundOperationId && batch.planStatus !== 'SUCCESS') {
      try {
        const op = await getInboundOperation(creds, batch.inboundOperationId);
        operationStatus = op.operationStatus;
        operationProblems = op.operationProblems;
        // Persist
        const db2 = getDb();
        try {
          db2.prepare(`UPDATE listing_batches SET plan_status = ?, updated_at = ? WHERE id = ?`)
            .run(op.operationStatus, new Date().toISOString(), batchId);
        } finally {
          db2.close();
        }
        batch.planStatus = op.operationStatus;
      } catch (err) {
        console.warn(`[batch status] operation poll failed:`, err);
      }
    }

    // Decide whether to transition to 'ready' or 'failed'.
    // FBA:  all listings ACTIVE + operation SUCCESS
    // MFN:  all listings ACTIVE (no operation)
    const allListingsReady = items.every((i) => i.listingStatus === 'ACTIVE');
    const anyListingFailed = items.some((i) => i.listingStatus === 'FAILED');
    const opDone = batch.channel === 'FBA'
      ? ((operationStatus || batch.planStatus) === 'SUCCESS')
      : true;
    const opFailed = batch.channel === 'FBA' && (operationStatus || batch.planStatus) === 'FAILED';

    if (anyListingFailed || opFailed) {
      const errorMsg = anyListingFailed
        ? 'One or more listings failed Amazon verification. See per-item errors.'
        : `Inbound plan operation failed: ${JSON.stringify(operationProblems)}`;
      const db3 = getDb();
      try {
        db3.prepare(`UPDATE listing_batches SET status = 'failed', send_error = ?, updated_at = ? WHERE id = ?`)
          .run(errorMsg, new Date().toISOString(), batchId);
      } finally {
        db3.close();
      }
      batch.status = 'failed';
      batch.sendError = errorMsg;
    } else if (allListingsReady && opDone) {
      const db4 = getDb();
      try {
        db4.prepare(`UPDATE listing_batches SET status = 'ready', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), batchId);
      } finally {
        db4.close();
      }
      batch.status = 'ready';
    }

    // Optionally fetch a fresh inbound plan snapshot for display
    let inboundPlan: any = null;
    if (batch.inboundPlanId && batch.planStatus === 'SUCCESS') {
      try {
        inboundPlan = await getInboundPlan(creds, batch.inboundPlanId);
      } catch (err) {
        console.warn(`[batch status] getInboundPlan failed:`, err);
      }
    }

    return NextResponse.json({
      batch,
      items,
      operationStatus: batch.planStatus,
      inboundPlan,
    });
  } catch (err) {
    try { db.close(); } catch {}
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function saveListingState(
  batchId: number,
  itemId: number,
  state: { status: string; error: string | null }
) {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE listing_batch_items SET
        listing_status = ?,
        listing_error = ?,
        listing_updated_at = ?
      WHERE id = ? AND batch_id = ?
    `).run(state.status, state.error, new Date().toISOString(), itemId, batchId);
  } finally {
    db.close();
  }
}
