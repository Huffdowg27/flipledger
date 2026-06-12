/**
 * SP-API Fulfillment Inbound v2024-03-20 client.
 *
 * Phase 2 of the FlipLedger listing tool uses this to create real Amazon
 * inbound shipment plans from a FlipLedger batch.
 *
 * Docs: https://developer-docs.amazon.com/sp-api/docs/fulfillment-inbound-api-v2024-03-20-reference
 */
import { getAccessToken, getEndpoint, spApiRequest } from './auth';
import type { SPAPICredentials } from './types';

export interface SourceAddress {
  name: string;
  companyName?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateOrProvinceCode: string;
  postalCode: string;
  countryCode: string;
  phoneNumber: string;
  email?: string;
}

export interface InboundPlanItem {
  msku: string;          // seller's MSKU that must already exist as a listing
  quantity: number;
  // prepOwner: 'NONE' if no prep needed (most arbitrage items), 'SELLER' if you'll
  // prep before shipping (poly-bag, bubble-wrap, etc.), 'AMAZON' if Amazon should
  // prep on your behalf (charges fee). Defaults to 'NONE' in createInboundPlan.
  prepOwner?: 'NONE' | 'SELLER' | 'AMAZON';
  labelOwner?: 'SELLER' | 'AMAZON' | 'NONE';
  expiration?: string;   // yyyy-MM-dd, for items with expirations
}

export interface CreateInboundPlanParams {
  name: string;
  sourceAddress: SourceAddress;
  destinationMarketplaces: string[];
  items: InboundPlanItem[];
}

export interface CreateInboundPlanResult {
  inboundPlanId: string;
  operationId: string;
}

/**
 * Create an inbound plan. Returns an inboundPlanId plus the operation that
 * Amazon uses to track async plan creation — you must poll getOperation() until
 * the operation status is SUCCESS before the plan can be used for packing.
 *
 * POST /inbound/fba/2024-03-20/inboundPlans
 */
