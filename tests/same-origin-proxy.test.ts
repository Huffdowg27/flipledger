import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { proxy } from '../src/proxy';

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://127.0.0.1:3002${path}`, {
    method,
    headers: { host: '127.0.0.1:3002', ...headers },
  });
}

test('safe API methods remain available cross-origin', () => {
  const response = proxy(request('GET', '/api/data/refunds', {
    origin: 'https://attacker.example',
    'sec-fetch-site': 'cross-site',
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-middleware-next'), '1');
});

test('same-origin mutation is allowed', () => {
  const response = proxy(request('POST', '/api/sync', {
    origin: 'http://127.0.0.1:3002',
    'sec-fetch-site': 'same-origin',
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-middleware-next'), '1');
});

test('cross-origin mutation is rejected before reaching a route', async () => {
  const response = proxy(request('POST', '/api/data/settings', {
    origin: 'https://attacker.example',
    'sec-fetch-site': 'cross-site',
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Cross-origin mutation blocked' });
});

test('opaque browser origins and malformed origins fail closed', () => {
  assert.equal(proxy(request('DELETE', '/api/list/batches/1', { origin: 'null' })).status, 403);
  assert.equal(proxy(request('PATCH', '/api/data/products', { origin: 'not a url' })).status, 403);
});

test('Fetch Metadata blocks cross-site mutation even when Origin is absent', () => {
  const response = proxy(request('POST', '/api/sync', {
    'sec-fetch-site': 'cross-site',
  }));
  assert.equal(response.status, 403);
});

test('local command-line automation without browser headers remains supported', () => {
  const response = proxy(request('POST', '/api/sync'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-middleware-next'), '1');
});

test('API-key-protected Veeqo extension endpoint remains cross-origin', () => {
  const response = proxy(request('POST', '/api/extension/veeqo-context', {
    origin: 'chrome-extension://abcdefghijklmnop',
    'sec-fetch-site': 'cross-site',
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-middleware-next'), '1');
});
