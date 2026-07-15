import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'other-income-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE other_income (date TEXT, income_type TEXT, amount INTEGER, description TEXT, marketplace TEXT)');
  const insert = db.prepare('INSERT INTO other_income VALUES (?, ?, ?, ?, ?)');
  insert.run('2026-01-15', 'Liquidation', 1000, 'amazon fixture', 'amazon');
  insert.run('2026-01-20', 'Adjustment', 500, 'walmart fixture', 'walmart');
  insert.run('2026-02-01', 'Liquidation', 250, 'late fixture', 'amazon');
  db.close();
  return dir;
}

async function call(dir: string, query: string) {
  const previous = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/other-income/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/other-income?${query}`));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previous);
  }
}

test('other income honors date and marketplace filters and rejects unsafe input', async () => {
  const dir = fixture();
  try {
    const valid = await call(dir, 'startDate=2026-01-01&endDate=2026-01-31&marketplace=amazon');
    assert.equal(valid.response.status, 200);
    assert.equal(valid.body.totals.count, 1);
    assert.equal(valid.body.totals.totalIncome, 1000);

    const hostile = await call(dir, `marketplace=${encodeURIComponent(`amazon' OR 1=1 --`)}`);
    assert.equal(hostile.response.status, 400);
    assert.equal(hostile.body.error, 'Invalid marketplace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
