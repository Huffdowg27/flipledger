import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'removals-route-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      asin TEXT NOT NULL,
      sku TEXT,
      name TEXT,
      marketplace TEXT
    );
    CREATE TABLE removals (
      id INTEGER PRIMARY KEY,
      removal_order_id TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      removal_type TEXT NOT NULL,
      reason TEXT,
      status TEXT,
      date_requested TEXT NOT NULL,
      date_completed TEXT,
      fee INTEGER,
      marketplace TEXT
    );
  `);

  db.prepare('INSERT INTO products (id, asin, sku, name, marketplace) VALUES (?, ?, ?, ?, ?)')
    .run(1, 'ASIN-1', 'SKU-1', 'Fixture product', 'amazon');
  const insertRemoval = db.prepare(`
    INSERT INTO removals (
      id, removal_order_id, asin, sku, quantity, removal_type, reason,
      status, date_requested, date_completed, fee, marketplace
    ) VALUES (?, ?, ?, ?, ?, 'Return', 'Fixture', 'Completed', ?, NULL, ?, ?)
  `);
  insertRemoval.run(1, 'R-AMZ', 'ASIN-1', 'SKU-1', 2, '2026-01-15T12:00:00Z', -100, 'amazon');
  insertRemoval.run(2, 'R-WMT', 'ASIN-2', 'SKU-2', 1, '2026-01-20T12:00:00Z', -50, 'walmart');
  insertRemoval.run(3, 'R-LATE', 'ASIN-3', 'SKU-3', 1, '2026-02-01T00:00:00Z', -25, 'amazon');
  db.close();
  return dir;
}

async function callRemovalsRoute(dir: string, query: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/removals/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/removals?${query}`));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

test('removals route qualifies and parameterizes the marketplace filter', async () => {
  const dir = makeFixture();
  try {
    const { response, body } = await callRemovalsRoute(
      dir,
      'startDate=2026-01-01&endDate=2026-01-31&marketplace=amazon',
    );
    assert.equal(response.status, 200);
    assert.deepEqual(body.items.map((item: { removalOrderId: string }) => item.removalOrderId), ['R-AMZ']);
    assert.equal(body.totals.totalQuantity, 2);
    assert.equal(body.totals.totalFee, -100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removals route rejects an unrecognized or SQL-shaped marketplace', async () => {
  const dir = makeFixture();
  try {
    const { response, body } = await callRemovalsRoute(
      dir,
      `startDate=2026-01-01&marketplace=${encodeURIComponent(`amazon' OR 1=1 --`)}`,
    );
    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid marketplace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removals route honors the inclusive end date', async () => {
  const dir = makeFixture();
  try {
    const { response, body } = await callRemovalsRoute(
      dir,
      'startDate=2026-01-01&endDate=2026-01-31',
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      body.items.map((item: { removalOrderId: string }) => item.removalOrderId).sort(),
      ['R-AMZ', 'R-WMT'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removals route rejects malformed or impossible calendar dates', async () => {
  const dir = makeFixture();
  try {
    const malformed = await callRemovalsRoute(
      dir,
      'startDate=2026-01-01&endDate=2026-02-31',
    );
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.error, 'Invalid date range');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removals route rejects a start date after the end date', async () => {
  const dir = makeFixture();
  try {
    const reversed = await callRemovalsRoute(
      dir,
      'startDate=2026-02-01&endDate=2026-01-31',
    );
    assert.equal(reversed.response.status, 400);
    assert.equal(reversed.body.error, 'Invalid date range');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removals route rejects malformed fallback-day windows', async () => {
  const dir = makeFixture();
  try {
    const malformed = await callRemovalsRoute(dir, 'days=30%20OR%201%3D1');
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.error, 'Invalid days');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
