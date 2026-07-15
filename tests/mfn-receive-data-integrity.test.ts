import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

function makeIntegrityFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfn-receive-integrity-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const dbPath = path.join(dir, 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      purchase_date TEXT NOT NULL
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      cogs_per_unit INTEGER
    );
    CREATE TABLE products (
      asin TEXT PRIMARY KEY,
      name TEXT
    );
    CREATE TABLE incoming_purchases (
      id INTEGER PRIMARY KEY,
      order_ref TEXT,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      quantity_received INTEGER NOT NULL,
      unit_cost_cents INTEGER,
      ordered_at TEXT,
      status TEXT NOT NULL,
      inventory_ledger_id INTEGER,
      receipt_allocation_baseline INTEGER NOT NULL DEFAULT 0,
      receipt_identity_started_at TEXT
    );
    CREATE TABLE receiving_issues (
      id INTEGER PRIMARY KEY,
      incoming_purchase_id INTEGER,
      inventory_ledger_id INTEGER,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      issue_type TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL,
      lot_shrunk INTEGER NOT NULL DEFAULT 0,
      removed_unit_cost_cents INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE incoming_receipt_allocations (
      id INTEGER PRIMARY KEY,
      receipt_key TEXT NOT NULL,
      incoming_purchase_id INTEGER NOT NULL,
      inventory_ledger_id INTEGER,
      receiving_issue_id INTEGER,
      quantity_good INTEGER NOT NULL,
      quantity_issue INTEGER NOT NULL
    );
    CREATE TABLE listing_batches (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL,
      status TEXT,
      sent_at TEXT
    );
    CREATE TABLE listing_batch_imports (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      rows_imported INTEGER NOT NULL,
      total_units INTEGER NOT NULL,
      total_cost_cents INTEGER NOT NULL,
      total_list_value_cents INTEGER NOT NULL
    );
    CREATE TABLE listing_batch_items (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      buy_price_cents INTEGER NOT NULL,
      listing_batch_import_id INTEGER,
      listing_status TEXT
    );
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      asin TEXT NOT NULL,
      sku TEXT,
      buy_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL,
      quantity_received INTEGER,
      received_at TEXT,
      list_price_cents INTEGER,
      date_purchased TEXT NOT NULL,
      listing_batch_import_id INTEGER
    );

    INSERT INTO listing_batches VALUES (1, 'MFN', 'receiving', NULL);
    INSERT INTO inventory_ledger VALUES
      (1, 'B000OPEN01', 'MFN-OPEN', 1200, 1, 1, 1, '2026-07-14T12:00:00Z', NULL, '2026-07-14', NULL),
      (2, 'B000CLEAN1', 'MFN-CLEAN', 900, 1, 1, 1, '2026-07-14T12:00:00Z', NULL, '2026-07-10', NULL);
    INSERT INTO incoming_purchases VALUES
      (10, 'OPEN-ORDER', 'B000OPEN01', 'MFN-OPEN', 1, 0, 1200, '2026-07-08', 'on_order', NULL, 0, NULL),
      (20, 'LINKED-PARTIAL', 'B000CLEAN1', 'MFN-CLEAN', 2, 1, 900, '2026-07-10', 'partial', 2, 0, NULL);
    INSERT INTO incoming_receipt_allocations VALUES
      (1, 'linked-partial', 20, 2, NULL, 1, 0);
  `);
  db.close();
  return { dir, dbPath };
}

async function integrityChecks(dir: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/data-integrity/route');
    const response = await GET();
    const body = await response.json();
    assert.equal(response.status, 200);
    return new Map<string, { severity: string; count: number; units?: number; sample: Array<Record<string, unknown>> }>(
      body.checks.map((check: { id: string }) => [check.id, check]),
    );
  } finally {
    process.chdir(previousCwd);
  }
}

test('data integrity warns on received MFN lot with open same-ASIN incoming order and clears when closed', async () => {
  const fixture = makeIntegrityFixture();
  try {
    const before = await integrityChecks(fixture.dir);
    const warning = before.get('received_local_lot_open_incoming');
    assert.equal(warning?.severity, 'warn');
    assert.equal(warning?.count, 1);
    assert.equal(warning?.units, 1);
    assert.equal(warning?.sample[0]?.incomingPurchaseId, 10);
    assert.equal(warning?.sample[0]?.inventoryLedgerId, 1);

    const db = new Database(fixture.dbPath);
    db.prepare("UPDATE incoming_purchases SET status = 'received', quantity_received = quantity, inventory_ledger_id = 1 WHERE id = 10").run();
    db.close();

    const after = await integrityChecks(fixture.dir);
    const clean = after.get('received_local_lot_open_incoming');
    assert.equal(clean?.severity, 'ok');
    assert.equal(clean?.count, 0);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
