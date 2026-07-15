import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

function makeEmptyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-route-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.close();
  return dir;
}

async function callDashboardRoute(dir: string, query: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/dashboard/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/dashboard?${query}`));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

test('Dashboard rejects a SQL-shaped marketplace before querying the database', async () => {
  const dir = makeEmptyFixture();
  try {
    const { response, body } = await callDashboardRoute(
      dir,
      `startDate=2026-06-01&endDate=2026-06-30&marketplace=${encodeURIComponent(`amazon' OR 1=1 --`)}`,
    );
    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid marketplace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Dashboard rejects impossible dates and reversed ranges before querying the database', async () => {
  const dir = makeEmptyFixture();
  try {
    const impossible = await callDashboardRoute(
      dir,
      'startDate=2026-06-01&endDate=2026-06-31',
    );
    assert.equal(impossible.response.status, 400);
    assert.equal(impossible.body.error, 'Invalid date range');

    const reversed = await callDashboardRoute(
      dir,
      'startDate=2026-07-01&endDate=2026-06-30',
    );
    assert.equal(reversed.response.status, 400);
    assert.equal(reversed.body.error, 'Invalid date range');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Dashboard rejects unknown date bases and malformed fallback-day windows', async () => {
  const dir = makeEmptyFixture();
  try {
    const dateBasis = await callDashboardRoute(
      dir,
      'startDate=2026-06-01&endDate=2026-06-30&dateBasis=drop-table',
    );
    assert.equal(dateBasis.response.status, 400);
    assert.equal(dateBasis.body.error, 'Invalid date basis');

    const days = await callDashboardRoute(dir, 'days=30oops');
    assert.equal(days.response.status, 400);
    assert.equal(days.body.error, 'Invalid days');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
