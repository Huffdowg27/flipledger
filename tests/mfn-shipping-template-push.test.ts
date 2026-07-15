import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { createOrUpdateListing } from '../src/lib/sp-api/listingsItems';
import { POST as pushActivation } from '../src/app/api/data/merchant-inventory/activation-push/route';
import { POST as sendBatch } from '../src/app/api/list/batches/[id]/send/route';

interface ListingsPatch {
  op: string;
  path: string;
  value: unknown;
}

interface ListingsPatchBody {
  patches: ListingsPatch[];
}

interface ListingsPutBody {
  attributes: Record<string, unknown>;
}

// fetchedAt defaults to "now" so push routes treat the cache as fresh and skip
// the stale-cache refresh; the refresh path has its own dedicated tests below.
function makeActivationFixture(templateCache = {
  templates: [{ key: 'DEFAULT_MFN', name: 'DEFAULT MFN USE THIS ONE' }],
  marketplaceId: 'ATVPDKIKX0DER',
  fetchedAt: new Date().toISOString(),
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfn-template-push-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE merchant_listings (
      sku TEXT NOT NULL,
      asin TEXT,
      quantity INTEGER,
      list_price_cents INTEGER,
      status TEXT,
      item_name TEXT,
      marketplace TEXT NOT NULL,
      last_synced TEXT
    );
    CREATE TABLE products (
      asin TEXT PRIMARY KEY,
      name TEXT
    );
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      sku TEXT,
      asin TEXT,
      list_price_cents INTEGER,
      quantity_received INTEGER,
      quantity_remaining INTEGER NOT NULL,
      inspected_at TEXT,
      merchant_shipping_group_name TEXT,
      date_purchased TEXT NOT NULL
    );
    CREATE TABLE mfn_push_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pushed_at TEXT NOT NULL,
      sku TEXT NOT NULL,
      asin TEXT,
      il_id INTEGER,
      proposed_qty INTEGER,
      proposed_price_cents INTEGER,
      proposed_shipping_template TEXT,
      sp_api_status TEXT,
      sp_api_submission_id TEXT,
      sp_api_issues TEXT,
      error_message TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO settings (key, value) VALUES
      ('clientId', 'test-client'),
      ('clientSecret', 'test-secret'),
      ('refreshToken', 'test-refresh'),
      ('marketplaceId', 'ATVPDKIKX0DER'),
      ('amazon_seller_id', 'SELLER123');
    INSERT INTO settings (key, value) VALUES
      ('amazon_shipping_templates', '${JSON.stringify(templateCache).replaceAll("'", "''")}');

    INSERT INTO merchant_listings
      (sku, asin, quantity, list_price_cents, status, item_name, marketplace)
    VALUES
      ('MFN-TEMPLATE', 'B000000001', 0, 2500, 'Inactive', 'Template lot', 'amazon');

    INSERT INTO inventory_ledger
      (id, sku, asin, list_price_cents, quantity_received, quantity_remaining,
       inspected_at, merchant_shipping_group_name, date_purchased)
    VALUES
      (1, 'MFN-TEMPLATE', 'B000000001', 2500, 1, 1, NULL, 'DEFAULT_MFN', '2026-07-01T00:00:00Z');
  `);
  db.close();
  return dir;
}

function makeBatchFixture(templateValue = 'DEFAULT_MFN'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfn-template-batch-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE listing_batches (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      channel TEXT NOT NULL,
      marketplace TEXT,
      inbound_plan_id TEXT,
      inbound_operation_id TEXT,
      plan_status TEXT,
      send_error TEXT,
      sent_at TEXT,
      ship_from_name TEXT,
      ship_from_address_line1 TEXT,
      ship_from_city TEXT,
      ship_from_state TEXT,
      ship_from_postal_code TEXT,
      ship_from_country_code TEXT,
      ship_from_phone TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE listing_batch_items (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL,
      asin TEXT,
      sku TEXT NOT NULL,
      product_name TEXT,
      condition TEXT,
      quantity INTEGER NOT NULL,
      list_price_cents INTEGER,
      listing_mode TEXT,
      inventory_ledger_id INTEGER,
      listing_status TEXT,
      listing_submission_id TEXT,
      listing_error TEXT,
      listing_updated_at TEXT,
      fnsku TEXT
    );
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      merchant_shipping_group_name TEXT
    );

    INSERT INTO settings (key, value) VALUES
      ('clientId', 'test-client'),
      ('clientSecret', 'test-secret'),
      ('refreshToken', 'test-refresh'),
      ('marketplaceId', 'ATVPDKIKX0DER'),
      ('amazon_seller_id', 'SELLER123'),
      ('amazon_shipping_templates', '{"templates":[{"key":"DEFAULT_MFN","name":"DEFAULT MFN USE THIS ONE"}],"marketplaceId":"ATVPDKIKX0DER","fetchedAt":"${new Date().toISOString()}"}');

    INSERT INTO listing_batches
      (id, name, status, channel, marketplace, updated_at)
    VALUES
      (1, 'MFN template batch', 'draft', 'MFN', 'ATVPDKIKX0DER', '2026-07-06T00:00:00Z');
    INSERT INTO inventory_ledger (id, merchant_shipping_group_name)
    VALUES (10, '${templateValue.replaceAll("'", "''")}');
    INSERT INTO listing_batch_items
      (id, batch_id, asin, sku, product_name, condition, quantity, list_price_cents,
       listing_mode, inventory_ledger_id)
    VALUES
      (100, 1, 'B000000002', 'NEW-MFN', 'New MFN item', 'NewItem', 2, 3999,
       'CREATE_NEW', 10);
  `);
  db.close();
  return dir;
}