export async function createInboundPlan(
  credentials: SPAPICredentials,
  params: CreateInboundPlanParams
): Promise<CreateInboundPlanResult> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  // Default prepOwner to 'NONE' (most items don't need prep). If Amazon
  // rejects with "{MSKU} requires prepOwner" for items that DO need prep
  // (poly bagging for soft toys, bubble wrap for fragile, etc.), we'd need
  // to call Amazon's prep guidance API per-ASIN to decide. For now: pass
  // NONE by default; pass SELLER only when the caller explicitly requests it.
  //
  // Sending prepOwner='SELLER' for items that don't need prep returns:
  //   "{MSKU} does not require prepOwner but SELLER was assigned. Accepted values: [NONE]"
  const body: any = {
    name: params.name,
    sourceAddress: params.sourceAddress,
    destinationMarketplaces: params.destinationMarketplaces,
    items: params.items.map((i) => ({
      msku: i.msku,
      quantity: i.quantity,
      prepOwner: i.prepOwner || 'NONE',
      labelOwner: i.labelOwner || 'SELLER',
      ...(i.expiration ? { expiration: i.expiration } : {}),
    })),
  };

  const response = await fetch(`${endpoint}/inbound/fba/2024-03-20/inboundPlans`, {
    method: 'POST',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API createInboundPlan ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  if (!data?.inboundPlanId || !data?.operationId) {
    throw new Error(`createInboundPlan: unexpected response shape: ${JSON.stringify(data)}`);
  }

  return { inboundPlanId: data.inboundPlanId, operationId: data.operationId };
}

// ─── Prep Details (per-MSKU, account-level — not plan-level) ─────────────
//
// Each MSKU must have a "prep classification" registered before any inbound
// plan involving it can complete. This is a one-time per-MSKU registration
// at the seller account level, NOT something specific to a single plan.
//
// Without this, createInboundPlan succeeds and returns an inboundPlanId, but
// the async operation that processes the plan FAILS with code FBA_INB_0182:
//   "Prep classification for this SKU was missing. Choose the prep category
//    that applies to this SKU and apply any required prep and labeling to
//    each sellable unit."
//
// Categories: NONE (no prep needed — most arbitrage items), ADULT, BABY,
// FC_PROVIDED, FRAGILE, GRANULAR, HANGER, LIQUID, PERFORATED, SET, SHARP,
// SMALL, TEXTILE, UNKNOWN.
//
// PrepInstructions (the actual prep types): None, Labeling, Polybagging,
// Bubblewrapping, Taping, BlackShrinkwrapping, Boxing, Sealing, RemoveFromHanger.
//
// Default: NONE category + None instruction = no prep needed. Safe for the
// vast majority of resold consumer goods.

export interface MskuPrepDetail {
  msku: string;
  prepCategory?: string;          // default 'NONE'
  prepTypes?: string[];           // default ['ITEM_NO_PREP_NEEDED']
}

/**
 * POST /inbound/fba/2024-03-20/items/prepDetails
 *
 * Set prep classification for one or more MSKUs at the account level.
 * Async — returns an operationId; poll getInboundOperation() until SUCCESS.
 *
 * NOTE: this endpoint is POST, not PUT — sending PUT returns 403 Unauthorized
 * even though the seller has full inbound role permissions. Verified
 * empirically against the live API.
 *
 * Valid prepCategory values: NONE, ADULT, BABY, FC_PROVIDED, FRAGILE,
 *   GRANULAR, HANGER, LIQUID, PERFORATED, SET, SHARP, SMALL, TEXTILE, UNKNOWN.
 * Valid prepType values: ITEM_NO_PREP, ITEM_LABELING, ITEM_POLYBAGGING,
 *   ITEM_BUBBLEWRAPPING, ITEM_TAPING, ITEM_BLACKSHRINKWRAPPING, ITEM_BOXING,
 *   ITEM_SETCREATION, ITEM_SETSTKR, ITEM_REMOVEHANG.
 *
 * Default category 'NONE' + type 'ITEM_NO_PREP' is safe for typical
 * retail-arbitrage resold goods. Items that actually need prep (poly bagging
 * for soft toys, bubble wrap for fragile, etc.) should be passed explicitly.
 */
export async function setPrepDetails(
  credentials: SPAPICredentials,
  details: MskuPrepDetail[]
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const body = {
    marketplaceId: credentials.marketplaceId,
    mskuPrepDetails: details.map((d) => ({
      msku: d.msku,
      prepCategory: d.prepCategory || 'NONE',
      prepTypes: d.prepTypes && d.prepTypes.length > 0
        ? d.prepTypes
        : ['ITEM_NO_PREP'],
    })),
  };

  const response = await fetch(`${endpoint}/inbound/fba/2024-03-20/items/prepDetails`, {
    method: 'POST',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API setPrepDetails ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  if (!data?.operationId) {
    throw new Error(`setPrepDetails: missing operationId in response: ${JSON.stringify(data)}`);
  }
  return { operationId: data.operationId };
}

/**
 * Get an existing inbound plan (read-only).
 * Useful for surfacing the current state back to the user after a plan is created.
 *
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}
 */
export async function getInboundPlan(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<any> {
  return spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}`
  );
}

export interface OperationStatus {
  operationId: string;
  operationStatus: 'IN_PROGRESS' | 'SUCCESS' | 'FAILED';
  operationProblems: any[];
}

/**
 * Poll the status of an async inbound operation.
 * GET /inbound/fba/2024-03-20/operations/{operationId}
 */
export async function getInboundOperation(
  credentials: SPAPICredentials,
  operationId: string
): Promise<OperationStatus> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/operations/${encodeURIComponent(operationId)}`
  );
  return {
    operationId: data.operationId || operationId,
    operationStatus: data.operationStatus || 'IN_PROGRESS',
    operationProblems: data.operationProblems || [],
  };
}

// ─── Phase 3: Packing ─────────────────────────────────────────────────────
//
// The inbound plan lifecycle after createInboundPlan:
//   1. generatePackingOptions → async op, returns available packing options
//   2. listPackingOptions     → read the generated options
//   3. setPackingInformation  → tell Amazon box dimensions/weight/contents
//      (The seller describes how they've actually boxed the product.)
//   4. confirmPackingOption   → commit to one option
//   5. (then placement flow — see below)
//
// A "pack group" is Amazon's grouping of items that must ship together (based
// on prep requirements, expiration dates, etc.). Most small FBA sellers have
// one pack group. The seller then declares one or more BOXES inside that pack
// group and assigns items to each box.

export interface PackingConfiguration {
  box: {
    lengthIn: number;
    widthIn: number;
    heightIn: number;
    weightLb: number;
  };
  // Items packed in this box — msku + quantity. Must match the plan's items.
  items: Array<{ msku: string; quantity: number }>;
}

export interface PackingGroup {
  packingGroupId: string;
  boxes: PackingConfiguration[];
}

/**
 * Generate packing options for an inbound plan.
 * POST /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/packingOptions
 *
 * Amazon runs async optimization to figure out how items can be packed. Poll
 * the returned operationId until SUCCESS, then call listPackingOptions().
 */
export async function generatePackingOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingOptions`,
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API generatePackingOptions ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  if (!data?.operationId) {
    throw new Error(`generatePackingOptions: missing operationId in response: ${JSON.stringify(data)}`);
  }
  return { operationId: data.operationId };
}

/**
 * List the packing options that Amazon generated for an inbound plan.
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/packingOptions
 */
export async function listPackingOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<any[]> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingOptions`
  );
  return data?.packingOptions || [];
}

