import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refunds-route-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY, asin TEXT, name TEXT);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id TEXT, asin TEXT);
    CREATE TABLE refunds (
      id INTEGER PRIMARY KEY, refund_date TEXT, order_id TEXT, asin TEXT, sku TEXT,
      quantity INTEGER, refund_amount INTEGER, reason TEXT, item_returned INTEGER,
      fee_clawback INTEGER, marketplace TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO refunds VALUES (?, ?, ?, ?, ?, 1, ?, 'fixture', 1, ?, ?)
  `);
  insert.run(1, '2026-01-15T12:00:00Z', 'O1', 'A1', 'S1', 1000, 100, 'amazon');
  insert.run(2, '2026-01-20T12:00:00Z', 'O2', 'A2', 'S2', 500, 50, 'walmart');
  insert.run(3, '2026-02-01T00:00:00Z', 'O3', 'A3', 'S3', 250, 25, 'amazon');
  db.close();
  return dir;
}

async function callRoute(dir: string, query: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/refunds/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/refunds?${query}`));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

test('refunds honors date range and marketplace together', async () => {
  const dir = makeFixture();
  try {
    const { response, body } = await callRoute(
      dir,
      'startDate=2026-01-01&endDate=2026-01-31&marketplace=amazon',
    );
    assert.equal(response.status, 200);
    assert.equal(body.totals.count, 1);
    assert.equal(body.totals.totalRefundAmount, 1000);
    assert.equal(body.totals.totalClawback, 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refunds rejects SQL-shaped marketplace and invalid dates', async () => {
  const dir = makeFixture();
  try {
    const hostile = await callRoute(
      dir,
      `startDate=2026-01-01&marketplace=${encodeURIComponent(`amazon' OR 1=1 --`)}`,
    );
    assert.equal(hostile.response.status, 400);
    assert.equal(hostile.body.error, 'Invalid marketplace');

    const badDate = await callRoute(dir, 'startDate=2026-01-01&endDate=2026-02-31');
    assert.equal(badDate.response.status, 400);
    assert.equal(badDate.body.error, 'Invalid date range');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
