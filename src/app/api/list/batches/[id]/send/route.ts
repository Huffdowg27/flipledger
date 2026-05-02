/**
 * POST /api/list/batches/[id]/send
 *
 * Channel-aware "Send/Publish to Amazon":
 *   1. For each batch item, checks if the MSKU already exists as a listing in
 *      Seller Central. If not, creates a LISTING_OFFER_ONLY entry via the
 *      Listings Items API.
 *   2. **FBA batches only**: creates an Amazon inbound plan via the
 *      Fulfillment Inbound v2024 API so the user can ship product to a
 *      warehouse. MFN batches skip this step — once listings are ACTIVE, the
 *      batch is ready for buyers.
 *   3. Stores the submission IDs, inbound plan ID, and operation ID on the
 *      batch so the GET /status endpoint can poll them.
 *   4. Transitions the batch status: draft → sending.
 *
 * After this endpoint returns, the frontend polls GET /status to update the UI
 * as Amazon verifies listings and processes the inbound plan operation.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import {
  getSellerId,
  getListing,
  getProductType,
  createOrUpdateListing,
} from '@/lib/sp-api/listingsItems';
import { createInboundPlan, setPrepDetails, getInboundOperation, type SourceAddress, type InboundPlanItem } from '@/lib/sp-api/inboundPlansV2';
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
    // 1. Load the batch and validate state
    const batch = db.prepare(`
      SELECT
        id, name, status, channel, marketplace,
        ship_from_name as shipFromName,
        ship_from_address_line1 as shipFromAddressLine1,
        ship_from_city as shipFromCity,
        ship_from_state as shipFromState,
        ship_from_postal_code as shipFromPostalCode,
        ship_from_country_code as shipFromCountryCode,
        ship_from_phone as shipFromPhone,
        inbound_plan_id as inboundPlanId
      FROM listing_batches WHERE id = ?
    `).get(batchId) as any;

    if (!batch) {
      db.close();
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.status !== 'draft') {
      db.close();
      return NextResponse.json({ error: `Batch is not in draft status (currently: ${batch.status})` }, { status: 400 });
    }
    if (batch.channel !== 'FBA' && batch.channel !== 'MFN') {
      db.close();
      return NextResponse.json({ error: `Unknown channel: ${batch.channel}` }, { status: 400 });
    }

    // 2. Validate ship-from — all fields required for FBA (inbound plans need it).
    //    MFN listings don't need ship-from — the seller handles fulfillment and
    //    ship-from is set on individual shipments later when orders come in.
    if (batch.channel === 'FBA') {
      const required: [string, any][] = [
        ['name', batch.shipFromName],
        ['address', batch.shipFromAddressLine1],
        ['city', batch.shipFromCity],
        ['state', batch.shipFromState],
        ['postal code', batch.shipFromPostalCode],
        ['country', batch.shipFromCountryCode],
        ['phone', batch.shipFromPhone],
      ];
      for (const [label, value] of required) {
        if (!value) {
          db.close();
          return NextResponse.json({ error: `Ship-from ${label} is required for FBA. Check Settings.` }, { status: 400 });
        }
      }
    }

    // 3. Load items
    const items = db.prepare(`
      SELECT id, asin, sku, product_name as productName, condition, quantity, list_price_cents as listPriceCents
      FROM listing_batch_items WHERE batch_id = ?
      ORDER BY id ASC
    `).all(batchId) as any[];

    if (items.length === 0) {
      db.close();
      return NextResponse.json({ error: 'Batch has no items' }, { status: 400 });
    }

    // 4. Get Amazon credentials
    const creds = getAmazonCredentials(db);
    if (!creds) {
      db.close();
      return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
    }

    // Force a fresh token to avoid a stale one after a recent re-auth
    clearTokenCache();

    // 5. Transition batch → sending (so any concurrent call is blocked)
    db.prepare(`
      UPDATE listing_batches SET status = 'sending', send_error = NULL, sent_at = ?, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), new Date().toISOString(), batchId);

    db.close();
    // From here on, use a fresh DB handle per write to avoid holding the connection
    // while we wait on slow SP-API calls.

    // 6. Resolve seller ID (cached on first call)
    let sellerId: string;
    try {
      sellerId = await getSellerId(creds);
    } catch (err) {
      return failBatch(batchId, `Could not resolve Amazon seller ID: ${err}`);
    }

    // 7. For each item: check if listing exists, create/update it, then
    //    immediately GET the listing and classify it based on issues + offers.
    //    PUT returning "ACCEPTED" is NOT the same as the listing being live —
    //    Amazon can accept the submission but then block the offer during
    //    validation (e.g. catalog-level data errors on the target ASIN).
    const listingResults: { itemId: number; sku: string; status: string; submissionId: string | null; error: string | null }[] = [];

    for (const item of items) {
      try {
        // Check if listing already exists (replenishment vs new MSKU).
        // Either way, we then call createOrUpdateListing.
        const existing = await getListing(creds, sellerId, item.sku);
        const productType = existing?.productTypes?.[0]?.productType || await getProductType(creds, item.asin);

        const result = await createOrUpdateListing(creds, sellerId, {
          sku: item.sku,
          asin: item.asin,
          condition: item.condition,
          quantity: item.quantity,
          listPriceCents: item.listPriceCents,
          channel: batch.channel,
          productType,
        });

        // CRITICAL: check the PUT response status BEFORE polling for live state.
        // Amazon returns HTTP 200 with `status: "INVALID"` and an `issues` array
        // when required attributes are missing — there's no listing entity
        // created, and a subsequent GET will return 404. If we treat that as
        // PROCESSING, the inbound plan creation later fails with "MSKU not valid"
        // (because the listing literally doesn't exist on Amazon's side).
        if (result.status === 'INVALID') {
          const issueMsg = (result.issues || [])
            .map((i: any) => `[${i.severity}] ${i.attributeNames?.join(',') || i.code}: ${i.message}`)
            .join(' | ');
          listingResults.push({
            itemId: item.id,
            sku: item.sku,
            status: 'FAILED',
            submissionId: result.submissionId,
            error: `Listing rejected by Amazon — ${issueMsg || 'no details'}`,
          });
          saveListingState(batchId, item.id, {
            listing_status: 'FAILED',
            listing_submission_id: result.submissionId,
            listing_error: `Listing rejected by Amazon — ${issueMsg || 'no details'}`,
          });
          continue;
        }

        // Status is ACCEPTED or VALID. Now poll to see whether the offer is
        // ready (BUYABLE for MFN, FNSKU-assigned for FBA — see classifyListing).
        const classification = await classifyListing(creds, sellerId, item.sku, batch.channel);

        listingResults.push({
          itemId: item.id,
          sku: item.sku,
          status: classification.status,
          submissionId: result.submissionId,
          error: classification.error,
        });
        saveListingState(batchId, item.id, {
          listing_status: classification.status,
          listing_submission_id: result.submissionId,
          listing_error: classification.error,
        });
      } catch (err) {
        listingResults.push({
          itemId: item.id,
          sku: item.sku,
          status: 'FAILED',
          submissionId: null,
          error: String(err),
        });
        saveListingState(batchId, item.id, {
          listing_status: 'FAILED',
          listing_submission_id: null,
          listing_error: String(err),
        });
      }
    }

    // 8. If ANY listing PUT threw an exception (network error, 4xx from Amazon,
    //    etc.), abort before creating the inbound plan. Note: "FAILED" here
    //    means the PUT itself failed — NOT just that issues were surfaced
    //    during classification. Soft issues are surfaced as PROCESSING.
    const failedListings = listingResults.filter((r) => r.status === 'FAILED');
    if (failedListings.length > 0) {
      return failBatch(batchId, `${failedListings.length} listing(s) failed. First error: ${failedListings[0].error}`);
    }

    // 9. If FBA, create the inbound plan now that listings are in-flight.
    //    Amazon accepts the plan creation even if some listings are still
    //    PROCESSING — the inbound plan operation will itself take a few minutes
    //    to go from IN_PROGRESS to SUCCESS, which gives the listings time to
    //    finish verifying.
    //
    //    MFN batches skip this step — the "ready" state is just "all listings
    //    ACTIVE". No inbound plan, no warehouse shipment.
    if (batch.channel === 'FBA') {
      const sourceAddress: SourceAddress = {
        name: batch.shipFromName,
        addressLine1: batch.shipFromAddressLine1,
        city: batch.shipFromCity,
        stateOrProvinceCode: batch.shipFromState,
        postalCode: batch.shipFromPostalCode,
        countryCode: batch.shipFromCountryCode,
        phoneNumber: batch.shipFromPhone,
      };

      // Build plan items now (used after FNSKU + prep steps below).
      // prepOwner='SELLER' assumes prep classification will be NONE/ITEM_NO_PREP.
      // The smart-retry loop further down handles edge cases where Amazon
      // disagrees about prep ownership for a specific MSKU.
      const planItems: InboundPlanItem[] = items.map((i) => ({
        msku: i.sku,
        quantity: i.quantity,
        prepOwner: 'SELLER',
        labelOwner: 'SELLER',
      }));

      // Amazon's Listings Items API and Fulfillment Inbound API are different
      // services with separate caches. After PUTting a brand new MSKU, the
      // Listings service knows about it immediately, but the Inbound Plans
      // service can take 30s-10min to register the MSKU as "available for
      // inbound." When you call createInboundPlan too early, Amazon returns
      // a 400 with this specific message:
      //   "The following MSKUs are not available for inbound.
      //    If these were recently added, please try again later."
      // We retry on that exact error string with 30s delay, up to 12 attempts
      // (~6 minutes max wait), which has been observed to cover virtually all
      // cases for newly-created listings. Other 4xx errors are not retried —
      // they indicate a real problem (bad ASIN, missing attributes, etc.).
      // Step 1: Wait for FNSKUs on all new MSKUs. This is the "FBA-registered"
      // signal — without it, Amazon's prep classification system can't see
      // the MSKU yet (and createInboundPlan will reject it).
      const FNSKU_POLL_MS = 20_000;     // 20s between polls
      const FNSKU_MAX_ATTEMPTS = 30;    // 30 × 20s = 10 min total
      const skusNeedingFnsku = items.map((i) => i.sku);
      console.log(`[send] Waiting for FNSKUs on ${skusNeedingFnsku.length} MSKU(s)…`);
      let fnskuReadyCount = 0;
      for (let attempt = 0; attempt < FNSKU_MAX_ATTEMPTS; attempt++) {
        let allReady = true;
        fnskuReadyCount = 0;
        for (const sku of skusNeedingFnsku) {
          try {
            const listing = await getListing(creds, sellerId, sku);
            if (listing?.summaries?.[0]?.fnSku) {
              fnskuReadyCount++;
            } else {
              allReady = false;
            }
          } catch {
            allReady = false;
          }
        }
        if (allReady) {
          console.log(`[send] All ${fnskuReadyCount}/${skusNeedingFnsku.length} FNSKUs ready after ${(attempt + 1) * FNSKU_POLL_MS / 1000}s`);
          break;
        }
        if (attempt === FNSKU_MAX_ATTEMPTS - 1) {
          console.warn(`[send] FNSKU wait timeout — only ${fnskuReadyCount}/${skusNeedingFnsku.length} ready after ${FNSKU_MAX_ATTEMPTS * FNSKU_POLL_MS / 1000}s. Proceeding anyway — createInboundPlan retry will catch up if needed.`);
          break;
        }
        console.log(`[send] FNSKU wait: ${fnskuReadyCount}/${skusNeedingFnsku.length} ready (attempt ${attempt + 1}/${FNSKU_MAX_ATTEMPTS}), waiting ${FNSKU_POLL_MS / 1000}s…`);
        await new Promise((r) => setTimeout(r, FNSKU_POLL_MS));
      }

      // Step 2: classify prep details for each MSKU at the account level —
      // AFTER FNSKUs are assigned. Setting prep BEFORE FNSKU assignment leaves
      // brand-new MSKUs as prepCategory='UNKNOWN' (the classification doesn't
      // stick), and the inbound plan operation later fails with FBA_INB_0182.
      //
      // Default each MSKU to NONE/ITEM_NO_PREP — safe for typical retail-
      // arbitrage resold goods. Once classified, Amazon's prepOwnerConstraint
      // becomes SELLER_ONLY (the seller still applies FNSKU labels even when
      // no other prep is needed), which matches our planItems above.
      console.log('[send] Setting prep classification for', items.length, 'MSKU(s)…');
      try {
        const prepResult = await setPrepDetails(creds, items.map((i) => ({
          msku: i.sku,
          prepCategory: 'NONE',
          prepTypes: ['ITEM_NO_PREP'],
        })));

        // Poll until the prep operation finishes (usually 3-10 seconds)
        const PREP_POLL_MS = 3000;
        const PREP_MAX_ATTEMPTS = 20; // ~60s max
        let prepDone = false;
        for (let attempt = 0; attempt < PREP_MAX_ATTEMPTS; attempt++) {
          await new Promise((r) => setTimeout(r, PREP_POLL_MS));
          const op = await getInboundOperation(creds, prepResult.operationId);
          if (op.operationStatus === 'SUCCESS') {
            prepDone = true;
            console.log(`[send] Prep classification SUCCESS after ${(attempt + 1) * PREP_POLL_MS / 1000}s`);
            break;
          }
          if (op.operationStatus === 'FAILED') {
            console.warn('[send] Prep classification FAILED:', JSON.stringify(op.operationProblems));
            break;
          }
        }
        if (!prepDone) {
          console.warn('[send] Prep classification did not finish within timeout — proceeding anyway');
        }
      } catch (err) {
        console.warn('[send] setPrepDetails failed (non-fatal, continuing):', err);
      }

      let planResult;
      const MAX_RETRIES = 24;
      const RETRY_DELAY_MS = 30_000;
      let lastErr: any = null;
      // Mutable copy: if Amazon tells us specific MSKUs need prepOwner=SELLER,
      // we flip those entries and retry once.
      const itemsForPlan: InboundPlanItem[] = [...planItems];

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          planResult = await createInboundPlan(creds, {
            name: batch.name,
            sourceAddress,
            destinationMarketplaces: [creds.marketplaceId],
            items: itemsForPlan,
          });
          break;
        } catch (err) {
          lastErr = err;
          const errStr = String(err);

          // Case A: MSKU still propagating in Inbound Plans system. Wait + retry.
          // Amazon uses several different error phrasings depending on which
          // service handles the request:
          //   "MSKUs are not available for inbound. Recently added..."
          //   "The following MSKUs are not valid: [...]" (more common for
          //     FBA-channel listings that exist but haven't propagated yet)
          const isPropagationError =
            errStr.includes('not available for inbound') ||
            errStr.includes('recently added, please try again later') ||
            errStr.includes('MSKUs are not valid');

          // Case B: Specific MSKUs have the wrong prepOwner. Amazon returns
          // one of two messages depending on the constraint:
          //   "{MSKU} requires prepOwner but NONE was assigned. Accepted values: [AMAZON, SELLER]"
          //   "{MSKU} does not require prepOwner but SELLER was assigned. Accepted values: [NONE]"
          // Parse both forms and flip the affected MSKUs accordingly. Retry
          // immediately — no delay needed since this is a payload mismatch,
          // not propagation.
          const requiresPrepRegex = /(\S+)\s+requires prepOwner/g;
          const doesNotRequirePrepRegex = /(\S+)\s+does not require prepOwner/g;
          const needsPrep: string[] = [];
          const doesntNeedPrep: string[] = [];
          let m: RegExpExecArray | null;
          while ((m = requiresPrepRegex.exec(errStr)) !== null) needsPrep.push(m[1]);
          while ((m = doesNotRequirePrepRegex.exec(errStr)) !== null) doesntNeedPrep.push(m[1]);

          // doesNotRequirePrepRegex will also match the "requires prepOwner"
          // text, so dedupe — items that DO require prep should NOT also be
          // in the "doesn't require" list.
          const trueDoesntNeed = doesntNeedPrep.filter((s) => !needsPrep.includes(s));

          if (needsPrep.length > 0 || trueDoesntNeed.length > 0) {
            if (needsPrep.length > 0) {
              console.log(`[send] Inbound plan: flipping to SELLER prep: ${needsPrep.join(', ')}`);
            }
            if (trueDoesntNeed.length > 0) {
              console.log(`[send] Inbound plan: flipping to NONE prep: ${trueDoesntNeed.join(', ')}`);
            }
            for (const it of itemsForPlan) {
              if (needsPrep.includes(it.msku)) it.prepOwner = 'SELLER';
              if (trueDoesntNeed.includes(it.msku)) it.prepOwner = 'NONE';
            }
            // Retry immediately — no delay
            continue;
          }

          if (!isPropagationError) {
            return failBatch(batchId, `Inbound plan creation failed: ${err}`);
          }
          if (attempt === MAX_RETRIES - 1) break;
          console.log(`[send] Inbound plan: MSKUs still propagating (attempt ${attempt + 1}/${MAX_RETRIES}), waiting ${RETRY_DELAY_MS / 1000}s…`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }

      if (!planResult) {
        return failBatch(
          batchId,
          `Inbound plan creation failed after ${MAX_RETRIES} retries (~${(MAX_RETRIES * RETRY_DELAY_MS) / 60_000} min). Amazon never registered the MSKUs in the Inbound system. Last error: ${lastErr}`
        );
      }

      // 10. Persist the plan ID and operation ID on the batch
      const db3 = getDb();
      try {
        db3.prepare(`
          UPDATE listing_batches SET
            inbound_plan_id = ?,
            inbound_operation_id = ?,
            plan_status = 'IN_PROGRESS',
            updated_at = ?
          WHERE id = ?
        `).run(planResult.inboundPlanId, planResult.operationId, new Date().toISOString(), batchId);
      } finally {
        db3.close();
      }

      return NextResponse.json({
        success: true,
        channel: 'FBA',
        inboundPlanId: planResult.inboundPlanId,
        operationId: planResult.operationId,
        listings: listingResults,
      });
    }

    // MFN path: no inbound plan. The status endpoint will transition the
    // batch to 'ready' once all listings have gone ACTIVE.
    return NextResponse.json({
      success: true,
      channel: 'MFN',
      listings: listingResults,
    });
  } catch (err) {
    try { db.close(); } catch {}
    return failBatch(batchId, `Unexpected error: ${err}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function saveListingState(
  batchId: number,
  itemId: number,
  state: { listing_status: string; listing_submission_id: string | null; listing_error: string | null }
) {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE listing_batch_items SET
        listing_status = ?,
        listing_submission_id = ?,
        listing_error = ?,
        listing_updated_at = ?
      WHERE id = ? AND batch_id = ?
    `).run(
      state.listing_status,
      state.listing_submission_id,
      state.listing_error,
      new Date().toISOString(),
      itemId,
      batchId
    );
  } finally {
    db.close();
  }
}

/**
 * Classify a listing after a PUT. Channel-aware: FBA and MFN have different
 * "ready" signals because FBA listings without inventory never reach BUYABLE.
 *
 *   FBA: ACTIVE = FNSKU populated + no fatal errors. The listing is FBA-
 *        registered and ready to accept inventory; customers will see it as
 *        BUYABLE only after physical units arrive at the warehouse, which
 *        happens after this batch ships and Amazon receives it.
 *
 *   MFN: ACTIVE = summary.status contains 'BUYABLE'. The seller manages
 *        their own stock so the listing should be live as soon as Amazon
 *        verifies it.
 *
 * We deliberately DO NOT treat issues[].severity === "ERROR" as fatal here.
 * Amazon surfaces catalog-level validation errors (e.g. "child variation
 * needs size attribute") that often don't block the FBA inbound or sale
 * flows — they're displayed as warnings and clear on their own as the
 * catalog catches up.
 */