/**
 * List the items inside a specific pack group. For multi-group batches,
 * Amazon splits items into groups by some internal logic (bulky vs standard,
 * hazmat status, prep requirements, etc.) and each group ships separately.
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/packingGroups/{packingGroupId}/items
 */
export async function listPackingGroupItems(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  packingGroupId: string
): Promise<Array<{ msku: string; quantity: number; prepInstructions?: any[] }>> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingGroups/${encodeURIComponent(packingGroupId)}/items`
  );
  return data?.items || [];
}

/**
 * Declare how the seller has actually boxed the product.
 * POST /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/packingInformation
 *
 * `packageGroupings` is an array — one entry per packing group returned from
 * listPackingOptions. For small batches there's usually just one group.
 *
 * Caller passes dimensions in inches and weight in pounds (natural for US
 * sellers). This function converts to CM and KG before sending to Amazon,
 * which requires metric units per the v2024 API spec.
 */
export async function setPackingInformation(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  packageGroupings: Array<{
    packingGroupId: string;
    boxes: Array<{
      contentInformationSource?: 'BOX_CONTENT_PROVIDED' | 'MANUAL_PROCESS' | 'BARCODE_2D';
      dimensions: {
        unitOfMeasurement: 'IN';
        length: number;
        width: number;
        height: number;
      };
      weight: {
        unit: 'LB';
        value: number;
      };
      quantity: number; // number of identical boxes
      items: Array<{
        msku: string;
        quantity: number;
        labelOwner?: 'SELLER' | 'AMAZON' | 'NONE';
        prepOwner?: 'SELLER' | 'AMAZON' | 'NONE';
        expiration?: string;
        manufacturingLotCode?: string;
      }>;
    }>;
  }>
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const body = {
    packageGroupings: packageGroupings.map((g) => ({
      packingGroupId: g.packingGroupId,
      boxes: g.boxes.map((b) => {
        const boxPayload = {
          contentInformationSource: b.contentInformationSource || 'BOX_CONTENT_PROVIDED',
          dimensions: {
            unitOfMeasurement: 'IN',
            length: Math.round(b.dimensions.length * 100) / 100,
            width:  Math.round(b.dimensions.width  * 100) / 100,
            height: Math.round(b.dimensions.height * 100) / 100,
          },
          weight: {
            unit: 'LB',
            value: b.weight.value,
          },
          quantity: b.quantity,
          items: b.items.map((i) => ({
            msku: i.msku,
            quantity: i.quantity,
            ...(i.labelOwner         ? { labelOwner: i.labelOwner }                 : {}),
            ...(i.prepOwner          ? { prepOwner: i.prepOwner }                   : {}),
            ...(i.expiration         ? { expiration: i.expiration }                 : {}),
            ...(i.manufacturingLotCode ? { manufacturingLotCode: i.manufacturingLotCode } : {}),
          })),
        };
        console.log('[setPackingInformation] box payload', JSON.stringify(boxPayload, null, 2));
        return boxPayload;
      }),
    })),
  };

  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingInformation`,
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API setPackingInformation ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return { operationId: data.operationId || '' };
}

