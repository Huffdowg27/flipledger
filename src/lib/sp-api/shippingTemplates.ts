/**
 * SP-API Product Type Definitions helper — reads the merchant_shipping_group
 * enum from the PRODUCT product type schema.
 *
 * Amazon shipping templates are account-specific. The SP-API exposes them as
 * enum values inside the PRODUCT type definition schema. The key (e.g.
 * "DEFAULT_MFN") is what must be written to Amazon; the enumName is the
 * display label. This helper is read-only — no Amazon writes.
 */

import { getAccessToken, getEndpoint } from './auth';
import type { SPAPICredentials } from './types';

export interface ShippingTemplate {
  key: string;   // enum value — write this to Amazon
  name: string;  // enumName — display label only
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
