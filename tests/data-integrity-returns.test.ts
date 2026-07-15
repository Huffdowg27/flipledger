import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DAY_MS = 86400000;
function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString();
}

// Minimal schema the data-integrity route queries unconditionally, plus the
// refunds + settings tables that gate the returns-sync checks under test.
const BASE_SCHEMA = `
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
  CREATE TABLE inventory_ledger (
    id INTEGER PRIMARY KEY,
    asin TEXT NOT NULL,
    sku TEXT,
    buy_price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    quantity_remaining INTEGER NOT NULL,
    list_price_cents INTEGER,
    date_purchased TEXT NOT NULL,
    listing_batch_import_id INTEGER
  );
  CREATE TABLE incoming_purchases (
    id INTEGER PRIMARY KEY,
    order_ref TEXT,
    asin TEXT,
    sku TEXT,
    quantity INTEGER NOT NULL,
    quantity_received INTEGER NOT NULL,
    unit_cost_cents INTEGER,
    status TEXT NOT NULL,
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
  CREATE TABLE refunds (
    id INTEGER PRIMARY KEY,
    order_id TEXT NOT NULL,
    refund_date TEXT NOT NULL,
    asin TEXT,
    sku TEXT,
    quantity INTEGER DEFAULT 1,
    refund_amount INTEGER NOT NULL,
    marketplace TEXT DEFAULT 'amazon',
    inventory_restored_quantity INTEGER NOT NULL DEFAULT 0,
    inventory_restore_error TEXT,
    inventory_restore_checked_at TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

async function runIntegrityRoute(dir: string): Promise<{
  status: number;
  checks: Map<string, { severity: string; count: number; sample: Record<string, unknown>[] }>;
}> {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/data-integrity/route');
    const response = await GET();
    const body = await response.json();
    assert.equal(response.status, 200, `route errored: ${JSON.stringify(body)}`);
    return {
      status: response.status,
      checks: new Map(
        body.checks.map(
          (check: { id: string; severity: string; count: number; sample: Record<string, unknown>[] }) => [check.id, check],
        ),
      ),
    };
  } finally {
    process.chdir(previousCwd);
  }
}

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipledger-integrity-returns-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(BASE_SCHEMA);
  db.close();
  return dir;
}

test('confirmed returns FIFO could not restore are surfaced as an error check', async () => {
  const dir = makeFixture();
  try {
    const db = new Database(path.join(dir, 'data', 'flipledger.db'));
    db.prepare(`
      INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount,
                           inventory_restored_quantity, inventory_restore_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('113-000-BLOCKED', isoDaysAgo(10), 'A-BLOCKED', 'BLOCKED-SKU', 1, 3412, 0,
           '1 of 1 confirmed unit could not be restored to a recorded FIFO lot');
    db.prepare(`
      INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount,
                           inventory_restored_quantity, inventory_restore_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('113-000-CLEAN', isoDaysAgo(5), 'A-CLEAN', 'CLEAN-SKU', 1, 1999, 1, null);
    db.close();

    const { checks } = await runIntegrityRoute(dir);
    const check = checks.get('return_restore_mismatches');
    assert.ok(check, 'return_restore_mismatches check missing');
    assert.equal(check.severity, 'error');
    assert.equal(check.count, 1);
    assert.equal(check.sample.length, 1);
    assert.equal(check.sample[0].orderId, '113-000-BLOCKED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clean restores leave the return-restore check ok', async () => {
  const dir = makeFixture();
  try {
    const db = new Database(path.join(dir, 'data', 'flipledger.db'));
    db.prepare(`
      INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount,
                           inventory_restored_quantity, inventory_restore_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('113-000-CLEAN', isoDaysAgo(5), 'A-CLEAN', 'CLEAN-SKU', 1, 1999, 1, null);
    db.close();

    const { checks } = await runIntegrityRoute(dir);
    const check = checks.get('return_restore_mismatches');
    assert.ok(check, 'return_restore_mismatches check missing');
    assert.equal(check.severity, 'ok');
    assert.equal(check.count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('customer-returns sync wedged past 72h of failed attempts is an error', async () => {
  const dir = makeFixture();
  try {
    const db = new Database(path.join(dir, 'data', 'flipledger.db'));
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
      .run('customer_returns_last_sync', isoDaysAgo(12));
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
      .run('customer_returns_last_sync_attempted_at', isoDaysAgo(0));
    db.close();

    const { checks } = await runIntegrityRoute(dir);
    const check = checks.get('customer_returns_sync_wedged');
    assert.ok(check, 'customer_returns_sync_wedged check missing');
    assert.equal(check.severity, 'error');
    assert.equal(check.count, 1);
    assert.equal(check.sample.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a recent successful customer-returns sync is not wedged', async () => {
  const dir = makeFixture();
  try {
    const db = new Database(path.join(dir, 'data', 'flipledger.db'));
    // Success newer than the wedge window, with a later failed attempt — the
    // normal "one bad day" case must not alarm.
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
      .run('customer_returns_last_sync', isoDaysAgo(1));
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
      .run('customer_returns_last_sync_attempted_at', isoDaysAgo(0));
    db.close();

    const { checks } = await runIntegrityRoute(dir);
    const check = checks.get('customer_returns_sync_wedged');
    assert.ok(check, 'customer_returns_sync_wedged check missing');
    assert.equal(check.severity, 'ok');
    assert.equal(check.count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