/**
 * Confirm the seller's choice of packing option.
 * POST /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/packingOptions/{packingOptionId}/confirmation
 */
export async function confirmPackingOption(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  packingOptionId: string
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingOptions/${encodeURIComponent(packingOptionId)}/confirmation`,
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API confirmPackingOption ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return { operationId: data.operationId || '' };
}

// ─── Phase 3: Placement ───────────────────────────────────────────────────
//
// After packing is confirmed, Amazon runs a placement optimization: it decides
// how to distribute your boxes across multiple fulfillment centers. Returns
// 3 options:
//   - Optimized (multiple destinations, cheapest overall, but more boxes)
//   - Partial   (middle ground)
//   - Minimal   (one destination, simpler + faster delivery, but higher fees)
//
// Amazon exposes the optimization fees for each option so the seller can
// compare. FlipLedger's innovation here is visualizing this on a map.

export interface PlacementOption {
  placementOptionId: string;
  shipmentIds: string[];
  fees: Array<{
    target: string;
    type: string;
    value: { amount: number; code: string };
    description?: string;
  }>;
  status: 'OFFERED' | 'ACCEPTED' | 'EXPIRED';
  expiresAt?: string;
  discounts?: any[];
}

/**
 * Kick off placement optimization.
 * POST /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/placementOptions
 */
export async function generatePlacementOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/placementOptions`,
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API generatePlacementOptions ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  if (!data?.operationId) {
    throw new Error(`generatePlacementOptions: missing operationId in response: ${JSON.stringify(data)}`);
  }
  return { operationId: data.operationId };
}

/**
 * List the placement options Amazon generated.
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/placementOptions
 */
export async function listPlacementOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<PlacementOption[]> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/placementOptions`
  );
  return data?.placementOptions || [];
}

/**
 * Confirm a placement option.
 * POST /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/placementOptions/{placementOptionId}/confirmation
 */
export async function confirmPlacementOption(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  placementOptionId: string
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/placementOptions/${encodeURIComponent(placementOptionId)}/confirmation`,
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API confirmPlacementOption ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return { operationId: data.operationId || '' };
}

/**
 * List the shipments for an inbound plan. After a placement option is
 * confirmed, Amazon creates 1+ shipments — each with its own destination
 * fulfillment center address. This is what powers the map visualization.
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/shipments
 */
export async function listShipments(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<any[]> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments`
  );
  return data?.shipments || [];
}

/**
 * Get a single shipment's details after placement confirmation.
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/shipments/{shipmentId}
 *
 * Returns destinationWarehouseAddress, shipmentConfirmationId, selectedTransportationOptionId.
 * This is the source of truth for the destination FC address post-confirmation.
 */
export async function getShipment(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string
): Promise<any> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}`
  );
  return data;
}

// ─── Shipment content updates (post-confirmation quantity adjustments) ─────
// The v2024 equivalent of the old v0 UpdateShipmentItems (what 2DWorkflow's
// "adjust Qty any time" / "Confirm Missing Units" is built on): propose the
// FULL post-update box+item contents for a CONFIRMED shipment, Amazon returns
// a preview (including any transportation requote), then confirm to apply.
// Amazon tolerance: ±5% or 6 units per SKU, whichever is higher.

export interface ContentUpdateItemInput {
  msku: string;
  quantity: number;
  labelOwner: string; // 'SELLER' | 'AMAZON' | 'NONE'
  prepOwner: string;  // 'SELLER' | 'AMAZON' | 'NONE'
  expiration?: string;
}

export interface ContentUpdateBoxInput {
  /** Provide to update an existing box; omit to add a new box. Existing packageIds NOT listed are removed from the shipment. */
  packageId?: string;
  contentInformationSource: 'BOX_CONTENT_PROVIDED' | 'BARCODE_2D' | 'MANUAL_PROCESS';
  /** Must be empty/omitted when contentInformationSource is BARCODE_2D or MANUAL_PROCESS. */
  items?: ContentUpdateItemInput[];
  dimensions: { length: number; width: number; height: number; unitOfMeasurement: 'IN' };
  weight: { value: number; unit: 'LB' };
  /** Number of identical boxes in this configuration row. */
  quantity: number;
}

