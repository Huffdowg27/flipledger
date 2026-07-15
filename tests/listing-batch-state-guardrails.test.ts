import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { DELETE, PATCH } from '../src/app/api/list/batches/[id]/route';
import {
  getTimeoutFailureMessage,
  manualBatchTransitionError,
  shouldTimeoutAdvanceBatch,
} from '../src/lib/listing-batch-lifecycle';

interface FixtureOptions {
  status?: string;
  channel?: 'FBA' | 'MFN';
  inboundPlanId?: string | null;
  sentAt?: string | null;
  itemListingStatus?: string | null;
  itemSubmissionId?: string | null;
  itemFnsku?: string | null;
}

function makeFixture(options: FixtureOptions = {}): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-state-guardrails-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const dbPath = path.join(dir, 'data', 'flipledger.db');
  const db = new Database(dbPath);
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
      packing_operation_id TEXT,
      packing_option_id TEXT,
      packing_group_id TEXT,
      packing_status TEXT,
      packing_confirmed_at TEXT,
      packing_error TEXT,
      placement_operation_id TEXT,
      placement_option_id TEXT,
      placement_status TEXT,
      placement_fee_cents INTEGER,
      placement_confirmed_at TEXT,
      placement_error TEXT,
      transportation_operation_id TEXT,
      transportation_option_id TEXT,
      transportation_status TEXT,
      confirmed_shipment_ids TEXT,
      notes TEXT,
      closed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE listing_batch_items (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL,
      asin TEXT,
      sku TEXT NOT NULL,
      msku TEXT,
      product_name TEXT,
      image_url TEXT,
      condition TEXT,
      quantity INTEGER NOT NULL,
      list_price_cents INTEGER,
      buy_price_cents INTEGER,
      supplier TEXT,
      purchase_date TEXT,
      estimated_fee_cents INTEGER,
      estimated_ship_cents INTEGER,
      listing_mode TEXT,
      inventory_ledger_id INTEGER,
      created_lot INTEGER,
      listing_status TEXT,
      listing_submission_id TEXT,
      listing_error TEXT,
      listing_updated_at TEXT,
      labels_printed_at TEXT,
      created_at TEXT NOT NULL,
      fnsku TEXT
    );
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      sku TEXT,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL
    );
    CREATE TABLE listing_batch_boxes (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL
    );
    CREATE TABLE listing_batch_box_items (
      id INTEGER PRIMARY KEY,
      box_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL
    );
    CREATE TABLE listing_batch_pack_groups (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL
    );
    CREATE TABLE listing_batch_pack_group_items (
      id INTEGER PRIMARY KEY,
      pack_group_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO listing_batches (
      id, name, status, channel, inbound_plan_id, sent_at, created_at, updated_at
    ) VALUES (
      1, 'Guardrail fixture', ?, ?, ?, ?,
      '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
    )
  `).run(
    options.status || 'failed',
    options.channel || 'FBA',
    options.inboundPlanId ?? null,
    options.sentAt ?? null,
  );
  if (
    options.itemListingStatus !== undefined
    || options.itemSubmissionId !== undefined
    || options.itemFnsku !== undefined
  ) {
    db.prepare(`
      INSERT INTO listing_batch_items (
        id, batch_id, sku, quantity, listing_mode, created_lot,
        listing_status, listing_submission_id, fnsku, created_at
      ) VALUES (
        10, 1, 'SKU-1', 1, 'REPLENISH_EXISTING', 0, ?, ?, ?,
        '2026-07-06T00:00:00Z'
      )
    `).run(
      options.itemListingStatus ?? null,
      options.itemSubmissionId ?? null,
      options.itemFnsku ?? null,
    );
  }
  db.prepare("UPDATE listing_batches SET marketplace = 'ATVPDKIKX0DER' WHERE id = 1").run();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES
      ('clientId', 'test-client'),
      ('clientSecret', 'test-secret'),
      ('refreshToken', 'test-refresh'),
      ('marketplaceId', 'ATVPDKIKX0DER'),
      ('amazon_seller_id', 'SELLER123')
  `).run();
  db.close();
  return { dir, dbPath };
}

