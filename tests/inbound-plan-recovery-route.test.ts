import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

import { buildInboundPlanName } from '../src/lib/inbound-plan-recovery';

test('sync-from-amazon reconnects an interrupted send without creating a new plan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipledger-plan-recovery-'));
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
      inbound_operation_id TEXT,
      plan_status TEXT,
      packing_status TEXT,
      placement_status TEXT,
      packing_error TEXT,
      placement_error TEXT,
      updated_at TEXT
    );
    CREATE TABLE listing_batch_items (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL
    );
    INSERT INTO settings VALUES
      ('clientId', 'test-client'),
      ('clientSecret', 'test-secret'),
      ('refreshToken', 'test-refresh'),
      ('marketplaceId', 'ATVPDKIKX0DER');
    INSERT INTO listing_batches (id, name, status, channel, updated_at)
    VALUES (42, 'July Batch', 'failed', 'FBA', '2026-07-01T12:00:00.000Z');
    INSERT INTO listing_batch_items VALUES (1, 42, 'SKU-RECOVERED', 3);
  `);
  db.close();

  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    requests.push({ url, method });

    if (url === 'https://api.amazon.com/auth/o2/token') {
      return Response.json({
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        token_type: 'bearer',
        expires_in: 3600,
      });
    }
    if (url.includes('/inboundPlans?')) {
      return Response.json({
        inboundPlans: [{
          inboundPlanId: 'PLAN-RECOVERED',
          name: buildInboundPlanName(42, 'July Batch'),
          status: 'ACTIVE',
        }],
      });
    }
    if (url.endsWith('/inboundPlans/PLAN-RECOVERED')) {
      return Response.json({
        inboundPlanId: 'PLAN-RECOVERED',
        name: buildInboundPlanName(42, 'July Batch'),
        status: 'ACTIVE',
        packingOptions: [],
        placementOptions: [],
        shipments: [],
      });
    }
    if (url.includes('/inboundPlans/PLAN-RECOVERED/items?')) {
      return Response.json({
        items: [{ msku: 'SKU-RECOVERED', quantity: 3 }],
      });
    }
    if (url.endsWith('/inboundPlans/PLAN-RECOVERED/shipments')) {
      return Response.json({ shipments: [] });
    }
    return new Response('unexpected request', { status: 500 });
  };

  try {
    process.chdir(dir);
    const { POST } = await import(
      '../src/app/api/list/batches/[id]/sync-from-amazon/route'
    );
    const response = await POST(
      new NextRequest('http://localhost/api/list/batches/42/sync-from-amazon', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: '42' }) },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.recovered, true);
    assert.equal(body.newStatus, 'ready');
    assert.equal(
      requests.some((request) => (
        request.method === 'POST'
        && request.url.includes('/inbound/fba/2024-03-20/inboundPlans')
      )),
      false,
    );

    const check = new Database(path.join(dir, 'data', 'flipledger.db'), {
      readonly: true,
    });
    const batch = check.prepare(`
      SELECT status, inbound_plan_id AS inboundPlanId,
        inbound_operation_id AS operationId, plan_status AS planStatus
      FROM listing_batches WHERE id = 42
    `).get();
    check.close();
    assert.deepEqual(batch, {
      status: 'ready',
      inboundPlanId: 'PLAN-RECOVERED',
      operationId: null,
      planStatus: 'SUCCESS',
    });
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