export async function generateShipmentContentUpdatePreviews(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string,
  boxes: ContentUpdateBoxInput[],
  items: ContentUpdateItemInput[],
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);
  const body = { boxes, items };
  console.log('[generateContentUpdatePreviews] payload', JSON.stringify(body, null, 2));
  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/contentUpdatePreviews`,
    {
      method: 'POST',
      headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const text = await response.text();
  console.log('[generateContentUpdatePreviews] status:', response.status, 'response:', text.slice(0, 500));
  if (!response.ok) throw new Error(`SP-API generateShipmentContentUpdatePreviews ${response.status}: ${text}`);
  const data = JSON.parse(text);
  return { operationId: data.operationId || '' };
}

export async function listShipmentContentUpdatePreviews(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string,
): Promise<any[]> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/contentUpdatePreviews`
  );
  return data?.contentUpdatePreviews || [];
}

export async function confirmShipmentContentUpdatePreview(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string,
  contentUpdatePreviewId: string,
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);
  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/contentUpdatePreviews/${encodeURIComponent(contentUpdatePreviewId)}/confirmation`,
    {
      method: 'POST',
      headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    }
  );
  const text = await response.text();
  console.log('[confirmContentUpdatePreview] status:', response.status, 'response:', text.slice(0, 500));
  if (!response.ok) throw new Error(`SP-API confirmShipmentContentUpdatePreview ${response.status}: ${text}`);
  const data = JSON.parse(text);
  return { operationId: data.operationId || '' };
}

// ─── Phase 4: Labels (FNSKU + box ID) ─────────────────────────────────────
//
// FBA box/carton labels and FNSKU per-unit labels use the FBA Inbound v0 API,
// NOT the v2024-03-20 API. The v2024 inboundPlans/.../labels endpoint returns
// 403 for standard seller accounts — it's a vendor/direct-fulfillment endpoint.
//
// Correct endpoint for FBA inbound carton/FNSKU labels:
//   GET /fba/inbound/v0/shipments/{shipmentId}/labels
//
// IMPORTANT: When box content was provided via v2024-03-20 setPackingInformation,
// PackageLabelsToPrint must contain the boxId values from listShipmentBoxes.
// Passing a wrong or locally generated box name returns an error.

/**
 * Get shipment-level status for confirmed shipments via the v0 API.
 *
 * The v2024 inboundPlans endpoints return 403 once a plan's workflow is over
 * (verified live 2026-06-11 on every past plan, including a 2-week-old one),
 * so post-confirmation tracking MUST go through v0 using the FBA confirmation
 * IDs (FBA…) — not the v2024 sh… shipment IDs.
 *
 * Statuses: WORKING, READY_TO_SHIP, SHIPPED, IN_TRANSIT, DELIVERED,
 * CHECKED_IN, RECEIVING, CLOSED, CANCELLED, DELETED, ERROR.
 */
export async function getV0ShipmentStatuses(
  credentials: SPAPICredentials,
  confirmationIds: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  // v0 accepts a comma-separated ShipmentIdList; chunk defensively.
  for (let i = 0; i < confirmationIds.length; i += 50) {
    const chunk = confirmationIds.slice(i, i + 50);
    const data = await spApiRequest(credentials, '/fba/inbound/v0/shipments', {
      QueryType: 'SHIPMENT',
      MarketplaceId: credentials.marketplaceId,
      ShipmentIdList: chunk.join(','),
    });
    const shipments: any[] = data?.payload?.ShipmentData || [];
    for (const s of shipments) {
      if (s?.ShipmentId) result.set(s.ShipmentId, (s.ShipmentStatus || 'UNKNOWN').toUpperCase());
    }
  }
  return result;
}

export type LabelPageType =
  | 'PackageLabel_Letter_2'
  | 'PackageLabel_Letter_4'
  | 'PackageLabel_Letter_6'
  | 'PackageLabel_A4_2'
  | 'PackageLabel_A4_4'
  | 'PackageLabel_Plain_Paper'
  | 'PackageLabel_Plain_Paper_CarrierBottom'
  | 'PackageLabel_Thermal'
  | 'PackageLabel_Thermal_Unified'
  | 'PackageLabel_Thermal_NonPCP';

export type LabelType = 'BARCODE_2D' | 'UNIQUE' | 'PALLET';

/**
 * List the boxes Amazon knows about for a specific shipment.
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/shipments/{shipmentId}/boxes
 *
 * Returns Amazon-assigned boxId values. These must be passed as
 * PackageLabelsToPrint when calling getFBAInboundLabels for box labels.
 */
export async function listShipmentBoxes(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string
): Promise<Array<{ boxId: string; [key: string]: any }>> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/boxes`
  );
  return data?.boxes || [];
}

