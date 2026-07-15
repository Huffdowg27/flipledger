import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/incoming/[id]/route';

function makeFixture(quantity = 2): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incoming-receipt-idempotency-'));
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      1, 'B000000001', 'SKU-1', ${quantity}, 0, 1200,
      '2026-07-01', 'on_order', '2026-07-01T00:00:00Z'
    );
  `);
  db.close();
  return { dir, dbPath };
}

async function receive(
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
        body: JSON.stringify({ action: 'receive', ...body }),
      }),
      { params: Promise.resolve({ id: '1' }) },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

function receiptState(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      purchase: db.prepare(`
        SELECT quantity_received, status, inventory_ledger_id
        FROM incoming_purchases WHERE id = 1
      `).get(),
      lots: db.prepare(`
        SELECT id, quantity, quantity_remaining, quantity_received
        FROM inventory_ledger ORDER BY id
      `).all(),
      allocations: db.prepare(`
        SELECT receipt_key, quantity_good, quantity_issue, inventory_ledger_id,
               receiving_issue_id
        FROM incoming_receipt_allocations ORDER BY id
      `).all(),
    };
  } finally {
    db.close();
  }
}

test('replaying one receive request changes inventory exactly once', async () => {
  const fixture = makeFixture(2);
  const request = {
    receiptKey: 'receipt-1',
    expectedQuantityReceived: 0,
    quantityGood: 1,
    quantityIssue: 0,
  };
  try {
    const first = await receive(fixture.dir, request);
    const replay = await receive(fixture.dir, request);

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(first.body.replayed, false);
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(receiptState(fixture.dbPath), {
      purchase: { quantity_received: 1, status: 'partial', inventory_ledger_id: 1 },
      lots: [{ id: 1, quantity: 1, quantity_remaining: 1, quantity_received: 1 }],
      allocations: [{
        receipt_key: 'receipt-1',
        quantity_good: 1,
        quantity_issue: 0,
        inventory_ledger_id: 1,
        receiving_issue_id: null,
      }],
    });
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a stale receive version cannot commit under a different receipt key', async () => {
  const fixture = makeFixture(2);
  try {
    const first = await receive(fixture.dir, {
      receiptKey: 'receipt-first',
      expectedQuantityReceived: 0,
      quantityGood: 1,
    });
    const stale = await receive(fixture.dir, {
      receiptKey: 'receipt-stale',
      expectedQuantityReceived: 0,
      quantityGood: 1,
    });

    assert.equal(first.status, 200);
    assert.equal(stale.status, 409);
    assert.match(String(stale.body.error), /changed|stale/i);
    assert.equal((receiptState(fixture.dbPath).purchase as { quantity_received: number }).quantity_received, 1);
    assert.equal(receiptState(fixture.dbPath).allocations.length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('reusing a receipt key with different content fails closed', async () => {
  const fixture = makeFixture(2);
  try {
    const first = await receive(fixture.dir, {
      receiptKey: 'receipt-reused',
      expectedQuantityReceived: 0,
      quantityGood: 1,
    });
    const conflict = await receive(fixture.dir, {
      receiptKey: 'receipt-reused',
      expectedQuantityReceived: 1,
      quantityGood: 1,
    });

    assert.equal(first.status, 200);
    assert.equal(conflict.status, 409);
    assert.match(String(conflict.body.error), /receipt key/i);
    assert.equal((receiptState(fixture.dbPath).purchase as { quantity_received: number }).quantity_received, 1);
    assert.equal(receiptState(fixture.dbPath).allocations.length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('the first identified receipt freezes an explicit pre-identity received baseline', async () => {
  const fixture = makeFixture(2);
  const db = new Database(fixture.dbPath);
  db.prepare(`
    UPDATE incoming_purchases
    SET quantity_received = 1, status = 'partial'
    WHERE id = 1
  `).run();
  db.close();
  try {
    const result = await receive(fixture.dir, {
      receiptKey: 'receipt-after-airtable-seed',
      expectedQuantityReceived: 1,
      quantityGood: 1,
    });
    const verify = new Database(fixture.dbPath, { readonly: true });
    const purchase = verify.prepare(`
      SELECT quantity_received, receipt_allocation_baseline,
             receipt_identity_started_at
      FROM incoming_purchases WHERE id = 1
    `).get() as {
      quantity_received: number;
      receipt_allocation_baseline: number;
      receipt_identity_started_at: string | null;
    };
    verify.close();

    assert.equal(result.status, 200);
    assert.equal(purchase.quantity_received, 2);
    assert.equal(purchase.receipt_allocation_baseline, 1);
    assert.ok(purchase.receipt_identity_started_at);
    assert.equal(receiptState(fixture.dbPath).allocations.length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('good and issue allocations conserve without assigning an issue-only receipt to a lot', async () => {
  const fixture = makeFixture(2);
  try {
    const good = await receive(fixture.dir, {
      receiptKey: 'receipt-good',
      expectedQuantityReceived: 0,
      quantityGood: 1,
    });
    const issue = await receive(fixture.dir, {
      receiptKey: 'receipt-issue',
      expectedQuantityReceived: 1,
      quantityIssue: 1,
      issueType: 'damaged',
    });
    const state = receiptState(fixture.dbPath);

    assert.equal(good.status, 200);
    assert.equal(issue.status, 200);
    assert.deepEqual(state.purchase, {
      quantity_received: 2,
      status: 'received',
      inventory_ledger_id: 1,
    });
    assert.deepEqual(state.lots, [{
      id: 1,
      quantity: 1,
      quantity_remaining: 1,
      quantity_received: 1,
    }]);
    assert.deepEqual(state.allocations, [
      {
        receipt_key: 'receipt-good',
        quantity_good: 1,
        quantity_issue: 0,
        inventory_ledger_id: 1,
        receiving_issue_id: null,
      },
      {
        receipt_key: 'receipt-issue',
        quantity_good: 0,
        quantity_issue: 1,
        inventory_ledger_id: null,
        receiving_issue_id: 1,
      },
    ]);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
