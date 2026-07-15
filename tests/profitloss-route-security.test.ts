import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

function makeEmptyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profitloss-route-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.close();
  return dir;
}

async function callProfitLossRoute(dir: string, query: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/profitloss/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/profitloss?${query}`));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

test('P&L rejects a SQL-shaped marketplace before opening the database', async () => {
  const dir = makeEmptyFixture();
  try {
    const { response, body } = await callProfitLossRoute(
      dir,
      `startDate=2026-06-01&endDate=2026-06-30&marketplace=${encodeURIComponent(`amazon' OR 1=1 --`)}`,
    );
    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid marketplace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P&L rejects impossible calendar dates before opening the database', async () => {
  const dir = makeEmptyFixture();
  try {
    const { response, body } = await callProfitLossRoute(
      dir,
      'startDate=2026-06-01&endDate=2026-06-31',
    );
    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid date range');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P&L rejects unknown date-basis values before opening the database', async () => {
  const dir = makeEmptyFixture();
  try {
    const { response, body } = await callProfitLossRoute(
      dir,
      'startDate=2026-06-01&endDate=2026-06-30&dateBasis=drop-table',
    );
    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid date basis');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