/**
 * Fetch FBA inbound shipment labels from the v0 labels endpoint.
 * GET /fba/inbound/v0/shipments/{shipmentId}/labels
 *
 * For box labels (LabelType=BARCODE_2D):
 *   - pass packageLabelsToPrint = boxId values from listShipmentBoxes
 *   - numberOfPackages = box count
 *
 * For FNSKU unit labels (LabelType=UNIQUE):
 *   - packageLabelsToPrint is optional (Amazon generates per-unit labels)
 *   - numberOfPackages = total unit count in the shipment
 *
 * Response shape: { payload: { URL: string, base64: string, ... } }
 * URL is a time-limited presigned S3 download link.
 */
export async function getFBAInboundLabels(
  credentials: SPAPICredentials,
  /** Must be the v0 shipmentConfirmationId (e.g. "FBA19CRM1CZ6"), NOT the v2024 shipmentId UUID. */
  labelShipmentId: string,
  pageType: LabelPageType = 'PackageLabel_Thermal_NonPCP',
  labelType: LabelType = 'BARCODE_2D',
  numberOfPackages?: number,
  packageLabelsToPrint?: string[],
  /** Integer: number of labels per page. Required for Non-Partnered / LTL shipments. */
  pageSize?: number,
  /** Integer: zero-based page start index. Required for Non-Partnered / LTL shipments. */
  pageStartIndex?: number
): Promise<{ downloadUrl: string | null; raw: any }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const url = new URL(`${endpoint}/fba/inbound/v0/shipments/${encodeURIComponent(labelShipmentId)}/labels`);
  url.searchParams.set('PageType', pageType);
  url.searchParams.set('LabelType', labelType);
  if (numberOfPackages != null) {
    url.searchParams.set('NumberOfPackages', String(numberOfPackages));
  }
  if (packageLabelsToPrint && packageLabelsToPrint.length > 0) {
    url.searchParams.set('PackageLabelsToPrint', packageLabelsToPrint.join(','));
  }
  if (pageSize != null) {
    url.searchParams.set('PageSize', String(pageSize));
  }
  if (pageStartIndex != null) {
    url.searchParams.set('PageStartIndex', String(pageStartIndex));
  }

  console.dir({
    operation: 'FBA_INBOUND_GET_LABELS',
    labelShipmentId,
    pageType,
    labelType,
    numberOfPackages,
    packageLabelsToPrint,
    pageSize,
    pageStartIndex,
    requestUrl: url.toString(),
  }, { depth: null });

  const response = await fetch(url.toString(), {
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  const responseText = await response.text();
  let data: any;
  try { data = JSON.parse(responseText); } catch { data = { _raw: responseText }; }

  console.log('[getFBAInboundLabels] status:', response.status, '| response:', JSON.stringify(data));

  if (!response.ok) {
    throw new Error(`SP-API getFBAInboundLabels ${response.status}: ${responseText}`);
  }

  // v0 response: { payload: { DownloadURL: "..." } } — Amazon uses DownloadURL (capital URL)
  const downloadUrl: string | null =
    data?.payload?.DownloadURL ??
    data?.payload?.downloadURL ??
    data?.payload?.downloadUrl ??
    data?.payload?.URL ??
    data?.payload?.url ??
    data?.DownloadURL ??
    data?.downloadURL ??
    data?.downloadUrl ??
    data?.URL ??
    data?.url ??
    null;

  console.log('[getFBAInboundLabels] parsed downloadUrl', {
    hasDownloadUrl: !!downloadUrl,
    payloadKeys: Object.keys(data?.payload ?? {}),
  });

  return { downloadUrl, raw: data };
}

// ─── Phase 3.5: Transportation options ────────────────────────────────────────
//
// After confirmPlacementOption, Amazon requires:
//   generateTransportationOptions → confirmTransportationOptions
// before Seller Central will allow the shipment to be completed.
// Plans created via API cannot be finished in Seller Central until both
// placement AND transportation are confirmed through the API.

export interface TransportationOption {
  transportationOptionId: string;
  shipmentId: string;
  carrier?: { name?: string; alphaCode?: string };
  shippingMode?: string;
  shippingSolution?: string;
  quote?: { cost?: { amount: number; currencyCode: string }; expirationDate?: string };
  preconditions?: string[];
}

// ─── LTL / freight inputs ──────────────────────────────────────────────────
// Amazon only returns FREIGHT_* carrier options and quotes when pallet and
// freight information are provided in the transportation configuration.

export interface LtlPalletInput {
  /** Identical-pallet count for this configuration row. */
  quantity: number;
  dimensions?: { length: number; width: number; height: number; unitOfMeasurement: 'IN' };
  weight?: { value: number; unit: 'LB' };
  stackability?: 'STACKABLE' | 'NON_STACKABLE';
}

export interface LtlFreightInformation {
  declaredValue?: { amount: number; code: string };
  /** NONE, FC_50, FC_55, FC_60, FC_65, FC_70, FC_77_5, FC_85, FC_92_5, FC_100, FC_110, FC_125, FC_150, FC_175, FC_200, FC_250, FC_300, FC_400, FC_500 */
  freightClass?: string;
}

export interface LtlContactInformation {
  name: string;
  email: string;
  phoneNumber: string;
}

export interface LtlConfiguration {
  pallets: LtlPalletInput[];
  freightInformation: LtlFreightInformation;
  contactInformation?: LtlContactInformation;
}

export async function generateTransportationOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  placementOptionId: string,
  shipmentIds: string[],
  readyToShipStart?: string,
  ltl?: LtlConfiguration,
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  // readyToShipWindow.start is required by Amazon — never send blank.
  // Default: tomorrow at noon UTC if caller doesn't provide.
  let shipWindowStart = readyToShipStart;
  if (!shipWindowStart) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(12, 0, 0, 0);
    shipWindowStart = d.toISOString();
  }

  const shipmentTransportationConfigurations = shipmentIds.map((id) => ({
    shipmentId: id,
    readyToShipWindow: { start: shipWindowStart },
    // LTL: pallets + freight info unlock FREIGHT_LTL carrier quotes. Amazon
    // still returns SPD options alongside, so the caller compares both.
    ...(ltl
      ? {
          pallets: ltl.pallets,
          freightInformation: ltl.freightInformation,
          ...(ltl.contactInformation ? { contactInformation: ltl.contactInformation } : {}),
        }
      : {}),
  }));

  const body = { placementOptionId, shipmentTransportationConfigurations };
  console.log('[generateTransportationOptions] payload', JSON.stringify(body, null, 2));

  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/transportationOptions`,
    {
      method: 'POST',
      headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const text = await response.text();
  console.log('[generateTransportationOptions] status:', response.status, 'response:', text);
  if (!response.ok) throw new Error(`SP-API generateTransportationOptions ${response.status}: ${text}`);
  const data = JSON.parse(text);
  return { operationId: data.operationId || '' };
}

export async function listTransportationOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  placementOptionId: string,
): Promise<TransportationOption[]> {
  const allOptions: TransportationOption[] = [];
  let paginationToken: string | undefined;
  let page = 0;

  do {
    const endpoint = getEndpoint(credentials.marketplaceId);
    const accessToken = await getAccessToken(credentials);
    const url = new URL(
      `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/transportationOptions`
    );
    url.searchParams.set('placementOptionId', placementOptionId);
    url.searchParams.set('pageSize', '20');
    if (paginationToken) url.searchParams.set('paginationToken', paginationToken);

    const response = await fetch(url.toString(), { headers: { 'x-amz-access-token': accessToken } });
    const text = await response.text();
    console.log(`[listTransportationOptions] page ${page} status:`, response.status, 'length:', text.length);
    if (!response.ok) throw new Error(`SP-API listTransportationOptions ${response.status}: ${text}`);
    const data = JSON.parse(text);
    const batch: TransportationOption[] = data?.transportationOptions || [];
    allOptions.push(...batch);
    paginationToken = data?.pagination?.nextToken;
    page++;
  } while (paginationToken && page < 20); // cap at 20 pages (400 options) to prevent infinite loops

  console.log(`[listTransportationOptions] total options fetched: ${allOptions.length} across ${page} page(s)`);
  return allOptions;
}

export async function confirmTransportationOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  // contactInformation is required by Amazon when confirming FREIGHT_* options
  // (the carrier needs someone to coordinate the pickup appointment with).
  transportationSelections: Array<{
    shipmentId: string;
    transportationOptionId: string;
    contactInformation?: LtlContactInformation;
  }>,
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);
  const body = { transportationSelections };
  console.log('[confirmTransportationOptions] request body:', JSON.stringify(body));
  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/transportationOptions/confirmation`,
    {
      method: 'POST',
      headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const text = await response.text();
  console.log('[confirmTransportationOptions] status:', response.status, 'response:', text);
  if (!response.ok) throw new Error(`SP-API confirmTransportationOptions ${response.status}: ${text}`);
  const data = JSON.parse(text);
  return { operationId: data.operationId || '' };
}

