import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

test('inventory valuation rejects unsafe marketplace before database queries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valuation-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.close();
  const previous = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/inventory-valuation/route');
    const marketplace = encodeURIComponent(`amazon' OR 1=1 --`);
    const response = await GET(new NextRequest(`http://localhost/api/data/inventory-valuation?marketplace=${marketplace}`));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid marketplace' });
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inventory valuation includes merchant-fulfilled open lots without double counting live SKUs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valuation-mfn-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE live_inventory (
      id INTEGER PRIMARY KEY,
      asin TEXT NOT NULL,
      sku TEXT,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      fulfillable_qty INTEGER NOT NULL DEFAULT 0,
      inbound_qty INTEGER NOT NULL DEFAULT 0,
      reserved_qty INTEGER NOT NULL DEFAULT 0,
      unfulfillable_qty INTEGER NOT NULL DEFAULT 0,
      total_qty INTEGER NOT NULL DEFAULT 0,
      product_name TEXT,
      last_updated TEXT NOT NULL,
      inbound_working INTEGER DEFAULT 0,
      inbound_shipped INTEGER DEFAULT 0,
      inbound_receiving INTEGER DEFAULT 0,
      reserved_customer_order INTEGER DEFAULT 0,
      reserved_fc_transfer INTEGER DEFAULT 0,
      reserved_fc_processing INTEGER DEFAULT 0,
      list_price INTEGER DEFAULT 0,
      walmart_item_id TEXT
    );
    CREATE TABLE merchant_listings (
      id INTEGER PRIMARY KEY,
      asin TEXT NOT NULL,
      sku TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      status TEXT,
      quantity INTEGER,
      product_name TEXT,
      condition TEXT,
      list_price_cents INTEGER,
      last_synced TEXT NOT NULL,
      fulfillment_channel TEXT
    );
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      asin TEXT NOT NULL,
      sku TEXT,
      buy_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL,
      date_purchased TEXT NOT NULL
    );
    CREATE TABLE products (
      asin TEXT PRIMARY KEY,
      name TEXT,
      category TEXT,
      marketplace TEXT DEFAULT 'amazon',
      walmart_item_id TEXT
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      price_per_unit INTEGER NOT NULL,
      total_price INTEGER NOT NULL
    );
    CREATE TABLE fee_details (
      id INTEGER PRIMARY KEY,
      order_id TEXT,
      asin TEXT,
      amount INTEGER,
      posted_date TEXT
    );
    CREATE TABLE sales_rank_history (
      asin TEXT,
      marketplace TEXT,
      rank INTEGER,
      category TEXT,
      captured_date TEXT
    );

    INSERT INTO live_inventory
      (id, asin, sku, marketplace, fulfillable_qty, inbound_qty, reserved_qty, unfulfillable_qty, total_qty, product_name, last_updated)
    VALUES
      (1, 'B000FBA001', 'FBA-SKU', 'amazon', 2, 0, 0, 0, 2, 'FBA only', '2026-07-01'),
      (2, 'B000BOTH01', 'BOTH-SKU', 'amazon', 4, 0, 0, 0, 4, 'Both channels', '2026-07-01');
    INSERT INTO merchant_listings
      (id, asin, sku, marketplace, status, quantity, product_name, last_synced, fulfillment_channel)
    VALUES
      (1, 'B000MFN001', 'MFN-SKU', 'amazon', 'Active', 1, 'MFN only', '2026-07-01', 'DEFAULT'),
      (2, 'B000BOTH01', 'BOTH-SKU', 'amazon', 'Active', 4, 'Both channels', '2026-07-01', 'DEFAULT'),
      (3, 'B000MULTI1', 'MULTI-SKU', 'amazon', 'Active', 3, 'MFN multi lot', '2026-07-01', 'DEFAULT');
    INSERT INTO inventory_ledger
      (id, asin, sku, buy_price, quantity, quantity_remaining, date_purchased)
    VALUES
      (1, 'B000FBA001', 'FBA-SKU', 1000, 2, 2, '2026-06-01'),
      (2, 'B000BOTH01', 'BOTH-SKU', 300, 3, 3, '2026-06-01'),
      (3, 'B000MFN001', 'MFN-SKU', 800, 1, 1, '2026-06-01'),
      (4, 'B000MULTI1', 'MULTI-SKU', 500, 1, 1, '2026-06-01'),
      (5, 'B000MULTI1', 'MULTI-SKU', 700, 2, 2, '2026-06-02');
  `);
  db.close();

  const previous = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/inventory-valuation/route');
    const response = await GET(new NextRequest('http://localhost/api/data/inventory-valuation?marketplace=amazon'));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.items.length, 4);

    const bySku = new Map<string, any>(body.items.map((item: any) => [item.sku, item]));
    assert.equal(bySku.get('FBA-SKU').channel, 'FBA');
    assert.equal(bySku.get('FBA-SKU').totalCogsValue, 2000);
    assert.equal(bySku.get('BOTH-SKU').channel, 'FBA');
    assert.equal(bySku.get('BOTH-SKU').totalCogsValue, 1200);
    assert.equal(bySku.get('MFN-SKU').channel, 'MFN');
    assert.equal(bySku.get('MFN-SKU').totalCogsValue, 800);
    assert.equal(bySku.get('MULTI-SKU').channel, 'MFN');
    assert.equal(bySku.get('MULTI-SKU').quantityOnHand, 3);
    assert.equal(bySku.get('MULTI-SKU').totalCogsValue, 1900);

    assert.equal(body.totals.fba.totalCogsValue, 3200);
    assert.equal(body.totals.mfn.totalCogsValue, 2700);
    assert.equal(body.totals.totalCogsValue, 5900);
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
