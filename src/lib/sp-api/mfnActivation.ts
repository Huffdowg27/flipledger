/**
 * MFN Activation Push — PATCH qty, price, and shipping template on
 * an existing Merchant Fulfilled listing via Listings Items API 2021-08-01.
 *
 * Uses PATCH (not PUT) so only the three offer attributes are written;
 * compliance attributes, product type, and catalog data on the existing
 * listing are left exactly as they are.
 *
 * Amazon's PATCH response mirrors the PUT shape:
 *   { sku, status: 'ACCEPTED'|'INVALID'|'VALID', submissionId?, issues[] }
 * ACCEPTED = queued for processing (not yet live).
 * INVALID  = rejected — check issues[] for the blocking attribute codes.
 */
import { getAccessToken, getEndpoint } from './auth';
import type { SPAPICredentials } from './types';

export interface MfnPatchParams {
  sku: string;
  quantity: number;
  listPriceCents: number;
  merchantShippingGroupName: string;
  productType?: string;   // defaults to 'PRODUCT' — only used for routing, not catalog attrs
}

export interface MfnPatchIssue {
  code: string;
  message: string;
  severity: string;
  attributeNames?: string[];
}

export interface MfnPatchResult {
  sku: string;
  status: 'ACCEPTED' | 'INVALID' | 'VALID' | 'ERROR';
  submissionId: string | null;
  issues: MfnPatchIssue[];
}

/**
 * Patch an existing MFN listing: quantity + price + shipping template.
 *
 * The three patches are sent atomically in one PATCH call. If Amazon
 * rejects any attribute, the whole call returns INVALID and issues[]
 * describes the specific problem.
 */
export async function patchMfnListing(
  credentials: SPAPICredentials,
  sellerId: string,
  params: MfnPatchParams
): Promise<MfnPatchResult> {
  const endpoint  = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);
  const productType = params.productType ?? 'PRODUCT';
  const priceDollars = (params.listPriceCents / 100).toFixed(2);
  const nowIso = new Date().toISOString();

  const body = {
    productType,
    patches: [
      {
        op: 'replace',
        path: '/attributes/fulfillment_availability',
        value: [{ fulfillment_channel_code: 'DEFAULT', quantity: params.quantity }],
      },
      {
        op: 'replace',
        path: '/attributes/purchasable_offer',
        value: [
          {
            currency: 'USD',
            marketplace_id: credentials.marketplaceId,
            audience: 'ALL',
            // start_at is required for the offer to become BUYABLE — without it
            // Amazon accepts the patch silently but the listing stays non-purchasable.
            start_at: { value: nowIso },
            our_price: [{ schedule: [{ value_with_tax: parseFloat(priceDollars) }] }],
          },
        ],
      },
      {
        op: 'replace',
        path: '/attributes/merchant_shipping_group_name',
        value: [{ value: params.merchantShippingGroupName, marketplace_id: credentials.marketplaceId }],
      },
    ],
  };

  const url = new URL(
    `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(params.sku)}`
  );
  url.searchParams.set('marketplaceIds', credentials.marketplaceId);

  const response = await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API PATCH ${response.status} on ${params.sku}: ${errorBody}`);
  }

  const data = await response.json();
  return {
    sku:          data.sku          ?? params.sku,
    status:       data.status       ?? 'ACCEPTED',
    submissionId: data.submissionId ?? null,
    issues:       data.issues       ?? [],
  };
}