// ─── Delivery Window Options ──────────────────────────────────────────────
// Required before confirmTransportationOptions for non-partnered carrier
// options and any option whose preconditions include DELIVERY_WINDOW_REQUIRED.
//
// Flow: generateDeliveryWindowOptions → poll → listDeliveryWindowOptions
//       → pick first → confirmDeliveryWindowOptions → poll → confirmTransportation

export async function generateDeliveryWindowOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string,
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);
  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/deliveryWindowOptions`,
    {
      method: 'POST',
      headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
      body: '{}',
    }
  );
  const text = await response.text();
  console.log('[generateDeliveryWindowOptions]', shipmentId, response.status, text.slice(0, 500));
  if (!response.ok) throw new Error(`SP-API generateDeliveryWindowOptions ${response.status}: ${text}`);
  const data = JSON.parse(text);
  return { operationId: data.operationId || '' };
}

export async function listDeliveryWindowOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string,
): Promise<any[]> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);
  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/deliveryWindowOptions`,
    { headers: { 'x-amz-access-token': accessToken } }
  );
  const text = await response.text();
  console.log('[listDeliveryWindowOptions]', shipmentId, response.status, text.slice(0, 500));
  if (!response.ok) throw new Error(`SP-API listDeliveryWindowOptions ${response.status}: ${text}`);
  const data = JSON.parse(text);
  return data?.deliveryWindowOptions || [];
}

