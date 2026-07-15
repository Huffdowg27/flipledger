import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const DAY_MS = 86400000;
function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString();
}

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asin-context-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE products (
      asin TEXT, name TEXT, image_url TEXT, upc TEXT
    );
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      asin TEXT NOT NULL,
      sku TEXT,
      buy_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL,
      bin_location TEXT,
      date_purchased TEXT NOT NULL
    );
    CREATE TABLE live_inventory (
      asin TEXT NOT NULL,
      fulfillable_qty INTEGER NOT NULL DEFAULT 0,
      inbound_qty INTEGER NOT NULL DEFAULT 0,
      reserved_qty INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE merchant_listings (
      asin TEXT NOT NULL,
      sku TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      status TEXT,
      quantity INTEGER,
      list_price_cents INTEGER
    );
    CREATE TABLE incoming_purchases (
      asin TEXT,
      quantity INTEGER NOT NULL DEFAULT 0,
      quantity_received INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'on_order'
    );
    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      purchase_date TEXT NOT NULL
    );
    CREATE TABLE order_items (
      order_id TEXT NOT NULL,
      asin TEXT,
      quantity INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      shipping_charged INTEGER DEFAULT 0
    );

    INSERT INTO settings (key, value) VALUES ('extensionApiKey', 'test-key-123');
    INSERT INTO products VALUES ('B000TEST01', 'Test Widget', 'https://img.example/w.jpg', '012345678905');

    -- Two open MFN lots + one depleted lot (history only)
    INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, bin_location, date_purchased) VALUES
      ('B000TEST01', 'SKU-A', 1000, 5, 2, 'R1C-B1-ZY', '${isoDaysAgo(20)}'),
      ('B000TEST01', 'SKU-B', 1200, 3, 1, 'R1C-B2-SY', '${isoDaysAgo(10)}'),
      ('B000TEST01', 'SKU-C', 900,  2, 0, NULL,        '${isoDaysAgo(120)}'),
      ('B000OTHER1', 'SKU-X', 5000, 9, 9, NULL,        '${isoDaysAgo(5)}');

    INSERT INTO live_inventory VALUES ('B000TEST01', 4, 6, 1);

    INSERT INTO merchant_listings (asin, sku, marketplace, status, quantity, list_price_cents) VALUES
      ('B000TEST01', 'SKU-A', 'amazon', 'Active', 2, 2999);

    -- Incoming: 10 ordered / 4 received on a partial + 3 on_order + received/cancelled noise
    INSERT INTO incoming_purchases (asin, quantity, quantity_received, status) VALUES
      ('B000TEST01', 10, 4, 'partial'),
      ('B000TEST01', 3, 0, 'on_order'),
      ('B000TEST01', 5, 5, 'received'),
      ('B000TEST01', 2, 0, 'cancelled');

    -- Sales: 2 units at 15d (in 30d window), 3 units at 60d (90d window only),
    -- 1 canceled (excluded), 1 unit at 200d (lifetime only)
    INSERT INTO orders VALUES
      ('O-15D', 'Shipped', '${isoDaysAgo(15)}'),
      ('O-60D', 'Shipped', '${isoDaysAgo(60)}'),
      ('O-CXL', 'Canceled', '${isoDaysAgo(12)}'),
      ('O-OLD', 'Shipped', '${isoDaysAgo(200)}');
    -- total_price is item-only; shipping_charged is what the buyer paid to ship.
    -- 90d window (O-15D + O-60D): item 6000+7500=13500, shipping 1000+500=1500,
    -- total 15000 over 5 units → avg sale 3000, avg shipping 300.
    INSERT INTO order_items VALUES
      ('O-15D', 'B000TEST01', 2, 6000, 1000),
      ('O-60D', 'B000TEST01', 3, 7500, 500),
      ('O-CXL', 'B000TEST01', 4, 12000, 800),
      ('O-OLD', 'B000TEST01', 1, 2000, 200);
  `);
  db.close();
  return dir;
}

async function callRoute(dir: string, url: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/extension/asin-context/route');
    const response = await GET(new NextRequest(url));
    return { status: response.status, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

const GOOD_URL = 'http://localhost/api/extension/asin-context?asin=B000TEST01';
const KEY_HEADER = 'x-flipledger-extension-key';

test('asin-context rejects missing and wrong extension keys', async () => {
  const dir = makeFixture();
  try {
    const previousCwd = process.cwd();
    process.chdir(dir);
    const { GET } = await import('../src/app/api/extension/asin-context/route');
    try {
      const noKey = await GET(new NextRequest(GOOD_URL));
      assert.equal(noKey.status, 401);
      const wrongKey = await GET(new NextRequest(GOOD_URL, { headers: { [KEY_HEADER]: 'nope' } }));
      assert.equal(wrongKey.status, 401);
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('asin-context rejects malformed ASINs before touching auth data', async () => {
  const dir = makeFixture();
  try {
    const { status } = await callRoute(dir, 'http://localhost/api/extension/asin-context?asin=notanasin!');
    assert.equal(status, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('asin-context aggregates on-hand, incoming, purchases, and sales correctly', async () => {
  const dir = makeFixture();
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/extension/asin-context/route');
    const response = await GET(new NextRequest(GOOD_URL, { headers: { [KEY_HEADER]: 'test-key-123' } }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.product.name, 'Test Widget');

    // On hand: open lots 2+1; FBA 4/6/1; one active listing
    assert.equal(body.onHand.mfnUnits, 3);
    assert.equal(body.onHand.mfnLots.length, 2);
    assert.equal(body.onHand.fbaFulfillable, 4);
    assert.equal(body.onHand.fbaInbound, 6);
    assert.equal(body.onHand.fbaReserved, 1);
    assert.equal(body.onHand.listings[0].sku, 'SKU-A');

    // Incoming: (10-4) + 3 = 9 units across 2 open orders; received/cancelled excluded
    assert.deepEqual(body.incoming, { units: 9, orders: 2 });

    // Purchases: lifetime 5+3+2 = 10 units, spend 5*1000+3*1200+2*900 = 10400
    assert.equal(body.purchases.lifetimeUnits, 10);
    assert.equal(body.purchases.lifetimeSpendCents, 10400);
    assert.equal(body.purchases.avgUnitCostCents, 1040);
    assert.equal(body.purchases.recent.length, 3);

    // Sales: 30d = 2; 90d = 2+3 = 5 (canceled + 200d excluded);
    // avg SOLD price = item + shipping over 90d = (13500+1500)/5 = 3000;
    // avg shipping = 1500/5 = 300.
    assert.equal(body.sales.units30, 2);
    assert.equal(body.sales.units90, 5);
    assert.equal(body.sales.avgSalePriceCents, 3000);
    assert.equal(body.sales.avgShippingCents, 300);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
