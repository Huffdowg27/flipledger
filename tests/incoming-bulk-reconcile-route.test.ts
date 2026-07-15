import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/incoming/bulk-reconcile/route';

interface BulkRouteResponse {
  results: Array<{
    purchaseId: number | null;
    success: boolean;
    status?: string | number;
    error?: string;
    replayed?: boolean;
  }>;
}

function makeFixture(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incoming-bulk-reconcile-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const dbPath = path.join(dir, 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE incoming_purchases (
      id INTEGER PRIMARY KEY,
      airtable_record_id TEXT,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      quantity_received INTEGER NOT NULL DEFAULT 0,
      unit_cost_cents INTEGER NOT NULL,
      ordered_at TEXT,
      status TEXT NOT NULL,
      received_at TEXT,
      inventory_ledger_id INTEGER,
      receipt_allocation_baseline INTEGER NOT NULL DEFAULT 0,
      receipt_identity_started_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      asin TEXT,
      sku TEXT,
      buy_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL,
      quantity_received INTEGER,
      date_purchased TEXT NOT NULL,
      received_at TEXT,
      bin_location TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE receiving_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incoming_purchase_id INTEGER,
      inventory_ledger_id INTEGER,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      issue_type TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE incoming_receipt_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_key TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL,
      incoming_purchase_id INTEGER NOT NULL,
      inventory_ledger_id INTEGER,
      receiving_issue_id INTEGER,
      quantity_good INTEGER NOT NULL,
      quantity_issue INTEGER NOT NULL,
      sku TEXT,
      source TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO incoming_purchases (
      id, asin, sku, quantity, quantity_received, unit_cost_cents,
      ordered_at, status, updated_at
    ) VALUES
      (1, 'B000000001', 'SKU-1', 2, 0, 1200, '2026-07-01', 'on_order', '2026-07-01T00:00:00Z'),
      (2, 'B000000002', 'SKU-2', 1, 0, 1500, '2026-07-01', 'on_order', '2026-07-01T00:00:00Z');
    INSERT INTO inventory_ledger (
      id, asin, sku, buy_price, quantity, quantity_remaining,
      quantity_received, date_purchased, received_at, bin_location, created_at
    ) VALUES
      (10, 'B000000001', 'SKU-1', 1200, 2, 1, 2,
       '2026-07-02', '2026-07-02T12:00:00Z', 'R1-A1', '2026-07-02T12:00:00Z'),
      (20, 'B000000002', 'SKU-2', 1500, 1, 1, 1,
       '2026-07-02', '2026-07-02T12:00:00Z', 'R1-B1', '2026-07-02T12:00:00Z');
  `);
  db.close();
  return { dir, dbPath };
}

async function bulkReconcile(
  dir: string,
  items: Array<Record<string, unknown>>,
): Promise<{ status: number; body: BulkRouteResponse }> {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const response = await POST(new NextRequest('http://localhost/api/incoming/bulk-reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(items),
    }));
    return { status: response.status, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

function state(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      purchases: db.prepare(`
        SELECT id, quantity_received, status, inventory_ledger_id
        FROM incoming_purchases ORDER BY id
      `).all(),
      lots: db.prepare(`
        SELECT id, quantity, quantity_remaining, quantity_received
        FROM inventory_ledger ORDER BY id
      `).all(),
      allocations: db.prepare(`
        SELECT receipt_key, incoming_purchase_id, inventory_ledger_id,
               quantity_good, quantity_issue, source
        FROM incoming_receipt_allocations ORDER BY id
      `).all(),
    };
  } finally {
    db.close();
  }
}

test('bulk reconcile keeps each row atomic and isolates partial failures', async () => {
  const fixture = makeFixture();
  try {
    const result = await bulkReconcile(fixture.dir, [
      {
        purchaseId: 1,
        inventoryLedgerId: 10,
        quantity: 2,
        expectedQuantityReceived: 0,
        receiptKey: 'bulk-success',
      },
      {
        purchaseId: 2,
        inventoryLedgerId: 20,
        quantity: 2,
        expectedQuantityReceived: 0,
        receiptKey: 'bulk-fail',
      },
    ]);
    const after = state(fixture.dbPath);

    assert.equal(result.status, 200);
    assert.equal(result.body.results.length, 2);
    assert.deepEqual(result.body.results.map((row: Record<string, unknown>) => ({
      purchaseId: row.purchaseId,
      success: row.success,
      status: row.status,
    })), [
      { purchaseId: 1, success: true, status: 'received' },
      { purchaseId: 2, success: false, status: 409 },
    ]);
    assert.match(String(result.body.results[1].error), /only 1 units are outstanding|Reconciling 2/);
    assert.deepEqual(after.purchases, [
      { id: 1, quantity_received: 2, status: 'received', inventory_ledger_id: 10 },
      { id: 2, quantity_received: 0, status: 'on_order', inventory_ledger_id: null },
    ]);
    assert.deepEqual(after.lots, [
      { id: 10, quantity: 2, quantity_remaining: 1, quantity_received: 2 },
      { id: 20, quantity: 1, quantity_remaining: 1, quantity_received: 1 },
    ]);
    assert.deepEqual(after.allocations, [{
      receipt_key: 'bulk-success',
      incoming_purchase_id: 1,
      inventory_ledger_id: 10,
      quantity_good: 2,
      quantity_issue: 0,
      source: 'operator_reconciliation',
    }]);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('bulk reconcile replays the same receipt key without double-applying', async () => {
  const fixture = makeFixture();
  const request = [{
    purchaseId: 1,
    inventoryLedgerId: 10,
    quantity: 1,
    expectedQuantityReceived: 0,
    receiptKey: 'bulk-replay',
  }];

  try {
    const first = await bulkReconcile(fixture.dir, request);
    const replay = await bulkReconcile(fixture.dir, request);
    const after = state(fixture.dbPath);

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(first.body.results[0].success, true);
    assert.equal(first.body.results[0].replayed, false);
    assert.equal(replay.body.results[0].success, true);
    assert.equal(replay.body.results[0].replayed, true);
    assert.equal((after.purchases[0] as { quantity_received: number }).quantity_received, 1);
    assert.equal(after.allocations.length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
