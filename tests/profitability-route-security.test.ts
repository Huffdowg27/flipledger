import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

function makeEmptyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profitability-route-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.close();
  return dir;
}

function makeAccountingFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profitability-accounting-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,
      marketplace TEXT
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id TEXT,
      asin TEXT,
      sku TEXT,
      quantity INTEGER,
      total_price INTEGER,
      shipping_charged INTEGER,
      shipping_cost INTEGER,
      cogs_per_unit INTEGER
    );
    CREATE TABLE financial_events (
      id INTEGER PRIMARY KEY,
      order_id TEXT,
      posted_date TEXT,
      event_type TEXT,
      raw_data TEXT
    );
    CREATE TABLE fee_details (
      id INTEGER PRIMARY KEY,
      order_id TEXT,
      financial_event_id INTEGER,
      amount INTEGER
    );
    CREATE TABLE refunds (
      id INTEGER PRIMARY KEY,
      order_id TEXT,
      asin TEXT,
      sku TEXT,
      quantity INTEGER,
      refund_date TEXT,
      disposition TEXT,
      item_returned INTEGER,
      marketplace TEXT
    );
    CREATE TABLE products (
      asin TEXT,
      name TEXT,
      category TEXT
    );
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      asin TEXT,
      sku TEXT,
      supplier_id INTEGER,
      buy_price INTEGER
    );
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE storage_fees_per_asin (
      asin TEXT PRIMARY KEY,
      monthly_fee INTEGER,
      size_tier TEXT,
      updated_at TEXT
    );
    CREATE TABLE live_inventory (
      sku TEXT,
      asin TEXT,
      fulfillable_qty INTEGER,
      inbound_qty INTEGER
    );
    CREATE TABLE merchant_listings (
      sku TEXT,
      asin TEXT,
      quantity INTEGER,
      fulfillment_channel TEXT
    );
    CREATE TABLE dispositions (
      id INTEGER PRIMARY KEY,
      disp_date TEXT NOT NULL,
      msku TEXT,
      asin TEXT,
      buy_cost_adj INTEGER NOT NULL
    );

    INSERT INTO orders VALUES ('O1', 'amazon'), ('O2', 'amazon');
    INSERT INTO financial_events VALUES
      (1, 'O1', '2026-06-10T12:00:00Z', 'ShipmentEvent', NULL),
      (2, 'O2', '2026-06-11T12:00:00Z', 'ShipmentEvent', NULL),
      (3, 'O1', '2026-06-15T12:00:00Z', 'RefundEvent', NULL);
    INSERT INTO order_items VALUES
      (1, 'O1', 'A1', 'LV_1000_S1', 2, 4000, 200, 300, 1000),
      (2, 'O1', 'A2', 'LV_1500_S2', 1, 3000, 0, 0, 1500),
      (3, 'O2', 'A3', 'amzn.gr.LV_2000_S3', 1, 1000, 0, 0, 2000);
    INSERT INTO fee_details VALUES
      (1, 'O1', 1, -700),
      (2, 'O2', 2, -300),
      (3, 'O1', 3, 100);
    INSERT INTO refunds VALUES
      (1, 'O1', 'A1', 'LV_1000_S1', 1, '2026-06-15T12:00:00Z', 'SELLABLE', 1, 'amazon'),
      (2, 'O3', 'A4', 'UNMATCHED-SKU', 1, '2026-06-20T12:00:00Z', 'DAMAGED', 1, 'amazon');
    INSERT INTO products VALUES
      ('A1', 'Product one', 'Category one'),
      ('A2', 'Product two', NULL);
    INSERT INTO suppliers VALUES (1, 'Fixture supplier');
    INSERT INTO inventory_ledger VALUES
      (1, 'A1', 'LV_1000_S1', 1, 1000),
      (2, 'A1', 'LV_1000_S1', 1, 1000),
      (3, 'A2', 'LV_1500_S2', 1, 1500),
      (4, 'A3', 'amzn.gr.LV_2000_S3', 1, 2000);
    INSERT INTO dispositions VALUES
      (1, '2026-06-18', 'LV_1000_S1', 'A1', 400);
  `);
  db.close();
  return dir;
}

async function callProfitabilityRoute(dir: string, query: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/profitability/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/profitability?${query}`));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

test('Profitability rejects SQL-shaped marketplaces before querying the database', async () => {
  const dir = makeEmptyFixture();
  try {
    const { response, body } = await callProfitabilityRoute(
      dir,
      `startDate=2026-06-01&endDate=2026-06-30&marketplace=${encodeURIComponent(`amazon' OR 1=1 --`)}`,
    );
    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid marketplace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Profitability rejects invalid dates and fallback-day windows before querying the database', async () => {
  const dir = makeEmptyFixture();
  try {
    const impossible = await callProfitabilityRoute(
      dir,
      'startDate=2026-06-01&endDate=2026-06-31',
    );
    assert.equal(impossible.response.status, 400);
    assert.equal(impossible.body.error, 'Invalid date range');

    const days = await callProfitabilityRoute(dir, 'days=-30');
    assert.equal(days.response.status, 400);
    assert.equal(days.body.error, 'Invalid days');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Profitability rejects unknown grouping dimensions before querying the database', async () => {
  const dir = makeEmptyFixture();
  try {
    const { response, body } = await callProfitabilityRoute(
      dir,
      'startDate=2026-06-01&endDate=2026-06-30&groupBy=order_id',
    );
    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid group');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Profitability totals are invariant across grouping dimensions and use recognized COGS', async () => {
  const dir = makeAccountingFixture();
  try {
    const totals = [];
    for (const groupBy of ['asin', 'sku', 'supplier', 'category']) {
      const { response, body } = await callProfitabilityRoute(
        dir,
        `startDate=2026-06-01&endDate=2026-06-30&groupBy=${groupBy}`,
      );
      assert.equal(response.status, 200);
      totals.push(body.totals);
    }

    for (const total of totals) {
      assert.equal(total.orders, 2);
      assert.equal(total.unitsSold, 4);
      assert.equal(total.revenue, 8000);
      assert.equal(total.cogs, 2100);
      assert.equal(total.fees, 1000);
      assert.equal(total.shippingCost, 300);
      assert.equal(total.shippingCharged, 200);
      assert.equal(total.profit, 4800);
      assert.equal(total.refunds, 2);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
