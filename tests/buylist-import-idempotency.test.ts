import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/list/batches/[id]/import/route';

const CSV = [
  'ASIN,MSKU,Product Name,Quantity,Cost,List Price,Purchase Date',
  'B000000001,SKU-IMPORT-1,Imported item,2,12.00,30.00,2026-07-01',
].join('\n');

const TWO_ROW_CSV = [
  'ASIN,MSKU,Product Name,Quantity,Cost,List Price,Purchase Date',
  'B000000001,SKU-IMPORT-1,Imported item,2,12.00,30.00,2026-07-01',
  'B000000002,SKU-IMPORT-2,Rejected item,1,10.00,25.00,2026-07-01',
].join('\n');

const REVERSED_TWO_ROW_CSV = [
  'ASIN,MSKU,Product Name,Quantity,Cost,List Price,Purchase Date',
  'B000000002,SKU-IMPORT-2,Rejected item,1,10.00,25.00,2026-07-01',
  'B000000001,SKU-IMPORT-1,Imported item,2,12.00,30.00,2026-07-01',
].join('\n');

function makeFixture(
  channel: 'MFN' | 'FBA',
  options: { rejectSecondLot?: boolean } = {},
): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buylist-import-idempotency-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const dbPath = path.join(dir, 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE listing_batches (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT,
      sku TEXT,
      name TEXT,
      marketplace TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE listing_batch_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      rows_imported INTEGER NOT NULL,
      total_units INTEGER NOT NULL,
      total_cost_cents INTEGER NOT NULL,
      total_list_value_cents INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(batch_id, content_hash)
    );
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT,
      sku TEXT,
      buy_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL,
      supplier_id INTEGER,
      date_purchased TEXT NOT NULL,
      bin_location TEXT,
      condition TEXT,
      list_price_cents INTEGER,
      merchant_shipping_group_name TEXT,
      received_at TEXT,
      inspected_at TEXT,
      quantity_received INTEGER,
      batch_id INTEGER,
      listing_batch_import_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE listing_batch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      asin TEXT NOT NULL,
      sku TEXT NOT NULL,
      msku TEXT,
      product_name TEXT,
      image_url TEXT,
      condition TEXT,
      quantity INTEGER NOT NULL,
      list_price_cents INTEGER NOT NULL,
      buy_price_cents INTEGER NOT NULL,
      supplier TEXT,
      purchase_date TEXT,
      estimated_fee_cents INTEGER,
      estimated_ship_cents INTEGER,
      listing_mode TEXT,
      fnsku TEXT,
      fulfillment_channel TEXT,
      listing_source TEXT,
      amazon_inventory_status TEXT,
      inventory_ledger_id INTEGER,
      listing_batch_import_id INTEGER,
      created_at TEXT NOT NULL
    );
    INSERT INTO listing_batches (id, channel, status, updated_at)
    VALUES (1, '${channel}', 'draft', '2026-07-01T00:00:00Z');
  `);
  if (options.rejectSecondLot) {
    db.exec(`
      CREATE TRIGGER reject_second_import_lot
      BEFORE INSERT ON inventory_ledger
      WHEN NEW.sku = 'SKU-IMPORT-2'
      BEGIN
        SELECT RAISE(ABORT, 'fixture rejects second lot');
      END;
    `);
  }
  db.close();
  return { dir, dbPath };
}

async function importCsv(
  dir: string,
  csv = CSV,
  decisions?: Record<string, { mode?: string; skip?: boolean }>,
) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const response = await POST(
      new NextRequest('http://localhost/api/list/batches/1/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv, decisions }),
      }),
      { params: Promise.resolve({ id: '1' }) },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

function importState(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      imports: db.prepare(`
        SELECT id, batch_id, rows_imported, total_units, total_cost_cents
        FROM listing_batch_imports ORDER BY id
      `).all(),
      lots: db.prepare(`
        SELECT sku, quantity, listing_batch_import_id
        FROM inventory_ledger ORDER BY id
      `).all(),
      items: db.prepare(`
        SELECT sku, quantity, listing_batch_import_id
        FROM listing_batch_items ORDER BY id
      `).all(),
    };
  } finally {
    db.close();
  }
}

for (const channel of ['MFN', 'FBA'] as const) {
  test(`replaying the same ${channel} buy-list import creates inventory once`, async () => {
    const fixture = makeFixture(channel);
    try {
      const first = await importCsv(fixture.dir);
      const replay = await importCsv(fixture.dir);

      assert.equal(first.status, 200);
      assert.equal(replay.status, 200);
      assert.equal(first.body.replayed, false);
      assert.equal(replay.body.replayed, true);
      assert.deepEqual(importState(fixture.dbPath), {
        imports: [{
          id: 1,
          batch_id: 1,
          rows_imported: 1,
          total_units: 2,
          total_cost_cents: 2400,
        }],
        lots: [{ sku: 'SKU-IMPORT-1', quantity: 2, listing_batch_import_id: 1 }],
        items: channel === 'FBA'
          ? [{ sku: 'SKU-IMPORT-1', quantity: 2, listing_batch_import_id: 1 }]
          : [],
      });
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
}

test('a failed buy-list transaction leaves no import receipt or inventory rows', async () => {
  const fixture = makeFixture('MFN', { rejectSecondLot: true });
  try {
    const result = await importCsv(fixture.dir, TWO_ROW_CSV);

    assert.equal(result.status, 500);
    assert.deepEqual(importState(fixture.dbPath), {
      imports: [],
      lots: [],
      items: [],
    });
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a successful import remains replayable after the batch leaves draft', async () => {
  const fixture = makeFixture('MFN');
  try {
    const first = await importCsv(fixture.dir);
    const db = new Database(fixture.dbPath);
    db.prepare("UPDATE listing_batches SET status = 'closed' WHERE id = 1").run();
    db.close();
    const replay = await importCsv(fixture.dir);

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(importState(fixture.dbPath).lots.length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('MFN mode changes cannot bypass normalized import identity', async () => {
  const fixture = makeFixture('MFN');
  try {
    const first = await importCsv(fixture.dir, CSV, { 0: { mode: 'CREATE_NEW' } });
    const replay = await importCsv(fixture.dir, CSV, { 0: { mode: 'REPLENISH_EXISTING' } });

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(importState(fixture.dbPath).lots.length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('row ordering cannot bypass normalized import identity', async () => {
  const fixture = makeFixture('MFN');
  try {
    const first = await importCsv(fixture.dir, TWO_ROW_CSV);
    const replay = await importCsv(fixture.dir, REVERSED_TWO_ROW_CSV);

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(importState(fixture.dbPath).imports.length, 1);
    assert.equal(importState(fixture.dbPath).lots.length, 2);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
