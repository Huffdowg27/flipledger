/**
 * SP-API Listings Items 2021-08-01 client.
 *
 * Used by Phase 2 "Send to Amazon" to create offer-only listings against
 * existing ASINs. For resellers doing retail arbitrage, this is all they need:
 * attach to an existing Amazon catalog entry with a condition, quantity, and price.
 *
 * Docs: https://developer-docs.amazon.com/sp-api/docs/listings-items-api-v2021-08-01-reference
 */
import Database from 'better-sqlite3';
import path from 'path';
import { getAccessToken, getEndpoint, spApiRequest } from './auth';
import type { SPAPICredentials } from './types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Return the Amazon seller ID (a.k.a. "Merchant Token") for the current account.
 *
 * SP-API does not expose the seller ID directly via `/sellers/v1/marketplaceParticipations`
 * or `/sellers/v1/account` — those endpoints return marketplace and business info
 * but not the merchant token itself. However, Amazon creates an internal
 * "Invoicing Shadow Marketplace" participation whose `storeName` has the form
 * `Invoicing_{accountId}_{sellerId}`, so we can extract the seller ID by
 * parsing that field. Validated against Amazon's Listings Items API.
 *
 * Result is cached in `settings.amazon_seller_id` so subsequent calls skip
 * the network hop.
 */
export async function getSellerId(credentials: SPAPICredentials): Promise<string> {
  // 1. Cache hit
  const db = getDb();
  try {
    const cached = db.prepare("SELECT value FROM settings WHERE key = 'amazon_seller_id'").get() as { value: string } | undefined;
    if (cached?.value) return cached.value;
  } finally {
    db.close();
  }

  // 2. Extract from marketplaceParticipations → Invoicing Shadow Marketplace storeName
  let sellerId: string | undefined;
  try {
    const response = await spApiRequest(credentials, '/sellers/v1/marketplaceParticipations');
    const list: any[] = response?.payload || response || [];
    // Find the "Invoicing Shadow Marketplace" entry — its storeName encodes the seller ID.
    // Pattern: Invoicing_{accountId}_{sellerId} — we want the last underscore-delimited segment.
    const invoicing = list.find((p: any) =>
      typeof p?.storeName === 'string' && p.storeName.startsWith('Invoicing_')
    );
    if (invoicing?.storeName) {
      const parts = invoicing.storeName.split('_');
      const candidate = parts[parts.length - 1];
      // Seller IDs are typically 13-14 chars, start with A, alphanumeric
      if (/^[A-Z0-9]{10,16}$/.test(candidate)) {
        sellerId = candidate;
      }
    }
  } catch (err) {
    // fall through to error below
    console.warn('[getSellerId] marketplaceParticipations fetch failed:', err);
  }

  if (!sellerId) {
    throw new Error(
      'Could not determine Amazon seller ID. ' +
      'SP-API does not expose the merchant token directly — FlipLedger tries to ' +
      'extract it from the "Invoicing Shadow Marketplace" entry in marketplaceParticipations, ' +
      'but that entry was not found. ' +
      'Workaround: find your Merchant Token in Seller Central → Settings → Account Info → Business Information, ' +
      "and save it to settings.amazon_seller_id manually."
    );
  }

  // 3. Cache it
  const db2 = getDb();
  try {
    db2.prepare(`
      INSERT OR REPLACE INTO settings (key, value) VALUES ('amazon_seller_id', ?)
    `).run(sellerId);
  } finally {
    db2.close();
  }

  return sellerId;
}

/**
 * Get the current state of a listing for a given SKU.
 * Returns null if the listing does not exist yet (404).
 */
export async function getListing(
  credentials: SPAPICredentials,
  sellerId: string,
  sku: string
): Promise<any | null> {
  try {
    const data = await spApiRequest(
      credentials,
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
      {
        marketplaceIds: credentials.marketplaceId,
        includedData: 'summaries,offers,fulfillmentAvailability,issues',
      }
    );
    return data;
  } catch (err: any) {
    if (String(err).includes('404')) return null;
    throw err;
  }
}

/**
 * Look up the canonical Amazon productType for an ASIN from the Catalog API.
 * Returns something like 'HEADPHONES', 'VIDEO_GAMES', 'TOY', 'PRODUCT' (the universal fallback).
 */
export async function getProductType(
  credentials: SPAPICredentials,
  asin: string
): Promise<string> {
  try {
    const data = await spApiRequest(
      credentials,
      `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`,
      {
        marketplaceIds: credentials.marketplaceId,
        includedData: 'productTypes',
      }
    );
    const pt = data?.productTypes?.[0]?.productType;
    if (pt && typeof pt === 'string') return pt;
  } catch {
    // ignore
  }
  return 'PRODUCT';
}

/** Map internal condition values to SP-API's expected condition_type values. */
const CONDITION_MAP: Record<string, string> = {
  NewItem: 'new_new',
  UsedLikeNew: 'used_like_new',
  UsedVeryGood: 'used_very_good',
  UsedGood: 'used_good',
  UsedAcceptable: 'used_acceptable',
  CollectibleLikeNew: 'collectible_like_new',
  CollectibleVeryGood: 'collectible_very_good',
  CollectibleGood: 'collectible_good',
  CollectibleAcceptable: 'collectible_acceptable',
};

