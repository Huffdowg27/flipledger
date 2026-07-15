import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/incoming/[id]/route';

function makeFixture(purchaseQuantity = 2): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incoming-reconciliation-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const dbPath = path.join(dir, 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE merchant_listings (
      sku TEXT, asin TEXT, marketplace TEXT, last_synced TEXT
    );
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
    ) VALUES (
      1, 'B000000001', 'SKU-1', ${purchaseQuantity}, 0, 1200,
      '2026-06-01', 'on_order', '2026-06-01T00:00:00Z'
    );
    INSERT INTO inventory_ledger (
      id, asin, sku, buy_price, quantity, quantity_remaining,
      quantity_received, date_purchased, received_at, bin_location, created_at
    ) VALUES
      (10, 'B000000001', 'SKU-1', 1200, 2, 1, 2,
       '2026-06-10', '2026-06-10T12:00:00Z', 'R1-A1', '2026-06-10T12:00:00Z'),
      (20, 'B000000002', 'SKU-2', 1800, 1, 1, 1,
       '2026-06-11', '2026-06-11T12:00:00Z', 'R1-B1', '2026-06-11T12:00:00Z');
  `);
  db.close();
  return { dir, dbPath };
}

async function reconcile(
  dir: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const response = await POST(
      new NextRequest('http://localhost/api/incoming/1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reconcile', ...body }),
      }),
      { params: Promise.resolve({ id: '1' }) },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

function state(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      purchase: db.prepare(`
        SELECT quantity_received, status, inventory_ledger_id,
               receipt_allocation_baseline,
               receipt_identity_started_at IS NOT NULL AS identity_started
        FROM incoming_purchases WHERE id = 1
      `).get(),
      lots: db.prepare(`
        SELECT id, quantity, quantity_remaining, quantity_received,
               received_at, bin_location
        FROM inventory_ledger ORDER BY id
      `).all(),
      allocations: db.prepare(`
        SELECT receipt_key, incoming_purchase_id, inventory_ledger_id,
               quantity_good, quantity_issue, sku, source
        FROM incoming_receipt_allocations ORDER BY id
      `).all(),
    };
  } finally {
    db.close();
  }
}

test('operator reconciliation records receipt identity without changing the selected lot', async () => {
  const fixture = makeFixture(2);
  const before = state(fixture.dbPath).lots;
  try {
    const result = await reconcile(fixture.dir, {
      receiptKey: 'reconcile-1',
      expectedQuantityReceived: 0,
      inventoryLedgerId: 10,
      quantity: 2,
    });
    const after = state(fixture.dbPath);

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      success: true,
      inventoryLedgerId: 10,
      quantityReconciled: 2,
      status: 'received',
      mismatchConfirmed: false,
      replayed: false,
      airtableSynced: false,
    });
    assert.deepEqual(after.purchase, {
      quantity_received: 2,
      status: 'received',
      inventory_ledger_id: 10,
      receipt_allocation_baseline: 0,
      identity_started: 1,
    });
    assert.deepEqual(after.lots, before);
    assert.deepEqual(after.allocations, [{
      receipt_key: 'reconcile-1',
      incoming_purchase_id: 1,
      inventory_ledger_id: 10,
      quantity_good: 2,
      quantity_issue: 0,
      sku: 'SKU-1',
      source: 'operator_reconciliation',
    }]);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('replaying an operator reconciliation changes the purchase exactly once', async () => {
  const fixture = makeFixture(2);
  const request = {
    receiptKey: 'reconcile-replay',
    expectedQuantityReceived: 0,
    inventoryLedgerId: 10,
    quantity: 1,
  };
  try {
    const first = await reconcile(fixture.dir, request);
    const replay = await reconcile(fixture.dir, request);
    const after = state(fixture.dbPath);

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(first.body.replayed, false);
    assert.equal(replay.body.replayed, true);
    assert.equal((after.purchase as { quantity_received: number }).quantity_received, 1);
    assert.equal(after.allocations.length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a stale reconciliation version fails closed', async () => {
  const fixture = makeFixture(2);
  try {
    const first = await reconcile(fixture.dir, {
      receiptKey: 'reconcile-first',
      expectedQuantityReceived: 0,
      inventoryLedgerId: 10,
      quantity: 1,
    });
    const stale = await reconcile(fixture.dir, {
      receiptKey: 'reconcile-stale',
      expectedQuantityReceived: 0,
      inventoryLedgerId: 10,
      quantity: 1,
    });

    assert.equal(first.status, 200);
    assert.equal(stale.status, 409);
    assert.match(String(stale.body.error), /changed|stale/i);
    assert.equal(state(fixture.dbPath).allocations.length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a mismatched lot requires explicit operator confirmation', async () => {
  const fixture = makeFixture(2);
  try {
    const rejected = await reconcile(fixture.dir, {
      receiptKey: 'reconcile-mismatch-rejected',
      expectedQuantityReceived: 0,
      inventoryLedgerId: 20,
      quantity: 1,
    });
    assert.equal(rejected.status, 409);
    assert.match(String(rejected.body.error), /mismatch/i);
    assert.equal(state(fixture.dbPath).allocations.length, 0);

    const confirmed = await reconcile(fixture.dir, {
      receiptKey: 'reconcile-mismatch-confirmed',
      expectedQuantityReceived: 0,
      inventoryLedgerId: 20,
      quantity: 1,
      confirmMismatch: true,
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.mismatchConfirmed, true);
    assert.equal((state(fixture.dbPath).purchase as { inventory_ledger_id: number }).inventory_ledger_id, 20);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a conflicting SKU requires confirmation even when the ASIN matches', async () => {
  const fixture = makeFixture(2);
  const db = new Database(fixture.dbPath);
  db.prepare("UPDATE inventory_ledger SET asin = 'B000000001' WHERE id = 20").run();
  db.close();
  try {
    const result = await reconcile(fixture.dir, {
      receiptKey: 'reconcile-sku-conflict',
      expectedQuantityReceived: 0,
      inventoryLedgerId: 20,
      quantity: 1,
    });

    assert.equal(result.status, 409);
    assert.match(String(result.body.error), /mismatch/i);
    assert.equal(state(fixture.dbPath).allocations.length, 0);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('only open incoming purchases can be reconciled', async () => {
  const fixture = makeFixture(2);
  const db = new Database(fixture.dbPath);
  db.prepare("UPDATE incoming_purchases SET status = 'cancelled' WHERE id = 1").run();
  db.close();
  try {
    const result = await reconcile(fixture.dir, {
      receiptKey: 'reconcile-cancelled',
      expectedQuantityReceived: 0,
      inventoryLedgerId: 10,
      quantity: 1,
    });

    assert.equal(result.status, 409);
    assert.match(String(result.body.error), /open|cancelled/i);
    assert.equal(state(fixture.dbPath).allocations.length, 0);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('operator reconciliations cannot allocate more units than the lot received', async () => {
  const fixture = makeFixture(3);
  try {
    const first = await reconcile(fixture.dir, {
      receiptKey: 'reconcile-lot-cap-first',
      expectedQuantityReceived: 0,
      inventoryLedgerId: 20,
      quantity: 1,
      confirmMismatch: true,
    });
    const overAllocated = await reconcile(fixture.dir, {
      receiptKey: 'reconcile-lot-cap-second',
      expectedQuantityReceived: 1,
      inventoryLedgerId: 20,
      quantity: 1,
      confirmMismatch: true,
    });

    assert.equal(first.status, 200);
    assert.equal(overAllocated.status, 409);
    assert.match(String(overAllocated.body.error), /lot.*received|allocated/i);
    assert.equal((state(fixture.dbPath).purchase as { quantity_received: number }).quantity_received, 1);
    assert.equal(state(fixture.dbPath).allocations.length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
