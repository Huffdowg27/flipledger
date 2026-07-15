import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salestax-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE sales_tax (state TEXT, tax_collected INTEGER, marketplace_facilitator_tax INTEGER, posted_date TEXT, marketplace TEXT)');
  const insert = db.prepare('INSERT INTO sales_tax VALUES (?, ?, ?, ?, ?)');
  insert.run('CA', -100, -80, '2026-01-15', 'amazon');
  insert.run('TX', -50, -40, '2026-01-20', 'walmart');
  insert.run('CA', -25, -20, '2026-02-01', 'amazon');
  db.close();
  return dir;
}

async function call(dir: string, query: string) {
  const previous = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/salestax/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/salestax?${query}`));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previous);
  }
}

test('sales tax honors date and marketplace filters and rejects unsafe input', async () => {
  const dir = fixture();
  try {
    const valid = await call(dir, 'startDate=2026-01-01&endDate=2026-01-31&marketplace=amazon');
    assert.equal(valid.response.status, 200);
    assert.equal(valid.body.totals.stateCount, 1);
    assert.equal(valid.body.totals.totalCollected, -100);
    assert.equal(valid.body.totals.totalFacilitator, -80);

    const hostile = await call(dir, `marketplace=${encodeURIComponent(`amazon' OR 1=1 --`)}`);
    assert.equal(hostile.response.status, 400);
    assert.equal(hostile.body.error, 'Invalid marketplace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