async function classifyListing(
  creds: any,
  sellerId: string,
  sku: string,
  channel: 'FBA' | 'MFN' = 'FBA'
): Promise<{ status: 'ACTIVE' | 'PROCESSING' | 'FAILED'; error: string | null }> {
  try {
    const listing = await getListing(creds, sellerId, sku);
    if (!listing) {
      // Listing doesn't exist yet (Amazon hasn't fully registered the PUT).
      // Treat as processing.
      return { status: 'PROCESSING', error: null };
    }

    const summary = listing.summaries?.[0];
    const summaryStatus: string[] = summary?.status || [];
    const fnSku: string | undefined = summary?.fnSku;

    // Capture any ERROR-severity issues as informational — displayed to the
    // user but not auto-fatal.
    const issues: any[] = listing.issues || [];
    const errorIssues = issues.filter((i: any) => (i?.severity || '').toUpperCase() === 'ERROR');
    const errorNote = errorIssues.length > 0
      ? errorIssues.map((i: any) => i.message).join('; ')
      : null;

    if (channel === 'FBA') {
      // For FBA, FNSKU presence is the "FBA-registered, ready for inbound"
      // signal. The listing won't be BUYABLE until inventory arrives, but
      // it's ready in every sense the batch flow cares about.
      if (fnSku) {
        return { status: 'ACTIVE', error: errorNote };
      }
      // No fnSku yet AND there are ERROR-severity issues — likely a real
      // attribute problem (missing unit_count, size, etc.) that Amazon won't
      // resolve on its own. Mark as FAILED so we surface it BEFORE attempting
      // the inbound plan. Otherwise createInboundPlan rejects with "MSKUs
      // are not valid" and the user has no clue why.
      if (errorIssues.length > 0) {
        return { status: 'FAILED', error: errorNote };
      }
      return { status: 'PROCESSING', error: errorNote };
    }

    // MFN: BUYABLE is the right signal — seller manages stock so the listing
    // should go live immediately once Amazon validates.
    const isBuyable = summaryStatus.includes('BUYABLE');
    if (isBuyable) {
      return { status: 'ACTIVE', error: errorNote };
    }
    return { status: 'PROCESSING', error: errorNote };
  } catch (err) {
    // On any API error, default to processing and log the error.
    return { status: 'PROCESSING', error: `Could not verify listing status: ${err}` };
  }
}

function failBatch(batchId: number, errorMsg: string): NextResponse {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE listing_batches SET
        status = 'failed',
        send_error = ?,
        updated_at = ?
      WHERE id = ?
    `).run(errorMsg, new Date().toISOString(), batchId);
  } finally {
    db.close();
  }
  return NextResponse.json({ error: errorMsg }, { status: 500 });
}