async function patchBatch(dir: string, body: Record<string, unknown>) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const response = await PATCH(
      new NextRequest('http://localhost/api/list/batches/1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: '1' }) },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

async function patchStatus(dir: string, status: string) {
  return patchBatch(dir, { status });
}

async function deleteBatch(dir: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const response = await DELETE(
      new NextRequest('http://localhost/api/list/batches/1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: '1' }) },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

async function pollBatchStatus(dir: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/list/batches/[id]/status/route');
    const response = await GET(
      new NextRequest('http://localhost/api/list/batches/1/status', { method: 'GET' }),
      { params: Promise.resolve({ id: '1' }) },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

function batchExists(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    return !!db.prepare('SELECT 1 FROM listing_batches WHERE id = 1').get();
  } finally {
    db.close();
  }
}

test('manual batch transitions allow explicit archive/restore paths only', () => {
  assert.equal(manualBatchTransitionError({
    from: 'ready',
    to: 'closed',
    channel: 'FBA',
  }), null);
  assert.equal(manualBatchTransitionError({
    from: 'closed',
    to: 'draft',
    channel: 'MFN',
  }), null);
  assert.equal(manualBatchTransitionError({
    from: 'sending',
    to: 'failed',
    channel: 'MFN',
  }), null);
  assert.match(manualBatchTransitionError({
    from: 'sending',
    to: 'failed',
    channel: 'FBA',
  }) || '', /not allowed/i);
  assert.match(manualBatchTransitionError({
    from: 'draft',
    to: 'ready',
    channel: 'FBA',
  }) || '', /not allowed/i);
  assert.match(manualBatchTransitionError({
    from: 'draft',
    to: 'closed',
    channel: 'FBA',
  }) || '', /not allowed/i);
});

test('generic batch PATCH cannot force a draft batch to ready', async () => {
  const fixture = makeFixture({ status: 'draft' });
  try {
    const result = await patchStatus(fixture.dir, 'ready');
    assert.equal(result.status, 409);
    assert.match(String(result.body.error), /not allowed/i);
    assert.equal(batchExists(fixture.dbPath), true);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('workflow identity fields cannot be overwritten through generic PATCH', async () => {
  const fixture = makeFixture({ status: 'failed', inboundPlanId: 'PLAN-1' });
  try {
    const result = await patchBatch(fixture.dir, { inboundPlanId: null });
    const db = new Database(fixture.dbPath, { readonly: true });
    const batch = db.prepare('SELECT inbound_plan_id FROM listing_batches WHERE id = 1').get();
    db.close();

    assert.equal(result.status, 400);
    assert.deepEqual(batch, { inbound_plan_id: 'PLAN-1' });
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('manual status transitions cannot be bundled with unrelated edits', async () => {
  const fixture = makeFixture({ status: 'ready', inboundPlanId: 'PLAN-1' });
  try {
    const result = await patchBatch(fixture.dir, {
      status: 'closed',
      inboundPlanId: null,
    });
    const db = new Database(fixture.dbPath, { readonly: true });
    const batch = db.prepare('SELECT status, inbound_plan_id FROM listing_batches WHERE id = 1').get();
    db.close();

    assert.equal(result.status, 400);
    assert.deepEqual(batch, { status: 'ready', inbound_plan_id: 'PLAN-1' });
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('MFN never timeout-advances before Amazon reports BUYABLE', () => {
  assert.equal(shouldTimeoutAdvanceBatch({
    status: 'sending',
    channel: 'MFN',
    elapsedMs: 24 * 60 * 60 * 1000,
    inboundPlanId: null,
    anyListingFailed: false,
    operationFailed: false,
  }), false);
});

test('MFN sending timeout fails the batch with unverified SKU detail', () => {
  const message = getTimeoutFailureMessage({
    status: 'sending',
    channel: 'MFN',
    elapsedMs: 121 * 60 * 1000,
    unverifiedSkus: ['SKU-1'],
    anyListingFailed: false,
    operationFailed: false,
  });
  assert.match(message || '', /SKU-1/);
  assert.match(message || '', /BUYABLE/);
});

test('MFN under the sending timeout remains in sending', () => {
  assert.equal(getTimeoutFailureMessage({
    status: 'sending',
    channel: 'MFN',
    elapsedMs: 119 * 60 * 1000,
    unverifiedSkus: ['SKU-1'],
    anyListingFailed: false,
    operationFailed: false,
  }), null);
});

test('FBA can retain its inbound-plan timeout fallback', () => {
  assert.equal(shouldTimeoutAdvanceBatch({
    status: 'sending',
    channel: 'FBA',
    elapsedMs: 16 * 60 * 1000,
    inboundPlanId: 'PLAN-1',
    anyListingFailed: false,
    operationFailed: false,
  }), true);
  assert.equal(getTimeoutFailureMessage({
    status: 'sending',
    channel: 'FBA',
    elapsedMs: 24 * 60 * 60 * 1000,
    unverifiedSkus: ['SKU-1'],
    anyListingFailed: false,
    operationFailed: false,
  }), null);
});

test('MFN status polling fails timed-out batches without marking listings active', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = makeFixture({
    status: 'sending',
    channel: 'MFN',
    sentAt: new Date(Date.now() - 121 * 60 * 1000).toISOString(),
    itemListingStatus: 'PROCESSING',
  });
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
    if (url.startsWith('https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/SELLER123/SKU-1')) {
      return Response.json({
        summaries: [{ status: ['DISCOVERABLE'] }],
        issues: [{ severity: 'ERROR', message: 'Price alert' }],
      });
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  };

  try {
    const result = await pollBatchStatus(fixture.dir);
    const db = new Database(fixture.dbPath, { readonly: true });
    const batch = db.prepare(`
      SELECT status, send_error AS sendError
      FROM listing_batches WHERE id = 1
    `).get() as { status: string; sendError: string | null };
    const item = db.prepare(`
      SELECT listing_status AS listingStatus, listing_error AS listingError
      FROM listing_batch_items WHERE id = 10
    `).get() as { listingStatus: string; listingError: string | null };
    db.close();

    assert.equal(result.status, 200);
    assert.equal(result.body.batch.status, 'failed');
    assert.equal(batch.status, 'failed');
    assert.match(batch.sendError || '', /SKU-1/);
    assert.match(batch.sendError || '', /BUYABLE/);
    assert.equal(item.listingStatus, 'PROCESSING');
    assert.equal(result.body.items[0].listingStatus, 'PROCESSING');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('delete fails closed after any listing submission was accepted', async () => {
  const fixture = makeFixture({
    status: 'failed',
    itemListingStatus: 'PROCESSING',
    itemSubmissionId: 'submission-1',
  });
  try {
    const result = await deleteBatch(fixture.dir);
    assert.equal(result.status, 409);
    assert.match(String(result.body.error), /partially succeeded|Amazon state/i);
    assert.equal(batchExists(fixture.dbPath), true);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('draft replenishment item with prefilled fnsku remains deletable before submission', async () => {
  const fixture = makeFixture({
    status: 'draft',
    itemFnsku: 'X00FNSKU',
  });
  try {
    const result = await deleteBatch(fixture.dir);
    assert.equal(result.status, 200);
    assert.equal(batchExists(fixture.dbPath), false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('delete fails closed after an inbound plan was created', async () => {
  const fixture = makeFixture({
    status: 'failed',
    inboundPlanId: 'PLAN-1',
  });
  try {
    const result = await deleteBatch(fixture.dir);
    assert.equal(result.status, 409);
    assert.match(String(result.body.error), /partially succeeded|Amazon state/i);
    assert.equal(batchExists(fixture.dbPath), true);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('failed batches with no remote success evidence remain deletable', async () => {
  const fixture = makeFixture({ status: 'failed' });
  try {
    const result = await deleteBatch(fixture.dir);
    assert.equal(result.status, 200);
    assert.equal(batchExists(fixture.dbPath), false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