export async function confirmDeliveryWindowOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string,
  deliveryWindowOptionId: string,
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);
  const body = { deliveryWindowOptionId };
  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/deliveryWindowOptions/confirmation`,
    {
      method: 'POST',
      headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const text = await response.text();
  console.log('[confirmDeliveryWindowOptions]', shipmentId, deliveryWindowOptionId, response.status, text.slice(0, 500));
  // 403 here means the account type or shipment mode doesn't require delivery
  // window confirmation via API (common for parcel/non-LTL non-partnered accounts).
  // Treat as a no-op: skip and proceed to confirmTransportationOptions.
  if (response.status === 403) {
    console.warn('[confirmDeliveryWindowOptions] 403 — skipping (not required for this account/shipment type)');
    return { operationId: '' };
  }
  if (!response.ok) throw new Error(`SP-API confirmDeliveryWindowOptions ${response.status}: ${text}`);
  const data = JSON.parse(text);
  return { operationId: data.operationId || '' };
}

/**
 * Pull a label PDF down from Amazon's S3 URL and return the binary as a Buffer.
 * Most label download URLs are time-limited; do this server-side and stream
 * to the browser OR pipe directly to lpr.
 */
export async function downloadLabelPdf(downloadUrl: string): Promise<Buffer> {
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(`Label PDF download failed: ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
