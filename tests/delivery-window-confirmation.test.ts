import test from 'node:test';
import assert from 'node:assert/strict';

import { clearTokenCache } from '../src/lib/sp-api/auth';
import { confirmDeliveryWindowOptions } from '../src/lib/sp-api/inboundPlansV2';
import type { SPAPICredentials } from '../src/lib/sp-api/types';

const credentials: SPAPICredentials = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  refreshToken: 'test-refresh',
  marketplaceId: 'ATVPDKIKX0DER',
};

test('confirmDeliveryWindowOptions sends the option id in Amazon’s documented path', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  clearTokenCache();

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.amazon.com/auth/o2/token') {
      return Response.json({
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        token_type: 'bearer',
        expires_in: 3600,
      });
    }

    requests.push({
      url,
      method: init?.method || 'GET',
      body: init?.body,
    });
    return Response.json({ operationId: 'operation-1' }, { status: 202 });
  };

  try {
    const result = await confirmDeliveryWindowOptions(
      credentials,
      'plan/with slash',
      'shipment/with slash',
      'window/with slash',
    );

    assert.deepEqual(result, { operationId: 'operation-1' });
    assert.deepEqual(requests, [{
      url: 'https://sellingpartnerapi-na.amazon.com/inbound/fba/2024-03-20/inboundPlans/plan%2Fwith%20slash/shipments/shipment%2Fwith%20slash/deliveryWindowOptions/window%2Fwith%20slash/confirmation',
      method: 'POST',
      body: undefined,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    clearTokenCache();
  }
});

test('confirmDeliveryWindowOptions fails closed when Amazon returns 403', async () => {
  const originalFetch = globalThis.fetch;
  clearTokenCache();

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.amazon.com/auth/o2/token') {
      return Response.json({
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        token_type: 'bearer',
        expires_in: 3600,
      });
    }

    return Response.json({
      errors: [{
        code: 'Unauthorized',
        message: 'Access to requested resource is denied.',
      }],
    }, { status: 403 });
  };

  try {
    await assert.rejects(
      confirmDeliveryWindowOptions(
        credentials,
        'plan-id',
        'shipment-id',
        'window-id',
      ),
      /confirmDeliveryWindowOptions 403:[\s\S]*Unauthorized/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearTokenCache();
  }
});
