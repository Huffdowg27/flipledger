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
import {
  isMerchantShippingGroupIssue,
  makeTemplateRejectedIssue,
} from '@/lib/amazonShippingTemplates';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
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

export interface SellerListing {
  sku: string;
  fnsku: string | null;
  asin: string;
  listingStatus: string;          // ACTIVE | INACTIVE | SUPPRESSED | INCOMPLETE
  fulfillmentChannel: 'FBA' | 'MFN';
  conditionType: string;          // new_new, used_like_new, etc.
  fbaStock: number;               // fulfillable FBA quantity
  listPriceCents: number;
  itemName: string | null;
}

/**
 * List all seller listings that match a given ASIN.
 *
 * Calls GET /listings/2021-08-01/items/{sellerId}?filterASINs={asin}
 * which is documented to filter by ASIN, but the filter is unreliable in
 * practice — Amazon often ignores it and returns an arbitrary page of listings.
 *
 * Defense: we paginate through ALL pages (up to MAX_PAGES), parse each item's
 * summary.asin, and only keep items that actually belong to the requested ASIN.
 * This is slower but correct.
 *
 * NOTE: Because of the filterASINs unreliability, if the seller has many
 * listings (thousands), the matching SKU may be on a later page and could be
 * missed within the page cap. The correct long-term fix is to look up the SKU
 * directly via getListing(sku) once the SKU is known (e.g. from local DB).
 */
