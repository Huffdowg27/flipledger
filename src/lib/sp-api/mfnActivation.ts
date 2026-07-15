/**
 * MFN Activation Push — PATCH qty and price on an existing Merchant
 * Fulfilled listing via Listings Items API 2021-08-01.
 *
 * Uses PATCH (not PUT) so only the offer attributes are written;
 * compliance attributes, product type, and catalog data on the existing
 * listing are left exactly as they are.
 *
 * If a shipping template is provided, merchant_shipping_group is patched along
 * with quantity and price. A template rejection FAILS CLOSED: the row comes
 * back INVALID with a FLIPLEDGER_TEMPLATE_REJECTED issue and no second write
 * is made — never retry without the template (a live offer with the wrong
 * shipping template charges the wrong shipping).
 *
 * Amazon's PATCH response mirrors the PUT shape:
 *   { sku, status: 'ACCEPTED'|'INVALID'|'VALID', submissionId?, issues[] }
 * ACCEPTED = queued for processing (not yet live).
 * INVALID  = rejected — check issues[] for the blocking attribute codes.
 */
import { getAccessToken, getEndpoint } from './auth';
import type { SPAPICredentials } from './types';
import {
  isMerchantShippingGroupIssue,
  makeTemplateRejectedIssue,
} from '@/lib/amazonShippingTemplates';

export interface MfnPatchParams {
  sku: string;
  quantity: number;
  listPriceCents: number;
  productType?: string;   // defaults to 'PRODUCT' — only used for routing, not catalog attrs
  merchantShippingGroupName?: string | null;  // display label — used only in messages/logs
  merchantShippingGroupValue?: string | null; // the ENUM KEY Amazon requires; falls back to name
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
 * Patch an existing MFN listing: quantity + price + optional shipping template.
 *
 * Both patches are sent atomically in one PATCH call. If Amazon rejects
 * any attribute, the whole call returns INVALID and issues[] describes
 * the specific problem. Warnings on a successful ACCEPTED response are
 * also returned in issues[] for logging.
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

  const basePatches = [
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
  ];
  const shippingTemplateName = params.merchantShippingGroupName?.trim() || null;
  // Amazon requires the enum KEY (id) here, not the display name (error 90244).
  // Fall back to the name only if no key was resolved (keeps old behavior safe).
  const shippingTemplateValue = params.merchantShippingGroupValue?.trim() || shippingTemplateName;
  const templatePatch = shippingTemplateName
    ? [{
        op: 'replace',
        path: '/attributes/merchant_shipping_group',
        value: [{ value: shippingTemplateValue, marketplace_id: credentials.marketplaceId }],
      }]
    : [];

  const buildBody = (includeTemplate: boolean) => ({
    productType,
    patches: includeTemplate ? [...basePatches, ...templatePatch] : basePatches,
  });

  const url = new URL(
    `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(params.sku)}`
  );
  url.searchParams.set('marketplaceIds', credentials.marketplaceId);

  async function send(includeTemplate: boolean): Promise<MfnPatchResult> {
    const response = await fetch(url.toString(), {
      method: 'PATCH',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildBody(includeTemplate)),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const err = new Error(`SP-API PATCH ${response.status} on ${params.sku}: ${errorBody}`);
      (err as Error & { templateIssue?: boolean }).templateIssue =
        includeTemplate && isMerchantShippingGroupIssue({ message: errorBody });
      throw err;
    }

    const data = await response.json();
    return {
      sku:          data.sku          ?? params.sku,
      status:       data.status       ?? 'ACCEPTED',
      submissionId: data.submissionId ?? null,
      issues:       data.issues       ?? [],
    };
  }

  if (!shippingTemplateName) return send(false);

  // Fail closed on template rejection: never retry without the template. A
  // live offer with the wrong shipping template charges the wrong shipping —
  // the row stays INVALID with an actionable issue instead.
  let firstResult: MfnPatchResult;
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
