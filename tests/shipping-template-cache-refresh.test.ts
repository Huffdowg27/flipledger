import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { refreshShippingTemplateCacheIfStale } from '../src/lib/sp-api/shippingTemplates';
import { AMAZON_SHIPPING_TEMPLATE_CACHE_KEY } from '../src/lib/amazonShippingTemplates';

const CREDS = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  refreshToken: 'test-refresh',
  marketplaceId: 'ATVPDKIKX0DER',
};

const HOUR_MS = 3600000;

function makeFixture(cacheFetchedAt: string): { dir: string; db: Database.Database } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-cache-refresh-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO settings (key, value) VALUES
      ('amazon_seller_id', 'SELLER123');
  `);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    AMAZON_SHIPPING_TEMPLATE_CACHE_KEY,
    JSON.stringify({
      templates: [{ key: 'OLD_KEY', name: 'Old Template' }],
      marketplaceId: 'ATVPDKIKX0DER',
      fetchedAt: cacheFetchedAt,
    }),
  );
  return { dir, db };
}

function cleanup(dir: string, db: Database.Database, previousCwd: string) {
  db.close();
  process.chdir(previousCwd);
  fs.rmSync(dir, { recursive: true, force: true });
}

test('fresh template cache is returned without any network call', async () => {
  const { dir, db } = makeFixture(new Date(Date.now() - 1 * HOUR_MS).toISOString());
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response('unexpected', { status: 500 });
  };

  try {
    process.chdir(dir);
    const result = await refreshShippingTemplateCacheIfStale(db, CREDS);
    assert.equal(result.refreshed, false);
    assert.equal(result.refreshError, null);
    assert.equal(result.cache.templates[0].name, 'Old Template');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup(dir, db, previousCwd);
  }
});

test('stale cache with failing refresh keeps the cached list and reports the error', async () => {
  const { dir, db } = makeFixture(new Date(Date.now() - 48 * HOUR_MS).toISOString());
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('throttled', { status: 429 });

  try {
    process.chdir(dir);
    const result = await refreshShippingTemplateCacheIfStale(db, CREDS);
    assert.equal(result.refreshed, false);
    assert.ok(result.refreshError, 'expected a refreshError');
    // Usable cache survives — never wiped by a failed refresh.
    assert.equal(result.cache.templates.length, 1);
    assert.equal(result.cache.templates[0].name, 'Old Template');
    const stored = db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(AMAZON_SHIPPING_TEMPLATE_CACHE_KEY) as { value: string };
    assert.match(stored.value, /Old Template/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup(dir, db, previousCwd);
  }
});

test('stale cache refreshes from Amazon and persists the new list', async () => {
  const { dir, db } = makeFixture(new Date(Date.now() - 48 * HOUR_MS).toISOString());
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.amazon.com/auth/o2/token') {
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    }
    if (url.includes('/definitions/2020-09-01/productTypes/PRODUCT')) {
      return Response.json({ schema: { link: { resource: 'https://schema.example/product.json' } } });
    }
    if (url === 'https://schema.example/product.json') {
      return Response.json({
        properties: {
          merchant_shipping_group: {
            items: {
              properties: {
                value: { enum: ['NEW_KEY'], enumNames: ['New Template'] },
              },
            },
          },
        },
      });
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  };

  try {
    process.chdir(dir);
    const result = await refreshShippingTemplateCacheIfStale(db, CREDS);
    assert.equal(result.refreshed, true);
    assert.equal(result.refreshError, null);
    assert.deepEqual(result.cache.templates, [{ key: 'NEW_KEY', name: 'New Template' }]);
    const stored = db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(AMAZON_SHIPPING_TEMPLATE_CACHE_KEY) as { value: string };
    assert.match(stored.value, /New Template/);
    assert.doesNotMatch(stored.value, /Old Template/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup(dir, db, previousCwd);
  }
});

test('an empty refresh result never wipes a usable cache', async () => {
  const { dir, db } = makeFixture(new Date(Date.now() - 48 * HOUR_MS).toISOString());
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.amazon.com/auth/o2/token') {
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    }
    if (url.includes('/definitions/2020-09-01/productTypes/PRODUCT')) {
      return Response.json({ schema: { link: { resource: 'https://schema.example/product.json' } } });
    }
    if (url === 'https://schema.example/product.json') {
      return Response.json({ properties: {} }); // schema without templates
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  };

  try {
    process.chdir(dir);
    const result = await refreshShippingTemplateCacheIfStale(db, CREDS);
    assert.equal(result.refreshed, false);
    assert.match(String(result.refreshError), /no templates/i);
    assert.equal(result.cache.templates[0].name, 'Old Template');
    const stored = db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(AMAZON_SHIPPING_TEMPLATE_CACHE_KEY) as { value: string };
    assert.match(stored.value, /Old Template/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup(dir, db, previousCwd);
  }
});