export async function getListingsForASIN(
  credentials: SPAPICredentials,
  sellerId: string,
  asin: string,
): Promise<SellerListing[]> {
  const results: SellerListing[] = [];
  let pageToken: string | undefined;
  let pagesScanned = 0;
  const MAX_PAGES = 20; // safety cap against runaway pagination

  do {
    const query: Record<string, string> = {
      marketplaceIds: credentials.marketplaceId,
      filterASINs: asin,        // hint — Amazon may or may not honor this
      includedData: 'summaries,fulfillmentAvailability',
      // NOTE: pageSize is NOT a valid param for this endpoint — Amazon returns 400.
      // Default page size is used; we paginate via nextPageToken instead.
    };
    if (pageToken) query.pageToken = pageToken;

    const data = await spApiRequest(
      credentials,
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
      query,
    );

    const items: any[] = data?.items || [];
    for (const item of items) {
      const summary = item.summaries?.[0];
      if (!summary) continue;

      const itemAsin: string = summary.asin || '';

      // Critical filter: only keep items whose ASIN matches the one we searched.
      // The filterASINs param is not reliably honored by Amazon's API, so we
      // must filter client-side on the asin field in summaries.
      // NOTE: items with no ASIN in their summary must also be excluded — an
      // empty itemAsin is not a match for our target ASIN.
      if (itemAsin !== asin) continue;

      const statusArr: string[] = summary.status || [];
      // Explicit ordering: ACTIVE > DISCOVERABLE > SUPPRESSED > INCOMPLETE > whatever Amazon returns.
      // DISCOVERABLE = OOS FBA listing, still live and replenishable — NOT the same as deleted/inactive.
      const listingStatus = statusArr.includes('ACTIVE') ? 'ACTIVE'
        : statusArr.includes('DISCOVERABLE') ? 'DISCOVERABLE'
        : statusArr.includes('SUPPRESSED') ? 'SUPPRESSED'
        : statusArr.includes('INCOMPLETE') ? 'INCOMPLETE'
        : statusArr.includes('INACTIVE') ? 'INACTIVE'
        : statusArr[0] || 'UNKNOWN';

      const availability = item.fulfillmentAvailability?.[0];
      const channelCode: string = availability?.fulfillmentChannelCode || 'DEFAULT';
      const fulfillmentChannel: 'FBA' | 'MFN' = channelCode === 'AMAZON_NA' || channelCode === 'AMAZON' ? 'FBA' : 'MFN';

      // List price: from the fulfillmentAvailability's price or offers — SP-API
      // doesn't consistently expose price here; we set listPriceCents=0 as
      // fallback and the UI can supplement from live_inventory.
      const fbaStock = (fulfillmentChannel === 'FBA') ? (availability?.quantity ?? 0) : 0;

      results.push({
        sku: item.sku,
        fnsku: summary.fnSku || null,
        asin: itemAsin || asin,
        listingStatus,
        fulfillmentChannel,
        conditionType: summary.conditionType || 'new_new',
        fbaStock,
        listPriceCents: 0,  // enriched below or by caller
        itemName: summary.itemName || null,
      });
    }

    pageToken = data?.nextPageToken;
    pagesScanned++;

    // If we found a match and have scanned enough pages with the filter active, stop early.
    // If filterASINs is NOT working (0 matches so far after 2 pages), keep going to try
    // to find the needle — but cap at MAX_PAGES to avoid excessive API usage.
    if (results.length > 0 && !pageToken) break;
    if (pagesScanned >= MAX_PAGES) break;
  } while (pageToken);

  return results;
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
  merchantShippingGroupName?: string | null;  // display label — messages/logs only
  merchantShippingGroupValue?: string | null; // the ENUM KEY Amazon requires; falls back to name
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

  const shippingTemplateName = params.merchantShippingGroupName?.trim() || null;

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

  if (params.channel === 'MFN' && shippingTemplateName) {
    // Amazon requires the enum KEY (id) here, not the display name (error 90244).
    const shippingTemplateValue = params.merchantShippingGroupValue?.trim() || shippingTemplateName;
    attributes.merchant_shipping_group = [
      { value: shippingTemplateValue, marketplace_id: credentials.marketplaceId },
    ];
  }

  const buildBody = (includeTemplate: boolean) => {
    const bodyAttributes = includeTemplate
      ? attributes
      : Object.fromEntries(
          Object.entries(attributes).filter(([key]) => key !== 'merchant_shipping_group')
        );
    return {
      productType: params.productType,
      requirements: 'LISTING_OFFER_ONLY',
      attributes: bodyAttributes,
    };
  };

  const url = new URL(
    `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(params.sku)}`
  );
  url.searchParams.set('marketplaceIds', credentials.marketplaceId);

  async function send(includeTemplate: boolean): Promise<CreateListingResult> {
    const response = await fetch(url.toString(), {
      method: 'PUT',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildBody(includeTemplate)),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const err = new Error(`SP-API Listings Items ${response.status} on ${params.sku}: ${errorBody}`);
      (err as Error & { templateIssue?: boolean }).templateIssue =
        includeTemplate && isMerchantShippingGroupIssue({ message: errorBody });
      throw err;
    }

    const data = await response.json();

    return {
      sku: data.sku || params.sku,
      status: data.status || 'ACCEPTED',
      submissionId: data.submissionId || null,
      issues: data.issues || [],
    };
  }

  if (!shippingTemplateName || params.channel !== 'MFN') return send(false);

  // Fail closed on template rejection: never retry without the template. A
  // live offer with the wrong shipping template charges the wrong shipping —
  // the row stays INVALID with an actionable issue instead.
  let firstResult: CreateListingResult;
  try {
    firstResult = await send(true);
  } catch (err) {
    if (!(err as Error & { templateIssue?: boolean }).templateIssue) throw err;
    return {
      sku: params.sku,
      status: 'INVALID',
      submissionId: null,
      issues: [makeTemplateRejectedIssue(shippingTemplateName)],
    };
  }

  const rejectedTemplateOnly =
    firstResult.status === 'INVALID'
    && firstResult.issues.length > 0
    && firstResult.issues.every(isMerchantShippingGroupIssue);

  if (!rejectedTemplateOnly) return firstResult;

  return {
    ...firstResult,
    issues: [...firstResult.issues, makeTemplateRejectedIssue(shippingTemplateName)],
  };
}