test('MFN activation PATCH includes merchant_shipping_group resolved to template name', async () => {
  const dir = makeActivationFixture();
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const patchBodies: ListingsPatchBody[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.amazon.com/auth/o2/token') {
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    }
    if (url.startsWith('https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/SELLER123/MFN-TEMPLATE')) {
      patchBodies.push(JSON.parse(String(init?.body)) as ListingsPatchBody);
      return Response.json({
        sku: 'MFN-TEMPLATE',
        status: 'ACCEPTED',
        submissionId: 'submission-1',
        issues: [],
      });
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  };

  try {
    process.chdir(dir);
    const response = await pushActivation(new NextRequest(
      'http://localhost/api/data/merchant-inventory/activation-push',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skus: ['MFN-TEMPLATE'], dryRun: false, shippingTemplate: 'DEFAULT_MFN' }),
      },
    ));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.results[0].proposed_shipping_template, 'DEFAULT MFN USE THIS ONE');
    assert.equal(patchBodies.length, 1);
    assert.deepEqual(
      patchBodies[0].patches.find((patch) => patch.path === '/attributes/merchant_shipping_group'),
      {
        op: 'replace',
        path: '/attributes/merchant_shipping_group',
        value: [{ value: 'DEFAULT_MFN', marketplace_id: 'ATVPDKIKX0DER' }],
      },
    );
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MFN activation blocks stale template names before Amazon writes', async () => {
  const dir = makeActivationFixture();
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('unexpected', { status: 500 });
  };

  try {
    process.chdir(dir);
    const response = await pushActivation(new NextRequest(
      'http://localhost/api/data/merchant-inventory/activation-push',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skus: ['MFN-TEMPLATE'], dryRun: false, shippingTemplate: 'Stale Template' }),
      },
    ));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(String(body.error), /Stale Template/);
    assert.match(String(body.error), /synced Amazon shipping templates/i);
    assert.equal(fetchCalled, false);
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MFN activation fails closed when Amazon rejects merchant_shipping_group — no retry without template', async () => {
  const dir = makeActivationFixture();
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const patchBodies: ListingsPatchBody[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.amazon.com/auth/o2/token') {
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    }
    if (url.startsWith('https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/SELLER123/MFN-TEMPLATE')) {
      patchBodies.push(JSON.parse(String(init?.body)) as ListingsPatchBody);
      return Response.json({
        sku: 'MFN-TEMPLATE',
        status: 'INVALID',
        submissionId: 'submission-template-rejected',
        issues: [{
          code: '90220',
          message: 'The merchant_shipping_group value is invalid.',
          severity: 'ERROR',
          attributeNames: ['merchant_shipping_group'],
        }],
      });
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  };

  try {
    process.chdir(dir);
    const response = await pushActivation(new NextRequest(
      'http://localhost/api/data/merchant-inventory/activation-push',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skus: ['MFN-TEMPLATE'], dryRun: false }),
      },
    ));
    const body = await response.json();

    assert.equal(response.status, 200);
    // The row must stay INVALID — a live offer with the wrong shipping
    // template charges the wrong shipping. Exactly ONE Amazon write happens.
    assert.equal(body.results[0].sp_status, 'INVALID');
    const lastIssue = body.results[0].sp_issues.at(-1);
    assert.equal(lastIssue.code, 'FLIPLEDGER_TEMPLATE_REJECTED');
    assert.match(lastIssue.message, /nothing was pushed without the template/i);
    assert.equal(patchBodies.length, 1);
    assert.ok(patchBodies[0].patches.some((patch) => patch.path === '/attributes/merchant_shipping_group'));
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createOrUpdateListing fails closed on template-rejection PUT error — no retry without template', async () => {
  const originalFetch = globalThis.fetch;
  const putBodies: ListingsPutBody[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.amazon.com/auth/o2/token') {
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    }
    if (url.startsWith('https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/SELLER123/NEW-MFN')) {
      putBodies.push(JSON.parse(String(init?.body)) as ListingsPutBody);
      return new Response(
        JSON.stringify({ errors: [{ code: 'InvalidInput', message: 'merchant_shipping_group is invalid' }] }),
        { status: 400 },
      );
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  };

  try {
    const result = await createOrUpdateListing(
      { clientId: 'c', clientSecret: 's', refreshToken: 'r', marketplaceId: 'ATVPDKIKX0DER' },
      'SELLER123',
      {
        sku: 'NEW-MFN',
        asin: 'B000000002',
        condition: 'NewItem',
        quantity: 2,
        listPriceCents: 3999,
        productType: 'PRODUCT',
        channel: 'MFN',
        merchantShippingGroupName: 'DEFAULT MFN USE THIS ONE',
      },
    );

    assert.equal(result.status, 'INVALID');
    assert.equal(result.issues.at(-1).code, 'FLIPLEDGER_TEMPLATE_REJECTED');
    assert.equal(putBodies.length, 1);
    assert.ok(putBodies[0].attributes.merchant_shipping_group);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('new MFN listing PUT includes merchant_shipping_group for batch listings', async () => {
  const originalFetch = globalThis.fetch;
  const putBodies: ListingsPutBody[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.amazon.com/auth/o2/token') {
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    }
    if (url.startsWith('https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/SELLER123/NEW-MFN')) {
      putBodies.push(JSON.parse(String(init?.body)) as ListingsPutBody);
      return Response.json({
        sku: 'NEW-MFN',
        status: 'ACCEPTED',
        submissionId: 'submission-put',
        issues: [],
      });
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  };

  try {
    await createOrUpdateListing(
      {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        refreshToken: 'test-refresh',
        marketplaceId: 'ATVPDKIKX0DER',
      },
      'SELLER123',
      {
        sku: 'NEW-MFN',
        asin: 'B000000002',
        condition: 'NewItem',
        quantity: 2,
        listPriceCents: 3999,
        channel: 'MFN',
        productType: 'PRODUCT',
        merchantShippingGroupName: 'DEFAULT MFN USE THIS ONE',
        merchantShippingGroupValue: 'DEFAULT_MFN', // enum key Amazon requires
      },
    );

    // Amazon requires the enum KEY, not the display name (error 90244).
    assert.equal(putBodies.length, 1);
    assert.deepEqual(putBodies[0].attributes.merchant_shipping_group, [
      { value: 'DEFAULT_MFN', marketplace_id: 'ATVPDKIKX0DER' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MFN batch send validates lot template and sends merchant_shipping_group for new listings', async () => {
  const dir = makeBatchFixture();
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const putBodies: ListingsPutBody[] = [];
  let listingGetCount = 0;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    if (url === 'https://api.amazon.com/auth/o2/token') {
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    }
    if (url.startsWith('https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/SELLER123/NEW-MFN')) {
      if (method === 'PUT') {
        putBodies.push(JSON.parse(String(init?.body)) as ListingsPutBody);
        return Response.json({
          sku: 'NEW-MFN',
          status: 'ACCEPTED',
          submissionId: 'submission-put',
          issues: [],
        });
      }
      listingGetCount += 1;
      if (listingGetCount === 1) {
        return new Response('not found', { status: 404 });
      }
      return Response.json({
        summaries: [{ status: ['BUYABLE'] }],
        issues: [],
      });
    }
    if (url.startsWith('https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/B000000002')) {
      return Response.json({ productTypes: [{ productType: 'PRODUCT' }] });
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  };

  try {
    process.chdir(dir);
    const response = await sendBatch(
      new NextRequest('http://localhost/api/list/batches/1/send', { method: 'POST' }),
      { params: Promise.resolve({ id: '1' }) },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(putBodies.length, 1);
    assert.deepEqual(putBodies[0].attributes.merchant_shipping_group, [
      { value: 'DEFAULT_MFN', marketplace_id: 'ATVPDKIKX0DER' },
    ]);
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
