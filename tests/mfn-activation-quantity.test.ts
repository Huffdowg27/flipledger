import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST as previewActivation } from '../src/app/api/data/merchant-inventory/activation-preview/route';
import { POST as pushActivation } from '../src/app/api/data/merchant-inventory/activation-push/route';

type ActivationRow = {
  sku: string;
  proposed_qty: number;
  can_push?: boolean;
  eligible?: boolean;
};

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfn-activation-quantity-'));
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
      marketplace TEXT NOT NULL
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

    INSERT INTO merchant_listings
      (sku, asin, quantity, list_price_cents, status, item_name, marketplace)
    VALUES
      ('MFN-PARTIAL', 'B000000001', 0, 2500, 'Inactive', 'Partial lot', 'amazon'),
      ('MFN-MULTI',   'B000000002', 0, 3000, 'Inactive', 'Multi lot',   'amazon'),
      ('MFN-ZERO',    'B000000003', 0, 3500, 'Inactive', 'Zero lot',    'amazon');

    INSERT INTO inventory_ledger
      (id, sku, asin, list_price_cents, quantity_received, quantity_remaining,
       inspected_at, merchant_shipping_group_name, date_purchased)
    VALUES
      (1, 'MFN-PARTIAL', 'B000000001', 2500, 10, 7, NULL, NULL, '2026-07-01T00:00:00Z'),
      (2, 'MFN-MULTI',   'B000000002', 3000,  5, 5, NULL, NULL, '2026-07-01T00:00:00Z'),
      (3, 'MFN-MULTI',   'B000000002', 3000,  5, 5, NULL, NULL, '2026-07-02T00:00:00Z'),
      (4, 'MFN-ZERO',    'B000000003', 3500, 10, 0, NULL, NULL, '2026-07-01T00:00:00Z');
  `);
  db.close();
  return dir;
}

async function callRoutes(dir: string, skus: string[]) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const previewResponse = await previewActivation(new NextRequest(
      'http://localhost/api/data/merchant-inventory/activation-preview',
      {
        method: 'POST',
        body: JSON.stringify({ skus }),
        headers: { 'content-type': 'application/json' },
      },
    ));
    const pushResponse = await pushActivation(new NextRequest(
      'http://localhost/api/data/merchant-inventory/activation-push',
      {
        method: 'POST',
        body: JSON.stringify({ skus, dryRun: true }),
        headers: { 'content-type': 'application/json' },
      },
    ));
    assert.equal(previewResponse.status, 200);
    assert.equal(pushResponse.status, 200);
    const previewBody = await previewResponse.json();
    const pushBody = await pushResponse.json();
    return {
      preview: previewBody.rows as ActivationRow[],
      push: pushBody.results as ActivationRow[],
    };
  } finally {
    process.chdir(previousCwd);
  }
}

function bySku(rows: ActivationRow[]): Map<string, ActivationRow> {
  return new Map(rows.map(row => [row.sku, row]));
}

test('MFN activation uses remaining sellable units, not cumulative received units', async () => {
  const dir = makeFixture();
  try {
    const { preview } = await callRoutes(dir, ['MFN-PARTIAL']);
    assert.equal(bySku(preview).get('MFN-PARTIAL')?.proposed_qty, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MFN activation sums remaining units across every open lot for a SKU', async () => {
  const dir = makeFixture();
  try {
    const { preview } = await callRoutes(dir, ['MFN-MULTI']);
    assert.equal(bySku(preview).get('MFN-MULTI')?.proposed_qty, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MFN activation preview and push propose identical quantities for the same SKUs', async () => {
  const dir = makeFixture();
  const skus = ['MFN-PARTIAL', 'MFN-MULTI', 'MFN-ZERO'];
  try {
    const { preview, push } = await callRoutes(dir, skus);
    assert.deepEqual(
      preview.map(row => [row.sku, row.proposed_qty]),
      push.map(row => [row.sku, row.proposed_qty]),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MFN activation proposes zero and excludes a SKU with no remaining units', async () => {
  const dir = makeFixture();
  try {
    const { preview, push } = await callRoutes(dir, ['MFN-ZERO']);
    assert.equal(bySku(preview).get('MFN-ZERO')?.proposed_qty, 0);
    assert.equal(bySku(preview).get('MFN-ZERO')?.can_push, false);
    assert.equal(bySku(push).get('MFN-ZERO')?.proposed_qty, 0);
    assert.equal(bySku(push).get('MFN-ZERO')?.eligible, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
