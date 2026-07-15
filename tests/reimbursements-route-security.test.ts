import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursements-route-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.close();
  return dir;
}

async function callRoute(dir: string, query: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/reimbursements/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/reimbursements?${query}`));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

test('reimbursements rejects unsafe marketplace and invalid dates before DB access', async () => {
  const dir = makeFixture();
  try {
    const hostile = await callRoute(
      dir,
      `startDate=2026-01-01&marketplace=${encodeURIComponent(`amazon' OR 1=1 --`)}`,
    );
    assert.equal(hostile.response.status, 400);
    assert.equal(hostile.body.error, 'Invalid marketplace');

    const invalidDate = await callRoute(dir, 'startDate=2026-01-01&endDate=2026-02-31');
    assert.equal(invalidDate.response.status, 400);
    assert.equal(invalidDate.body.error, 'Invalid date range');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
