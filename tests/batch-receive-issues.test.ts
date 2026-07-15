import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST as reportIssue } from '../src/app/api/data/inventory-lots/report-issue/route';
import { POST as resolveIssue } from '../src/app/api/issues/[id]/route';

interface LotState {
  id: number;
  quantity: number;
  quantity_remaining: number;
  quantity_received: number | null;
}

function makeFixture(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-receive-issues-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const dbPath = path.join(dir, 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
      receive_notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE incoming_purchases (
      id INTEGER PRIMARY KEY,
      airtable_record_id TEXT,
      asin TEXT,
      sku TEXT,
      product_name TEXT,
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
      resolution TEXT,
      refund_cents INTEGER,
      resolved_at TEXT,
      lot_shrunk INTEGER NOT NULL DEFAULT 0,
      removed_unit_cost_cents INTEGER,
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
      quantity_good INTEGER NOT NULL CHECK(quantity_good >= 0),
      quantity_issue INTEGER NOT NULL CHECK(quantity_issue >= 0),
      sku TEXT,
      source TEXT NOT NULL CHECK(source IN ('receive', 'operator_reconciliation')),
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(quantity_good + quantity_issue > 0)
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      sku TEXT,
      asin TEXT,
      quantity INTEGER,
      cogs_per_unit INTEGER
    );
    CREATE TABLE expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO inventory_ledger (
      id, asin, sku, buy_price, quantity, quantity_remaining,
      quantity_received, date_purchased, received_at, created_at
    ) VALUES
      (10, 'BATCH-ASIN', 'BATCH-SKU', 1250, 5, 5, 2, '2026-07-01', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'),
      (20, 'LINK-ASIN', 'LINK-SKU', 900, 4, 4, 1, '2026-07-01', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
    INSERT INTO incoming_purchases (
      id, asin, sku, quantity, quantity_received, unit_cost_cents,
      ordered_at, status, inventory_ledger_id, updated_at
    ) VALUES
      (100, 'LINK-ASIN', 'LINK-SKU', 3, 1, 900, '2026-07-01', 'partial', 20, '2026-07-01T00:00:00Z');
  `);
  db.close();
  return { dir, dbPath };
}

async function postReportIssue(
  dir: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const response = await reportIssue(new NextRequest('http://localhost/api/data/inventory-lots/report-issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

async function postResolveIssue(
  dir: string,
  issueId: number,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const response = await resolveIssue(
      new NextRequest(`http://localhost/api/issues/${issueId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: String(issueId) }) },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

function readState(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      lots: db.prepare(`
        SELECT id, quantity, quantity_remaining, quantity_received
        FROM inventory_ledger ORDER BY id
      `).all() as LotState[],
      issues: db.prepare(`
        SELECT id, incoming_purchase_id, inventory_ledger_id, asin, sku,
               quantity, issue_type, note, status, lot_shrunk, removed_unit_cost_cents
        FROM receiving_issues ORDER BY id
      `).all(),
      purchases: db.prepare(`
        SELECT id, quantity_received, status, inventory_ledger_id
        FROM incoming_purchases ORDER BY id
      `).all(),
      allocations: db.prepare(`
        SELECT incoming_purchase_id, inventory_ledger_id, receiving_issue_id,
               quantity_good, quantity_issue, sku, source
        FROM incoming_receipt_allocations ORDER BY id
      `).all(),
      expenses: db.prepare(`
        SELECT category, amount, description FROM expenses ORDER BY id
      `).all(),
    };
  } finally {
    db.close();
  }
}

test('batch report issue shrinks unreceived lot basis and creates an open receiving issue', async () => {
  const fixture = makeFixture();
  try {
    const result = await postReportIssue(fixture.dir, {
      ilId: 10,
      quantity: 2,
      issueType: 'damaged',
      note: 'corner crushed',
      expectedLotQuantity: 5,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.lotQuantity, 3);
    assert.equal(result.body.lotQuantityRemaining, 3);
    assert.equal(result.body.linkedIncomingId, null);
    const state = readState(fixture.dbPath);
    assert.deepEqual(state.lots.find((row) => row.id === 10), {
      id: 10,
      quantity: 3,
      quantity_remaining: 3,
      quantity_received: 2,
    });
    assert.deepEqual(state.issues, [{
      id: 1,
      incoming_purchase_id: null,
      inventory_ledger_id: 10,
      asin: 'BATCH-ASIN',
      sku: 'BATCH-SKU',
      quantity: 2,
      issue_type: 'damaged',
      note: 'corner crushed',
      status: 'open',
      lot_shrunk: 1,
      removed_unit_cost_cents: 1250,
    }]);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('batch report issue rejects quantities above remaining or above unreceived units', async () => {
  const fixture = makeFixture();
  try {
    const overRemaining = await postReportIssue(fixture.dir, {
      ilId: 10,
      quantity: 6,
      issueType: 'damaged',
      expectedLotQuantity: 5,
    });
    const overUnreceived = await postReportIssue(fixture.dir, {
      ilId: 10,
      quantity: 4,
      issueType: 'damaged',
      expectedLotQuantity: 5,
    });

    assert.equal(overRemaining.status, 400);
    assert.match(String(overRemaining.body.error), /remaining/i);
    assert.equal(overUnreceived.status, 400);
    assert.match(String(overUnreceived.body.error), /unreceived/i);
    assert.equal(readState(fixture.dbPath).issues.length, 0);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('batch report issue linked to incoming writes allocation audit and bumps received count', async () => {
  const fixture = makeFixture();
  try {
    const result = await postReportIssue(fixture.dir, {
      ilId: 20,
      quantity: 2,
      issueType: 'not_as_described',
      note: 'wrong edition',
      expectedLotQuantity: 4,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.linkedIncomingId, 100);
    const state = readState(fixture.dbPath);
    assert.deepEqual(state.purchases, [{
      id: 100,
      quantity_received: 3,
      status: 'received',
      inventory_ledger_id: 20,
    }]);
    assert.deepEqual(state.lots.find((row) => row.id === 20), {
      id: 20,
      quantity: 2,
      quantity_remaining: 2,
      quantity_received: 1,
    });
    assert.deepEqual(state.allocations, [{
      incoming_purchase_id: 100,
      inventory_ledger_id: 20,
      receiving_issue_id: 1,
      quantity_good: 0,
      quantity_issue: 2,
      sku: 'LINK-SKU',
      source: 'receive',
    }]);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('batch report issue skips the received bump when the incoming row lacks outstanding units', async () => {
  const fixture = makeFixture();
  try {
    // Incoming purchase 100 has 3 ordered / 1 received → 2 outstanding.
    // Reporting 3 issue units would over-receive it, so the issue must be
    // created and linked but the purchase row left untouched.
    const result = await postReportIssue(fixture.dir, {
      ilId: 20,
      quantity: 3,
      issueType: 'damaged',
      expectedLotQuantity: 4,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.linkedIncomingId, 100);
    const state = readState(fixture.dbPath);
    assert.deepEqual(state.purchases, [{
      id: 100,
      quantity_received: 1,
      status: 'partial',
      inventory_ledger_id: 20,
    }]);
    assert.deepEqual(state.lots.find((row) => row.id === 20), {
      id: 20,
      quantity: 1,
      quantity_remaining: 1,
      quantity_received: 1,
    });
    assert.equal(state.allocations.length, 0);
    assert.equal((state.issues[0] as { incoming_purchase_id: number | null }).incoming_purchase_id, 100);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

function mutateDb(dbPath: string, sql: string, ...args: unknown[]) {
  const db = new Database(dbPath);
  try { db.prepare(sql).run(...args); } finally { db.close(); }
}

test('batch report issue rejects stale expected lot state so a retry cannot double-shrink', async () => {
  const fixture = makeFixture();
  try {
    const first = await postReportIssue(fixture.dir, {
      ilId: 10,
      quantity: 1,
      issueType: 'damaged',
      expectedLotQuantity: 5,
    });
    assert.equal(first.status, 200);

    // Simulated lost-response retry: same payload, same (now stale) expectation.
    const retry = await postReportIssue(fixture.dir, {
      ilId: 10,
      quantity: 1,
      issueType: 'damaged',
      expectedLotQuantity: 5,
    });

    assert.equal(retry.status, 409);
    assert.match(String(retry.body.error), /changed since/i);
    const state = readState(fixture.dbPath);
    assert.equal(state.issues.length, 1);
    assert.deepEqual(state.lots.find((row) => row.id === 10), {
      id: 10,
      quantity: 4,
      quantity_remaining: 4,
      quantity_received: 2,
    });

    const missingExpectation = await postReportIssue(fixture.dir, {
      ilId: 10,
      quantity: 1,
      issueType: 'damaged',
    });
    assert.equal(missingExpectation.status, 400);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('batch report issue never resurrects a cancelled incoming purchase', async () => {
  const fixture = makeFixture();
  try {
    mutateDb(fixture.dbPath, `UPDATE incoming_purchases SET status = 'cancelled' WHERE id = 100`);

    const result = await postReportIssue(fixture.dir, {
      ilId: 20,
      quantity: 1,
      issueType: 'damaged',
      expectedLotQuantity: 4,
    });

    assert.equal(result.status, 200);
    // Linked for cost basis, but the cancelled row is untouched: no received
    // bump, no status flip, no allocation audit row.
    assert.equal(result.body.linkedIncomingId, 100);
    const state = readState(fixture.dbPath);
    assert.deepEqual(state.purchases, [{
      id: 100,
      quantity_received: 1,
      status: 'cancelled',
      inventory_ledger_id: 20,
    }]);
    assert.equal(state.allocations.length, 0);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('shrunk-lot issue resolution prefers lot buy price over a blank (0) incoming cost', async () => {
  const fixture = makeFixture();
  try {
    // Airtable sync stores a blank Cost as 0, not NULL. The shrink removed
    // 2 × 900¢ of real lot basis, so disposal must write off 1800¢, not 0.
    mutateDb(fixture.dbPath, `UPDATE incoming_purchases SET unit_cost_cents = 0 WHERE id = 100`);

    const opened = await postReportIssue(fixture.dir, {
      ilId: 20,
      quantity: 2,
      issueType: 'damaged',
      expectedLotQuantity: 4,
    });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.linkedIncomingId, 100);

    const resolved = await postResolveIssue(fixture.dir, Number(opened.body.issueId), {
      resolution: 'disposed',
    });

    assert.equal(resolved.status, 200);
    assert.deepEqual(readState(fixture.dbPath).expenses, [{
      category: 'Inventory Write-off',
      amount: 1800,
      description: 'Receiving issue #1: 2× LINK-SKU disposed (damaged)',
    }]);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('kept_as_is on a shrunk-lot issue restores the exact basis as a new lot', async () => {
  const fixture = makeFixture();
  try {
    const opened = await postReportIssue(fixture.dir, {
      ilId: 10,
      quantity: 2,
      issueType: 'not_as_described',
      expectedLotQuantity: 5,
    });
    assert.equal(opened.status, 200);

    const resolved = await postResolveIssue(fixture.dir, Number(opened.body.issueId), {
      resolution: 'kept_as_is',
    });
    assert.equal(resolved.status, 200);

    // Shrink removed 2 × 1250¢; the kept lot re-adds exactly that. Total
    // on-book basis for the SKU is conserved: 3×1250 + 2×1250 = 5×1250.
    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      const lots = db.prepare(
        `SELECT quantity, quantity_remaining, buy_price FROM inventory_ledger WHERE sku = 'BATCH-SKU' ORDER BY id`,
      ).all() as Array<{ quantity: number; quantity_remaining: number; buy_price: number }>;
      assert.deepEqual(lots, [
        { quantity: 3, quantity_remaining: 3, buy_price: 1250 },
        { quantity: 2, quantity_remaining: 2, buy_price: 1250 },
      ]);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('batch report issue refuses to guess between multiple linked incoming purchases', async () => {
  const fixture = makeFixture();
  try {
    mutateDb(fixture.dbPath, `
      INSERT INTO incoming_purchases (
        id, asin, sku, quantity, quantity_received, unit_cost_cents,
        ordered_at, status, inventory_ledger_id, updated_at
      ) VALUES (101, 'LINK-ASIN', 'LINK-SKU', 2, 0, 950, '2026-07-02', 'on_order', 20, '2026-07-02T00:00:00Z')
    `);

    const result = await postReportIssue(fixture.dir, {
      ilId: 20,
      quantity: 1,
      issueType: 'other',
      expectedLotQuantity: 4,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.linkedIncomingId, null);
    const state = readState(fixture.dbPath);
    assert.equal((state.issues[0] as { incoming_purchase_id: number | null }).incoming_purchase_id, null);
    assert.equal(state.allocations.length, 0);
    // Neither candidate purchase was touched.
    assert.deepEqual(
      state.purchases.map((p) => (p as { quantity_received: number }).quantity_received),
      [1, 0],
    );
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('no_impact on a lot-shrunk issue restores the lot instead of losing the basis', async () => {
  const fixture = makeFixture();
  try {
    const opened = await postReportIssue(fixture.dir, {
      ilId: 10,
      quantity: 2,
      issueType: 'other',
      note: 'flagged by mistake',
      expectedLotQuantity: 5,
    });
    assert.equal(opened.status, 200);

    const resolved = await postResolveIssue(fixture.dir, Number(opened.body.issueId), {
      resolution: 'no_impact',
    });
    assert.equal(resolved.status, 200);

    const state = readState(fixture.dbPath);
    // Units and basis are back exactly where they started.
    assert.deepEqual(state.lots.find((row) => row.id === 10), {
      id: 10,
      quantity: 5,
      quantity_remaining: 5,
      quantity_received: 2,
    });
    assert.equal(state.expenses.length, 0);
    // Flag cleared so the conservation carve-out no longer adds these
    // units back on top of the restored lot.
    const issue = state.issues[0] as { status: string; lot_shrunk: number };
    assert.equal(issue.status, 'resolved');
    assert.equal(issue.lot_shrunk, 0);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('shrunk-lot resolutions price from the snapshot, immune to later buy_price edits', async () => {
  const fixture = makeFixture();
  try {
    const opened = await postReportIssue(fixture.dir, {
      ilId: 10,
      quantity: 2,
      issueType: 'damaged',
      expectedLotQuantity: 5,
    });
    assert.equal(opened.status, 200);

    // Operator corrects the lot's buy price AFTER the report. The write-off
    // must still equal the basis the shrink actually removed (2 × 1250¢).
    mutateDb(fixture.dbPath, `UPDATE inventory_ledger SET buy_price = 9999 WHERE id = 10`);

    const resolved = await postResolveIssue(fixture.dir, Number(opened.body.issueId), {
      resolution: 'disposed',
    });
    assert.equal(resolved.status, 200);
    assert.deepEqual(readState(fixture.dbPath).expenses, [{
      category: 'Inventory Write-off',
      amount: 2500,
      description: 'Receiving issue #1: 2× BATCH-SKU disposed (damaged)',
    }]);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('unlinked batch issue resolution falls back to lot buy price for write-off amount', async () => {
  const fixture = makeFixture();
  try {
    const opened = await postReportIssue(fixture.dir, {
      ilId: 10,
      quantity: 2,
      issueType: 'wrong_item',
      expectedLotQuantity: 5,
    });
    assert.equal(opened.status, 200);

    const resolved = await postResolveIssue(fixture.dir, Number(opened.body.issueId), {
      resolution: 'disposed',
      note: 'not recoverable',
    });

    assert.equal(resolved.status, 200);
    assert.deepEqual(readState(fixture.dbPath).expenses, [{
      category: 'Inventory Write-off',
      amount: 2500,
      description: 'Receiving issue #1: 2× BATCH-SKU disposed (wrong_item)',
    }]);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
