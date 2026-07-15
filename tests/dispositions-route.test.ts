import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

test('dispositions endpoint unions current and historical rows with display source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispositions-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE products (
      asin TEXT PRIMARY KEY,
      name TEXT
    );
    CREATE TABLE dispositions (
      id INTEGER PRIMARY KEY,
      disp_date TEXT NOT NULL,
      type TEXT NOT NULL,
      ref_id TEXT,
      title TEXT,
      msku TEXT,
      asin TEXT,
      az_disposition TEXT,
      sellable_qty INTEGER NOT NULL DEFAULT 0,
      unsellable_qty INTEGER NOT NULL DEFAULT 0,
      buy_cost_adj INTEGER NOT NULL DEFAULT 0,
      edited_at TEXT
    );
    CREATE TABLE historical_dispositions (
      id INTEGER PRIMARY KEY,
      disp_date TEXT NOT NULL,
      type TEXT NOT NULL,
      ref_id TEXT,
      title TEXT,
      msku TEXT,
      asin TEXT,
      az_disposition TEXT,
      sellable_qty INTEGER,
      unsellable_qty INTEGER,
      buy_cost_adj INTEGER NOT NULL DEFAULT 0,
      source_file TEXT
    );

    INSERT INTO products VALUES ('B000HIST01', 'Historical product');
    INSERT INTO dispositions VALUES
      (1, '2026-02-01', 'Removal', 'CUR-1', 'Current item', 'SKU-CUR', 'B000CUR001', 'n/a', 0, 1, -1200, NULL);
    INSERT INTO historical_dispositions VALUES
      (99, '2019-05-01', 'Disposal', 'HIST-1', '', 'SKU-HIST', 'B000HIST01', 'n/a', NULL, 2, -900, 'history.csv');
  `);
  db.close();

  const previous = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/dispositions/route');
    const response = await GET(new NextRequest('http://localhost/api/data/dispositions?startDate=2018-01-01&endDate=2026-12-31'));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(
      body.items.map((row: any) => ({ refId: row.refId, source: row.source, productName: row.productName })),
      [
        { refId: 'CUR-1', source: 'current', productName: 'Current item' },
        { refId: 'HIST-1', source: 'historical', productName: 'Historical product' },
      ],
    );
    assert.equal(body.totals.count, 2);
    assert.equal(body.totals.bySource.current, 1);
    assert.equal(body.totals.bySource.historical, 1);
    assert.equal(body.totals.writeoffCents, 2100);
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
