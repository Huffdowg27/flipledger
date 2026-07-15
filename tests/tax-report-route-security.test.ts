import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

function makeEmptyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-report-route-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.close();
  return dir;
}

async function callTaxRoute(dir: string, query: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/tax-report/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/tax-report?${query}`));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

test('Tax Report rejects malformed years before querying the database', async () => {
  const dir = makeEmptyFixture();
  try {
    for (const year of ['2026oops', '1999', '2101']) {
      const { response, body } = await callTaxRoute(dir, `year=${year}`);
      assert.equal(response.status, 400);
      assert.equal(body.error, 'Invalid year');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Tax Report rejects SQL-shaped marketplaces before querying the database', async () => {
  const dir = makeEmptyFixture();
  try {
    const { response, body } = await callTaxRoute(
      dir,
      `year=2026&marketplace=${encodeURIComponent(`amazon' OR 1=1 --`)}`,
    );
    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid marketplace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
