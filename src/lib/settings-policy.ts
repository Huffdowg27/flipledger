/**
 * Access policy for the unauthenticated /api/data/settings endpoint.
 *
 * Two jobs:
 *  - GET must never echo stored secrets (API keys, tokens, client secrets).
 *  - POST must only accept known setting keys, so the open endpoint can't be
 *    used to write arbitrary rows into the settings table.
 *
 * Secrets are redacted in GET with a sentinel. The Settings UI binds inputs to
 * the GET response and round-trips that sentinel on save, so POST treats the
 * sentinel as "leave the stored secret unchanged" — existing save flows keep
 * working without any UI change.
 */

// Every key the API will persist on POST. Anything else is ignored.
export const ALLOWED_SETTING_KEYS: ReadonlySet<string> = new Set([
  // Amazon SP-API
  'clientId', 'clientSecret', 'refreshToken', 'marketplaceId',
  // last-sync bookkeeping (also written server-side by auto-sync)
  'lastSync', 'walmart_last_sync', 'ebay_last_sync',
  // Walmart
  'walmart_client_id', 'walmart_client_secret',
  // eBay
  'ebay_client_id', 'ebay_client_secret', 'ebay_refresh_token',
  // Integrations
  'airtable_api_key', 'veeqo_api_key', 'informed_api_key', 'extensionApiKey',
  // Listing ship-from address
  'listing_ship_from_name', 'listing_ship_from_address_line1', 'listing_ship_from_city',
  'listing_ship_from_state', 'listing_ship_from_postal_code', 'listing_ship_from_country_code',
  'listing_ship_from_phone',
  // Label printing
  'listing_rollo_printer_name',
  // Targets / UI prefs
  'profit_target_monthly', 'dashboard_layout',
]);

// Subset that must never be returned raw in GET responses.
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  'clientId', 'clientSecret', 'refreshToken',
  'walmart_client_id', 'walmart_client_secret',
  'ebay_client_id', 'ebay_client_secret', 'ebay_refresh_token',
  'airtable_api_key', 'veeqo_api_key', 'informed_api_key', 'extensionApiKey',
]);

// Sentinel substituted for a stored secret in GET. The UI sends it back
// unchanged when the user doesn't edit a secret field; POST then preserves the
// existing value. Chosen to be collision-proof with any real credential.
export const REDACTED_SECRET = '__redacted__';

export function isSecretKey(key: string): boolean {
  return SECRET_SETTING_KEYS.has(key);
}

/**
 * Redact secret values for a GET response. A secret with a stored value becomes
 * the sentinel (signals "set" to the UI without leaking it); an unset secret
 * stays empty so the UI shows its placeholder. Non-secret values pass through.
 */
export function redactSettings(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = isSecretKey(key) && value ? REDACTED_SECRET : value;
  }
  return out;
}

/**
 * Resolve a POST body into the [key, value] pairs to upsert:
 *  - drops keys not on the allowlist (no arbitrary rows on the open endpoint)
 *  - drops non-string values
 *  - for a secret submitted as the redaction sentinel, skips the write so the
 *    stored secret is preserved (the UI round-tripped an unedited field).
 *
 * Omitted keys are naturally preserved (never appear here, never written).
 */
export function resolveSettingsUpdates(body: Record<string, unknown>): Array<[string, string]> {
  const updates: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_SETTING_KEYS.has(key)) continue;
    if (typeof value !== 'string') continue;
    if (isSecretKey(key) && value === REDACTED_SECRET) continue; // preserve existing
    updates.push([key, value]);
  }
  return updates;
}
