import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactSettings,
  resolveSettingsUpdates,
  REDACTED_SECRET,
  ALLOWED_SETTING_KEYS,
  SECRET_SETTING_KEYS,
} from '../src/lib/settings-policy';

test('GET redaction hides every secret value but keeps non-secrets', () => {
  const stored = {
    clientId: 'amzn1.app.client',
    clientSecret: 'amzn1.oa2-cs.SUPERSECRET',
    refreshToken: 'Atzr|REALTOKEN',
    marketplaceId: 'ATVPDKIKX0DER',
    walmart_client_id: 'wm-client',
    walmart_client_secret: 'wm-secret',
    ebay_client_id: 'ebay-client',
    ebay_refresh_token: 'ebay-refresh',
    airtable_api_key: 'patSECRET',
    veeqo_api_key: 'veeqoSECRET',
    informed_api_key: 'informedSECRET',
    extensionApiKey: 'extSECRET',
    profit_target_monthly: '5000',
    listing_ship_from_city: 'Phoenix',
  };
  const out = redactSettings(stored);

  // No raw secret value survives.
  for (const key of SECRET_SETTING_KEYS) {
    if (stored[key as keyof typeof stored]) {
      assert.equal(out[key], REDACTED_SECRET, `${key} must be redacted`);
      assert.notEqual(out[key], stored[key as keyof typeof stored]);
    }
  }
  // Non-secret config passes through untouched.
  assert.equal(out.marketplaceId, 'ATVPDKIKX0DER');
  assert.equal(out.profit_target_monthly, '5000');
  assert.equal(out.listing_ship_from_city, 'Phoenix');
});

test('GET redaction leaves an unset secret empty (so UI shows placeholder)', () => {
  const out = redactSettings({ clientSecret: '', refreshToken: '' });
  assert.equal(out.clientSecret, '');
  assert.equal(out.refreshToken, '');
});

test('POST drops arbitrary unknown keys', () => {
  const updates = resolveSettingsUpdates({
    clientId: 'good',
    __proto__pollute: 'x',
    DROP_TABLE: 'y',
    randomKey: 'z',
  });
  const keys = updates.map(([k]) => k);
  assert.deepEqual(keys, ['clientId']);
  assert.ok(!keys.includes('randomKey'));
  assert.ok(!keys.includes('DROP_TABLE'));
});

test('POST preserves a secret submitted as the redaction sentinel', () => {
  // Simulates the UI saving the whole settings object without editing secrets.
  const updates = resolveSettingsUpdates({
    clientId: REDACTED_SECRET,
    clientSecret: REDACTED_SECRET,
    refreshToken: REDACTED_SECRET,
    marketplaceId: 'ATVPDKIKX0DER',
  });
  const map = new Map(updates);
  assert.equal(map.has('clientId'), false);
  assert.equal(map.has('clientSecret'), false, 'sentinel secret must not be written');
  assert.equal(map.has('refreshToken'), false);
  assert.equal(map.get('marketplaceId'), 'ATVPDKIKX0DER');
});

test('POST writes a real new secret value through', () => {
  const updates = resolveSettingsUpdates({ clientSecret: 'amzn1.oa2-cs.NEWVALUE' });
  assert.deepEqual(updates, [['clientSecret', 'amzn1.oa2-cs.NEWVALUE']]);
});

test('POST ignores non-string values', () => {
  const updates = resolveSettingsUpdates({
    profit_target_monthly: 5000,        // number — ignored
    dashboard_layout: '{"a":1}',         // string — kept
    clientSecret: null,                  // null — ignored (preserve)
  });
  assert.deepEqual(updates, [['dashboard_layout', '{"a":1}']]);
});

test('every secret key is also on the allowlist', () => {
  for (const key of SECRET_SETTING_KEYS) {
    assert.ok(ALLOWED_SETTING_KEYS.has(key), `${key} must be allowlisted to be saveable`);
  }
});

test('label printer name is saveable (allowlisted, non-secret)', () => {
  // Settings UI must be able to persist the chosen label-printer queue.
  assert.ok(ALLOWED_SETTING_KEYS.has('listing_rollo_printer_name'));
  assert.ok(!SECRET_SETTING_KEYS.has('listing_rollo_printer_name'));
  const updates = resolveSettingsUpdates({ listing_rollo_printer_name: 'Rollo_Printer' });
  assert.deepEqual(updates, [['listing_rollo_printer_name', 'Rollo_Printer']]);
});
