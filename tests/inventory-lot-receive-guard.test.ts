import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { PATCH } from '../src/app/api/data/inventory-lots/route';

function makeFixture(quantity = 5, quantityReceived = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-lot-receive-guard-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const dbPath = path.join(dir, 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      sku TEXT,
      asin TEXT,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL,
      quantity_received INTEGER,
      received_at TEXT,
      inspected_at TEXT,
      receive_notes TEXT,
      list_price_cents INTEGER,
      merchant_shipping_group_name TEXT,
      buy_price INTEGER NOT NULL,
      date_purchased TEXT,
      notes TEXT,
      bin_location TEXT,
      condition TEXT,
      supplier_id INTEGER
    );
    CREATE TABLE suppliers (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE,
      created_at TEXT
    );
  `);
  db.prepare(`
    INSERT INTO inventory_ledger (
      id, sku, asin, quantity, quantity_remaining, quantity_received,
      buy_price, date_purchased
    ) VALUES (1, 'SKU-1', 'ASIN-1', ?, ?, ?, 1000, '2026-07-01')
  `).run(quantity, quantity, quantityReceived);
  db.close();
  return { dir, dbPath };
}

async function patchLot(
  dir: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const response = await PATCH(new NextRequest('http://localhost/api/data/inventory-lots', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, ...body }),
    }));
    return { status: response.status, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

function lotState(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT quantity, quantity_received AS quantityReceived
      FROM inventory_ledger WHERE id = 1
    `).get();
  } finally {
    db.close();
  }
}

test('inventory lot receive rejects counts above the purchased quantity', async () => {
  const fixture = makeFixture();
  try {
    const result = await patchLot(fixture.dir, { quantityReceived: 6 });

    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /cannot exceed|purchased quantity/i);
    assert.deepEqual(lotState(fixture.dbPath), { quantity: 5, quantityReceived: 2 });
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('inventory lot quantity cannot be reduced below units already received', async () => {
  const fixture = makeFixture(5, 4);
  try {
    const result = await patchLot(fixture.dir, { quantity: 3 });

    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /cannot exceed|purchased quantity/i);
    assert.deepEqual(lotState(fixture.dbPath), { quantity: 5, quantityReceived: 4 });
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('inventory lot receive allows the exact purchased quantity', async () => {
  const fixture = makeFixture();
  try {
    const result = await patchLot(fixture.dir, { quantityReceived: 5 });

    assert.equal(result.status, 200);
    assert.deepEqual(lotState(fixture.dbPath), { quantity: 5, quantityReceived: 5 });
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
