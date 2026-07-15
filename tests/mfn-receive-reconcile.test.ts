import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/data/inventory-lots/create-mfn-local-lot/route';

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfn-receive-reconcile-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const dbPath = path.join(dir, 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES
      ('airtable_api_key', 'key-test'),
      ('airtable_purchases_base', 'app-test'),
      ('airtable_purchases_table', 'Orders');

    CREATE TABLE incoming_purchases (
      id INTEGER PRIMARY KEY,
      airtable_record_id TEXT,
      order_source TEXT,
      order_ref TEXT,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      quantity_received INTEGER NOT NULL DEFAULT 0,
      unit_cost_cents INTEGER NOT NULL,
      ordered_at TEXT,
      status TEXT NOT NULL,
      received_at TEXT,
      inventory_ledger_id INTEGER,
      receipt_allocation_baseline INTEGER NOT NULL DEFAULT 0,
      receipt_identity_started_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      asin TEXT,
      sku TEXT,
      buy_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL,
      quantity_received INTEGER,
      date_purchased TEXT NOT NULL,
      bin_location TEXT,
      condition TEXT,
      list_price_cents INTEGER,
      merchant_shipping_group_name TEXT,
      received_at TEXT,
      inspected_at TEXT,
      batch_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE receiving_issues (
      id INTEGER PRIMARY KEY,
      incoming_purchase_id INTEGER,
      quantity INTEGER NOT NULL
    );
    CREATE TABLE incoming_receipt_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_key TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL,
      incoming_purchase_id INTEGER NOT NULL,
      inventory_ledger_id INTEGER,
      receiving_issue_id INTEGER,
      quantity_good INTEGER NOT NULL,
      quantity_issue INTEGER NOT NULL,
      sku TEXT,
      source TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      purchase_date TEXT NOT NULL
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL,
      sku TEXT,
      asin TEXT,
      quantity INTEGER NOT NULL,
      cogs_per_unit INTEGER
    );
    CREATE TABLE refunds (
      id INTEGER PRIMARY KEY,
      order_id TEXT,
      sku TEXT,
      asin TEXT,
      quantity INTEGER NOT NULL,
      refund_date TEXT,
      marketplace TEXT,
      disposition TEXT,
      item_returned INTEGER,
      inventory_restored_quantity INTEGER,
      inventory_restore_error TEXT,
      inventory_restore_checked_at TEXT
    );

    INSERT INTO incoming_purchases (
      id, airtable_record_id, order_source, order_ref, asin, sku,
      quantity, quantity_received, unit_cost_cents, ordered_at, status, updated_at
    ) VALUES
      (100, 'rec100', 'Airtable', 'ORDER-100', 'B000MFN001', 'MFN-SKU-1', 2, 0, 1200, '2026-07-08', 'on_order', '2026-07-08T00:00:00Z'),
      (200, 'rec200', 'Airtable', 'ORDER-200', 'B000MFN002', 'MFN-SKU-2', 1, 0, 1400, '2026-07-08', 'on_order', '2026-07-08T00:00:00Z'),
      (201, 'rec201', 'Airtable', 'ORDER-201', 'B000MFN002', 'MFN-SKU-2B', 1, 0, 1500, '2026-07-09', 'on_order', '2026-07-09T00:00:00Z');
  `);
  db.close();
  return { dir, dbPath };
}

async function createMfnLot(dir: string, body: Record<string, unknown>) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const response = await POST(new NextRequest('http://localhost/api/data/inventory-lots/create-mfn-local-lot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    process.chdir(previousCwd);
  }
}

function readState(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      lots: db.prepare(`
        SELECT id, asin, sku, quantity, quantity_remaining, quantity_received,
               date_purchased, received_at
        FROM inventory_ledger ORDER BY id
      `).all(),
      purchases: db.prepare(`
        SELECT id, quantity_received, status, inventory_ledger_id, received_at
        FROM incoming_purchases ORDER BY id
      `).all(),
      allocations: db.prepare(`
        SELECT receipt_key, incoming_purchase_id, inventory_ledger_id,
               quantity_good, quantity_issue, source
        FROM incoming_receipt_allocations ORDER BY id
      `).all(),
    };
  } finally {
    db.close();
  }
}

test('confirmed MFN receive reconciles the buy-sheet row without duplicating inventory', async () => {
  const fixture = makeFixture();
  const originalFetch = globalThis.fetch;
  const writes: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    writes.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response('{}', { status: 200 });
  };
  try {
    const result = await createMfnLot(fixture.dir, {
      sku: 'MFN-SKU-1',
      asin: 'B000MFN001',
      quantity: 2,
      buyCents: 1200,
      markReceived: true,
      markInspected: true,
      incomingPurchaseId: 100,
      expectedQuantityReceived: 0,
      receiptKey: 'mfn-confirmed-100',
    });
    const state = readState(fixture.dbPath);

    assert.equal(result.status, 200);
    assert.equal(result.body.created, true);
    assert.equal((result.body.incomingReconcile as { airtableSynced: boolean }).airtableSynced, true);
    assert.equal(state.lots.length, 1);
    assert.deepEqual(state.lots[0], {
      id: 1,
      asin: 'B000MFN001',
      sku: 'MFN-SKU-1',
      quantity: 2,
      quantity_remaining: 2,
      quantity_received: 2,
      date_purchased: '2026-07-08',
      received_at: (state.lots[0] as { received_at: string }).received_at,
    });
    assert.deepEqual(state.purchases[0], {
      id: 100,
      quantity_received: 2,
      status: 'received',
      inventory_ledger_id: 1,
      received_at: (state.purchases[0] as { received_at: string }).received_at,
    });
    assert.deepEqual(state.allocations, [{
      receipt_key: 'mfn-confirmed-100',
      incoming_purchase_id: 100,
      inventory_ledger_id: 1,
      quantity_good: 2,
      quantity_issue: 0,
      source: 'operator_reconciliation',
    }]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, 'https://api.airtable.com/v0/app-test/Orders/rec100');
    assert.deepEqual(writes[0].body, { fields: { Received: 2 } });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('ambiguous open incoming rows do not auto-link without operator confirmation', async () => {
  const fixture = makeFixture();
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  };
  try {
    const result = await createMfnLot(fixture.dir, {
      sku: 'MFN-SKU-2',
      asin: 'B000MFN002',
      quantity: 1,
      buyCents: 1400,
      markReceived: true,
      markInspected: true,
    });
    const state = readState(fixture.dbPath);

    assert.equal(result.status, 200);
    assert.equal(state.lots.length, 1);
    assert.equal(state.allocations.length, 0);
    assert.equal((state.purchases[1] as { quantity_received: number }).quantity_received, 0);
    assert.equal((state.purchases[2] as { quantity_received: number }).quantity_received, 0);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('re-confirming the same MFN receipt replays without a duplicate lot or Airtable write', async () => {
  const fixture = makeFixture();
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async () => {
    writes++;
    return new Response('{}', { status: 200 });
  };
  const request = {
    sku: 'MFN-SKU-1',
    asin: 'B000MFN001',
    quantity: 2,
    buyCents: 1200,
    markReceived: true,
    markInspected: true,
    incomingPurchaseId: 100,
    expectedQuantityReceived: 0,
    receiptKey: 'mfn-replay-100',
  };
  try {
    const first = await createMfnLot(fixture.dir, request);
    const replay = await createMfnLot(fixture.dir, request);
    const state = readState(fixture.dbPath);

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal((replay.body.incomingReconcile as { replayed: boolean }).replayed, true);
    assert.equal(state.lots.length, 1);
    assert.equal(state.allocations.length, 1);
    assert.equal((state.purchases[0] as { quantity_received: number }).quantity_received, 2);
    assert.equal(writes, 1);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
