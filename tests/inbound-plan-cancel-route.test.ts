import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

test('Cancel & Edit fails closed when Amazon does not cancel the plan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipledger-plan-cancel-'));
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  fs.mkdirSync(path.join(dir, 'data'));

  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE listing_batches (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      channel TEXT NOT NULL,
      inbound_plan_id TEXT,
      sent_at TEXT,
      updated_at TEXT,
      created_at TEXT
    );
    INSERT INTO settings VALUES
      ('clientId', 'test-client'),
      ('clientSecret', 'test-secret'),
      ('refreshToken', 'test-refresh'),
      ('marketplaceId', 'ATVPDKIKX0DER');
    INSERT INTO listing_batches VALUES (
      42, 'July Batch', 'failed', 'FBA', 'PLAN-LIVE',
      '2026-07-01T12:00:00.000Z',
      '2026-07-01T12:00:00.000Z',
      '2026-07-01T12:00:00.000Z'
    );
  `);
  db.close();

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.amazon.com/auth/o2/token') {
      return Response.json({
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        token_type: 'bearer',
        expires_in: 3600,
      });
    }
    if (url.endsWith('/inboundPlans/PLAN-LIVE/cancellation')) {
      return new Response('temporary Amazon failure', { status: 500 });
    }
    return new Response('unexpected request', { status: 500 });
  };

  try {
    process.chdir(dir);
    const { POST } = await import(
      '../src/app/api/list/batches/[id]/cancel-and-edit/route'
    );
    const response = await POST(
      new NextRequest('http://localhost/api/list/batches/42/cancel-and-edit', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: '42' }) },
    );
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.match(body.error, /was not reset/);

    const check = new Database(path.join(dir, 'data', 'flipledger.db'), {
      readonly: true,
    });
    assert.deepEqual(
      check.prepare(`
        SELECT status, inbound_plan_id AS inboundPlanId
        FROM listing_batches WHERE id = 42
      `).get(),
      { status: 'failed', inboundPlanId: 'PLAN-LIVE' },
    );
    check.close();
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
