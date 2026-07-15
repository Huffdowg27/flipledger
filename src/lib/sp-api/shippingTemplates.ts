/**
 * SP-API Product Type Definitions helper — reads the merchant_shipping_group
 * enum from the PRODUCT product type schema.
 *
 * Amazon shipping templates are account-specific. The SP-API exposes them as
 * enum values inside the PRODUCT type definition schema. FlipLedger stores the
 * enum key and display name; push paths resolve either local form to the exact
 * template name before sending merchant_shipping_group. This helper is
 * read-only — no Amazon writes.
 */

import type Database from 'better-sqlite3';
import { getAccessToken, getEndpoint } from './auth';
import { getSellerId } from './listingsItems';
import type { SPAPICredentials } from './types';
import {
  AMAZON_SHIPPING_TEMPLATE_CACHE_KEY,
  isAmazonShippingTemplateCacheStale,
  loadAmazonShippingTemplateCache,
  type AmazonShippingTemplateCache,
} from '../amazonShippingTemplates';

export interface ShippingTemplate {
  key: string;
  name: string;
}

/**
 * Fetch the seller's MFN shipping templates from the Product Type Definitions
 * API by reading the merchant_shipping_group enum in the PRODUCT type schema.
 *
 * GET /definitions/2020-09-01/productTypes/PRODUCT
 *   ?sellerId=…&marketplaceIds=…&requirements=LISTING&locale=en_US
 *
 * The response contains a schema URL. We fetch that URL (no auth needed — it's
 * a plain HTTPS document) and parse:
 *   properties.merchant_shipping_group.items.properties.value.enum      (keys)
 *   properties.merchant_shipping_group.items.properties.value.enumNames (labels)
 *
 * Returns an empty array if the schema cannot be fetched or doesn't contain
 * the expected structure — callers should fall back gracefully.
 */
export async function fetchShippingTemplates(
  credentials: SPAPICredentials,
  sellerId: string
): Promise<ShippingTemplate[]> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  // 1. Fetch the PRODUCT type definition to get the schema URL
  const defUrl = new URL(`${endpoint}/definitions/2020-09-01/productTypes/PRODUCT`);
  defUrl.searchParams.set('sellerId', sellerId);
  defUrl.searchParams.set('marketplaceIds', credentials.marketplaceId);
  defUrl.searchParams.set('requirements', 'LISTING');
  defUrl.searchParams.set('locale', 'en_US');

  const defResponse = await fetch(defUrl.toString(), {
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  if (!defResponse.ok) {
    const body = await defResponse.text();
    throw new Error(`Product Type Definitions API ${defResponse.status}: ${body}`);
  }

  const defData: any = await defResponse.json();
  const schemaUrl: string | undefined = defData?.schema?.link?.resource;
  if (!schemaUrl) {
    throw new Error('Product Type Definitions response missing schema.link.resource');
  }

  // 2. Fetch the JSON schema document (no auth needed)
  const schemaResponse = await fetch(schemaUrl);
  if (!schemaResponse.ok) {
    throw new Error(`Schema fetch ${schemaResponse.status} from ${schemaUrl}`);
  }

  const schema: any = await schemaResponse.json();

  // 3. Parse merchant_shipping_group enum + enumNames
  const valueNode = schema?.properties?.merchant_shipping_group?.items?.properties?.value;
  const keys: string[] = Array.isArray(valueNode?.enum) ? valueNode.enum : [];
  const names: string[] = Array.isArray(valueNode?.enumNames) ? valueNode.enumNames : [];

  if (keys.length === 0) return [];

  return keys.map((key, i) => ({
    key,
    name: names[i] ?? key,
  }));
}

/**
 * Refresh the settings-cached shipping template list when it's older than
 * AMAZON_SHIPPING_TEMPLATE_CACHE_FRESH_MS, so live pushes validate against a
 * current list instead of one synced weeks ago.
 *
 * Fail-safe by design: a failed or empty refresh NEVER wipes a usable cache —
 * the caller gets the existing cache plus a refreshError to log/surface.
 * Amazon remains the final arbiter (an unknown template name is rejected and
 * the push fails closed), so serving a stale list here degrades UX, not safety.
 */
export async function refreshShippingTemplateCacheIfStale(
  db: Database.Database,
  credentials: SPAPICredentials,
): Promise<{ cache: AmazonShippingTemplateCache; refreshed: boolean; refreshError: string | null }> {
  const cache = loadAmazonShippingTemplateCache(db);
  if (!isAmazonShippingTemplateCacheStale(cache)) {
    return { cache, refreshed: false, refreshError: null };
  }

  try {
    const sellerId = await getSellerId(credentials);
    const templates = await fetchShippingTemplates(credentials, sellerId);
    if (templates.length === 0) {
      return {
        cache,
        refreshed: false,
        refreshError: 'template refresh returned no templates; kept the cached list',
      };
    }

    const fetchedAt = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      AMAZON_SHIPPING_TEMPLATE_CACHE_KEY,
      JSON.stringify({ templates, marketplaceId: credentials.marketplaceId, fetchedAt }),
    );
    return {
      cache: { templates, marketplaceId: credentials.marketplaceId, fetchedAt },
      refreshed: true,
      refreshError: null,
    };
  } catch (err) {
    return { cache, refreshed: false, refreshError: String(err) };
  }
}