export interface CreateListingParams {
  sku: string;                 // seller's MSKU
  asin: string;                // ASIN to attach to
  condition: string;           // internal name, e.g. 'NewItem'
  quantity: number;
  listPriceCents: number;
  channel: 'FBA' | 'MFN';
  productType: string;         // from getProductType
}

export interface CreateListingResult {
  sku: string;
  status: 'ACCEPTED' | 'INVALID' | 'VALID';
  submissionId: string | null;
  issues: any[];
}

/**
 * Create or update a listing using requirements=LISTING_OFFER_ONLY.
 * This is the minimal "reseller offer on an existing ASIN" path — no need to
 * provide product attributes since Amazon already has the catalog entry.
 *
 * PUT /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=X
 */
export async function createOrUpdateListing(
  credentials: SPAPICredentials,
  sellerId: string,
  params: CreateListingParams
): Promise<CreateListingResult> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const conditionType = CONDITION_MAP[params.condition] || 'new_new';
  const priceDollars = (params.listPriceCents / 100).toFixed(2);

  const fulfillmentChannelCode = params.channel === 'FBA' ? 'AMAZON_NA' : 'DEFAULT';

  // CRITICAL: purchasable_offer REQUIRES a top-level start_at (the effective
  // date of the offer). Without it, Amazon silently accepts the PUT but
  // doesn't promote the offer to BUYABLE — the listing stays stuck in
  // DISCOVERABLE-only status forever, with zero issues reported. This was
  // verified by diff'ing a working SC-fixed listing vs a stuck FlipLedger
  // submission: the only meaningful difference was start_at/end_at.
  const nowIso = new Date().toISOString();

  const attributes: any = {
    condition_type: [
      { value: conditionType, marketplace_id: credentials.marketplaceId },
    ],
    merchant_suggested_asin: [
      { value: params.asin, marketplace_id: credentials.marketplaceId },
    ],
    // For FBA listings: do NOT pass `quantity` — Amazon rejects it with
    // ATTRIBUTE_SUPPRESSED on issue 12998 ("fulfillment channel does not
    // support the provided inventory type"), which silently strips the entire
    // fulfillment_availability attribute. FBA quantity is managed by physical
    // warehouse inventory, NOT by the listing.
    //
    // For MFN: quantity IS required so Amazon knows how many units the seller
    // can ship. Without it the listing won't show stock.
    fulfillment_availability: params.channel === 'FBA'
      ? [
          { fulfillment_channel_code: fulfillmentChannelCode },
        ]
      : [
          { fulfillment_channel_code: fulfillmentChannelCode, quantity: params.quantity },
        ],
    purchasable_offer: [
      {
        currency: 'USD',
        marketplace_id: credentials.marketplaceId,
        audience: 'ALL',
        // Offer effective date — required for BUYABLE transition.
        start_at: { value: nowIso },
        our_price: [
          {
            schedule: [{ value_with_tax: parseFloat(priceDollars) }],
          },
        ],
      },
    ],
    // Compliance attributes that Amazon requires even on LISTING_OFFER_ONLY
    // submissions for many product types (toys, electronics, board games, etc.).
    // Without these, the PUT returns status: "INVALID" with code 90220 and the
    // listing never goes live. Defaults are safe for typical retail-arbitrage
    // resold goods — if an item actually contains a battery or is hazmat, the
    // seller would need to override (extension point: per-batch overrides).
    batteries_required: [
      { value: false, marketplace_id: credentials.marketplaceId },
    ],
    supplier_declared_dg_hz_regulation: [
      { value: 'not_applicable', marketplace_id: credentials.marketplaceId },
    ],
    // item_package_quantity: declares the listing as "1 sellable unit per
    // package." Most arbitrage products are 1 unit per box. Without this,
    // some catalog entries (especially multi-figure sets or assortment packs)
    // hit a Unit Count validation issue that blocks FNSKU generation. Sending
    // 1 here unblocks them; for genuine multi-packs (where each "unit" Amazon
    // tracks contains multiple pieces), the seller can override later.
    item_package_quantity: [
      { value: 1, marketplace_id: credentials.marketplaceId },
    ],
    // CRITICAL: skip_offer must be FALSE for the offer to actually attach.
    // Without this, Amazon stores the catalog entry + purchasable_offer
    // attribute but SKIPS aggregating an offer — Seller Central shows
    // "Missing Offer" and the offers[] array stays empty. No offer means no
    // FNSKU generated, which means the Inbound Plans API won't recognize the
    // MSKU and createInboundPlan returns "MSKUs are not available for inbound."
    //
    // Verified by diff'ing a working pre-existing listing (1071023350) against
    // a stuck FlipLedger listing — skip_offer was the only meaningful
    // difference. Setting it to false → FNSKU generated within 10s → inbound
    // plan succeeded immediately.
    skip_offer: [
      { value: false, marketplace_id: credentials.marketplaceId },
    ],
  };

  const body = {
    productType: params.productType,
    requirements: 'LISTING_OFFER_ONLY',
    attributes,
  };

  const url = new URL(
    `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(params.sku)}`
  );
  url.searchParams.set('marketplaceIds', credentials.marketplaceId);

  const response = await fetch(url.toString(), {
    method: 'PUT',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API Listings Items ${response.status} on ${params.sku}: ${errorBody}`);
  }

  const data = await response.json();

  return {
    sku: data.sku || params.sku,
    status: data.status || 'ACCEPTED',
    submissionId: data.submissionId || null,
    issues: data.issues || [],
  };
}
