/**
 * GET /api/list/catalog/existing-skus?asin=B0CJCM4LV4
 *
 * Returns all seller MSKUs that are currently listed against this ASIN in
 * Seller Central. Used by the Find-It / Add-to-Batch flow to detect existing
 * replenishment candidates before creating a new MSKU.
 *
 * Source hierarchy:
 *   AMAZON_INVENTORY — live from SP-API Listings Items (source of truth for
 *     replenishment). Includes ACTIVE, DISCOVERABLE, SUPPRESSED, INCOMPLETE,
 *     INACTIVE statuses. DISCOVERABLE = out-of-stock but still a valid live
 *     listing (Amazon's status for OOS FBA SKUs). Replenishable.
 *   LOCAL_DB — cached from last FBA inventory sync (live_inventory table).
 *     Only shown when SP-API returned zero results, with a clear warning.
 *     Not selectable for replenishment without confirming against SP-API.
 *
 * Only AMAZON_INVENTORY rows may be selected for replenishment. LOCAL_DB rows
 * are shown as historical context only and clearly labelled as such.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { getSellerId, getListingsForASIN, getListing } from '@/lib/sp-api/listingsItems';
import { getInventorySummariesForASIN } from '@/lib/sp-api/inventory';
import type { SPAPICredentials } from '@/lib/sp-api/types';

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

export async function GET(request: NextRequest) {
  const asin = request.nextUrl.searchParams.get('asin')?.trim().toUpperCase();
  if (!asin || !/^B[0-9A-Z]{9}$/.test(asin)) {
    return NextResponse.json({ error: 'Invalid or missing ASIN' }, { status: 400 });
  }

  console.log(`[existing-skus] asin: ${asin}`);

  const db = getDb();
  try {
    // Local sources for ASIN → SKU mapping. Widest coverage possible.
    // live_inventory: FBA inventory sync (most reliable, has list_price)
    // inventory_ledger: COGS import from IL — covers SKUs that were bought but
    //   may not yet have FBA inventory (e.g. OOS/DISCOVERABLE listings)
    const localRows = db.prepare(`
      SELECT sku, fulfillable_qty, list_price, last_updated
      FROM live_inventory
      WHERE asin = ? AND marketplace = 'amazon'
      UNION
      SELECT DISTINCT il.sku,
        0 AS fulfillable_qty,
        0 AS list_price,
        il.date_purchased AS last_updated
      FROM inventory_ledger il
      WHERE il.asin = ?
        AND il.sku IS NOT NULL AND il.sku != ''
        AND NOT EXISTS (
          SELECT 1 FROM live_inventory li
          WHERE li.sku = il.sku AND li.asin = il.asin AND li.marketplace = 'amazon'
        )
      ORDER BY fulfillable_qty DESC
    `).all(asin, asin) as { sku: string; fulfillable_qty: number; list_price: number; last_updated: string }[];

    const localBySkuMap = new Map(localRows.map((r) => [r.sku, r]));

    // merchant_listings carries authoritative list price for MFN SKUs.
    // live_inventory.list_price is FBA-only, so MFN rows would otherwise
    // show no price. Preferred for MFN; FBA continues to read from local.
    const merchantRows = db.prepare(`
      SELECT sku, status, list_price_cents
      FROM merchant_listings
      WHERE asin = ? AND marketplace = 'amazon'
    `).all(asin) as { sku: string; status: string | null; list_price_cents: number | null }[];
    const merchantBySkuMap = new Map(merchantRows.map((r) => [r.sku, r]));

    // Pick the list price for a row by channel: prefer merchant_listings for
    // MFN, fall back to live_inventory for FBA (and as a last resort for MFN).
    const pickListPriceCents = (sku: string, channel: 'FBA' | 'MFN'): number => {
      if (channel === 'MFN') {
        const m = merchantBySkuMap.get(sku);
        if (m?.list_price_cents != null && m.list_price_cents > 0) return m.list_price_cents;
      }
      return localBySkuMap.get(sku)?.list_price ?? 0;
    };

    const creds = getAmazonCredentials(db);
    db.close();

    if (!creds) {
      // No credentials — return local-only data with a clear warning.
      console.log(`[existing-skus] amazonInventoryEndpoint: SKIPPED (no credentials)`);
      console.log(`[existing-skus] amazonRawCount: 0`);
      console.log(`[existing-skus] amazonSkus: []`);
      console.log(`[existing-skus] localFallbackCount: ${localRows.length}`);
      console.log(`[existing-skus] localFallbackSkus: ${JSON.stringify(localRows.map(r => r.sku))}`);

      const fallbackSkus = localRows.map((r) => ({
        sku: r.sku,
        fnsku: null,
        listingStatus: 'UNKNOWN',
        fulfillmentChannel: 'FBA' as const,
        conditionType: 'new_new',
        fbaStock: r.fulfillable_qty,
        listPriceCents: r.list_price || 0,
        itemName: null,
        source: 'LOCAL_DB' as const,
        lastSynced: r.last_updated,
      }));
      console.log(`[existing-skus] renderedRowsWithSource: ${JSON.stringify(fallbackSkus.map(s => ({ sku: s.sku, source: s.source, status: s.listingStatus })))}`);
      return NextResponse.json({
        asin,
        skus: fallbackSkus,
        warning: 'Amazon credentials not configured — showing cached FBA inventory only. These are LOCAL_DB entries, not live Seller Central data.',
      });
    }

    // Live data from SP-API Listings Items — source of truth.
    let sellerId: string;
    const endpoint = `/listings/2021-08-01/items/{sellerId}?filterASINs=${asin}`;
    console.log(`[existing-skus] amazonInventoryEndpoint: ${endpoint}`);

    try {
      sellerId = await getSellerId(creds);
    } catch (err) {
      // Can't resolve seller ID — return local data with a clear error, no silent fallback.
      console.log(`[existing-skus] amazonRawCount: 0 (getSellerId failed: ${err})`);
      console.log(`[existing-skus] amazonSkus: []`);
      console.log(`[existing-skus] localFallbackCount: ${localRows.length}`);
      console.log(`[existing-skus] localFallbackSkus: ${JSON.stringify(localRows.map(r => r.sku))}`);

      const fallbackSkus = localRows.map((r) => ({
        sku: r.sku,
        fnsku: null,
        listingStatus: 'UNKNOWN',
        fulfillmentChannel: 'FBA' as const,
        conditionType: 'new_new',
        fbaStock: r.fulfillable_qty,
        listPriceCents: r.list_price || 0,
        itemName: null,
        source: 'LOCAL_DB' as const,
        lastSynced: r.last_updated,
      }));
      console.log(`[existing-skus] renderedRowsWithSource: ${JSON.stringify(fallbackSkus.map(s => ({ sku: s.sku, source: s.source, status: s.listingStatus })))}`);
      return NextResponse.json({
        asin,
        skus: fallbackSkus,
        error: `Could not resolve seller ID: ${err}`,
        warning: 'SP-API seller ID lookup failed — showing cached FBA inventory only (LOCAL_DB). These may not reflect current Seller Central state.',
      });
    }

    const apiListings = await getListingsForASIN(creds, sellerId, asin);

    console.log(`[existing-skus] amazonRawCount: ${apiListings.length}`);
    console.log(`[existing-skus] amazonSkus: ${JSON.stringify(apiListings.map(l => ({ sku: l.sku, status: l.listingStatus, channel: l.fulfillmentChannel, fnsku: l.fnsku })))}`);
    console.log(`[existing-skus] localFallbackCount: ${localRows.length}`);
    console.log(`[existing-skus] localFallbackSkus: ${JSON.stringify(localRows.map(r => r.sku))}`);

    type SkuRow = {
      sku: string; fnsku: string | null; asin: string; listingStatus: string;
      fulfillmentChannel: 'FBA' | 'MFN'; conditionType: string; fbaStock: number;
      listPriceCents: number; itemName: string | null;
      source: 'AMAZON_INVENTORY' | 'LOCAL_DB'; lastSynced: string;
    };

    if (apiListings.length > 0) {
      // SP-API returned results — these are the authoritative Seller Central MSKUs.
      // Enrich list_price from local snapshot if available; local DB is NOT mixed in
      // as a replenishable source since SP-API is the ground truth.
      const amazonSkus: SkuRow[] = apiListings.map((l) => {
        const local = localBySkuMap.get(l.sku);
        return {
          sku: l.sku,
          fnsku: l.fnsku,
          asin: l.asin,
          listingStatus: l.listingStatus,
          fulfillmentChannel: l.fulfillmentChannel,
          conditionType: l.conditionType,
          // Use SP-API stock if available; fall back to local snapshot.
          fbaStock: l.fbaStock > 0 ? l.fbaStock : (local?.fulfillable_qty ?? 0),
          // MFN price comes from merchant_listings; FBA from live_inventory cache.
          listPriceCents: pickListPriceCents(l.sku, l.fulfillmentChannel),
          itemName: l.itemName,
          source: 'AMAZON_INVENTORY' as const,
          lastSynced: new Date().toISOString(),
        };
      });

      // Sort: ACTIVE FBA first, then DISCOVERABLE FBA (out-of-stock but replenishable),
      // then other statuses, then by FBA stock descending.
      const statusRank = (s: string) =>
        s === 'ACTIVE' ? 0 : s === 'DISCOVERABLE' ? 1 : s === 'SUPPRESSED' ? 2 : s === 'INCOMPLETE' ? 3 : 4;
      amazonSkus.sort((a, b) => {
        const rankA = statusRank(a.listingStatus);
        const rankB = statusRank(b.listingStatus);
        if (rankA !== rankB) return rankA - rankB;
        if (a.fulfillmentChannel === 'FBA' && b.fulfillmentChannel !== 'FBA') return -1;
        if (b.fulfillmentChannel === 'FBA' && a.fulfillmentChannel !== 'FBA') return 1;
        return b.fbaStock - a.fbaStock;
      });

      console.log(`[existing-skus] renderedRowsWithSource: ${JSON.stringify(amazonSkus.map(s => ({ sku: s.sku, source: s.source, status: s.listingStatus, channel: s.fulfillmentChannel })))}`);
      return NextResponse.json({ asin, skus: amazonSkus });
    }

    // Listings Items filterASINs is unreliable — Amazon often ignores it.
    // Phase A: FBA Inventory Summaries with filterASINs. More reliable for
    // ASIN lookups; includes DISCOVERABLE/OOS items with qty=0.
    console.log(`[existing-skus] listingsItems filterASINs returned 0 — trying FBA inventory summaries for ${asin}`);
    let fbaInventorySkus: SkuRow[] = [];
    try {
      const fbaSummaries = await getInventorySummariesForASIN(creds, asin);
      console.log(`[existing-skus] fbaInventorySummaries count: ${fbaSummaries.length}, skus: ${JSON.stringify(fbaSummaries.map(s => s.sellerSku))}`);

      if (fbaSummaries.length > 0) {
        // For each SKU found via FBA inventory, get full listing status from Listings Items.
        for (const inv of fbaSummaries) {
          try {
            const listing = await getListing(creds, sellerId, inv.sellerSku);
            const summary = listing?.summaries?.[0] || listing?.summary || {};
            const statusArr: string[] = summary.status || [];
            const listingStatus = statusArr.includes('ACTIVE') ? 'ACTIVE'
              : statusArr.includes('DISCOVERABLE') ? 'DISCOVERABLE'
              : statusArr.includes('SUPPRESSED') ? 'SUPPRESSED'
              : statusArr.includes('INCOMPLETE') ? 'INCOMPLETE'
              : statusArr.includes('INACTIVE') ? 'INACTIVE'
              : statusArr[0] || 'DISCOVERABLE'; // FBA inventory implies at least DISCOVERABLE
            const fnsku = summary.fnSku || inv.fnSku || null;
            console.log(`[existing-skus] fbaInventory ${inv.sellerSku}: status=${listingStatus} fnsku=${fnsku} fulfillable=${inv.fulfillableQty}`);
            fbaInventorySkus.push({
              sku: inv.sellerSku,
              fnsku,
              asin,
              listingStatus,
              fulfillmentChannel: 'FBA',
              conditionType: summary.conditionType || 'new_new',
              fbaStock: inv.fulfillableQty,
              listPriceCents: pickListPriceCents(inv.sellerSku, 'FBA'),
              itemName: inv.productName || summary.itemName || null,
              source: 'AMAZON_INVENTORY' as const,
              lastSynced: new Date().toISOString(),
            });
          } catch (err) {
            console.log(`[existing-skus] getListing for ${inv.sellerSku}: error — ${err}`);
            // Include with minimal data from FBA inventory — still AMAZON_INVENTORY.
            fbaInventorySkus.push({
              sku: inv.sellerSku,
              fnsku: inv.fnSku || null,
              asin,
              listingStatus: 'DISCOVERABLE',
              fulfillmentChannel: 'FBA',
              conditionType: 'new_new',
              fbaStock: inv.fulfillableQty,
              listPriceCents: pickListPriceCents(inv.sellerSku, 'FBA'),
              itemName: inv.productName || null,
              source: 'AMAZON_INVENTORY' as const,
              lastSynced: new Date().toISOString(),
            });
          }
        }
      }
    } catch (err) {
      console.log(`[existing-skus] fbaInventorySummaries error: ${err}`);
    }

    if (fbaInventorySkus.length > 0) {
      console.log(`[existing-skus] renderedRowsWithSource: ${JSON.stringify(fbaInventorySkus.map(s => ({ sku: s.sku, source: s.source, status: s.listingStatus, channel: s.fulfillmentChannel })))}`);
      return NextResponse.json({ asin, skus: fbaInventorySkus });
    }

    // Phase B: For local SKUs not found via FBA inventory, look them up
    // individually via Listings Items API — a direct SKU lookup is reliable.
    console.log(`[existing-skus] fbaInventory returned 0 — attempting direct Listings lookups for ${localRows.length} local SKUs`);
    const directLookupResults: SkuRow[] = [];
    for (const r of localRows) {
      try {
        const listing = await getListing(creds, sellerId, r.sku);
        if (!listing) {
          console.log(`[existing-skus] direct lookup ${r.sku}: 404 — not in Seller Central`);
          continue;
        }
        const summary = listing.summaries?.[0] || listing.summary || {};
        const statusArr: string[] = summary.status || [];
        const listingStatus = statusArr.includes('ACTIVE') ? 'ACTIVE'
          : statusArr.includes('DISCOVERABLE') ? 'DISCOVERABLE'
          : statusArr.includes('SUPPRESSED') ? 'SUPPRESSED'
          : statusArr.includes('INCOMPLETE') ? 'INCOMPLETE'
          : statusArr.includes('INACTIVE') ? 'INACTIVE'
          : statusArr[0] || 'UNKNOWN';
        const availability = (listing.fulfillmentAvailability || [])[0];
        const channelCode: string = availability?.fulfillmentChannelCode || 'DEFAULT';
        const fulfillmentChannel: 'FBA' | 'MFN' = channelCode === 'AMAZON_NA' || channelCode === 'AMAZON' ? 'FBA' : 'MFN';
        const fbaStock = fulfillmentChannel === 'FBA' ? (availability?.quantity ?? r.fulfillable_qty) : 0;
        console.log(`[existing-skus] direct lookup ${r.sku}: found — status=${listingStatus} channel=${fulfillmentChannel} stock=${fbaStock}`);
        directLookupResults.push({
          sku: r.sku,
          fnsku: summary.fnSku || null,
          asin,
          listingStatus,
          fulfillmentChannel,
          conditionType: summary.conditionType || 'new_new',
          fbaStock,
          listPriceCents: pickListPriceCents(r.sku, fulfillmentChannel),
          itemName: summary.itemName || null,
          source: 'AMAZON_INVENTORY' as const,
          lastSynced: new Date().toISOString(),
        });
      } catch (err) {
        console.log(`[existing-skus] direct lookup ${r.sku}: error — ${err}`);
      }
    }

    if (directLookupResults.length > 0) {
      console.log(`[existing-skus] renderedRowsWithSource: ${JSON.stringify(directLookupResults.map(s => ({ sku: s.sku, source: s.source, status: s.listingStatus, channel: s.fulfillmentChannel })))}`);
      return NextResponse.json({ asin, skus: directLookupResults });
    }

    // Still nothing confirmed. Show local rows clearly labelled LOCAL_DB with a
    // warning so the user knows these are NOT confirmed live Seller Central data.
    const localFallbackSkus: SkuRow[] = localRows.map((r) => ({
      sku: r.sku,
      fnsku: null,
      asin,
      listingStatus: 'UNKNOWN',
      fulfillmentChannel: 'FBA',
      conditionType: 'new_new',
      fbaStock: r.fulfillable_qty,
      listPriceCents: r.list_price || 0,
      itemName: null,
      source: 'LOCAL_DB' as const,
      lastSynced: r.last_updated,
    }));

    console.log(`[existing-skus] renderedRowsWithSource: ${JSON.stringify(localFallbackSkus.map(s => ({ sku: s.sku, source: s.source, status: s.listingStatus })))}`);

    if (localFallbackSkus.length > 0) {
      return NextResponse.json({
        asin,
        skus: localFallbackSkus,
        warning: 'SP-API returned 0 listings for this ASIN and direct SKU lookups also returned nothing. Showing cached FBA inventory (LOCAL_DB) — these are NOT confirmed live in Seller Central.',
      });
    }

    // Truly nothing found anywhere.
    return NextResponse.json({ asin, skus: [] });
  } catch (err) {
    try { db.close(); } catch {}
    console.error(`[existing-skus] ERROR for asin ${asin}:`, err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
