import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('data integrity reports receipt/import identity failures and legacy reconciliation candidates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-identity-integrity-'));
  const previousCwd = process.cwd();
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
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
      status TEXT NOT NULL,
      inventory_ledger_id INTEGER,
      receipt_allocation_baseline INTEGER NOT NULL DEFAULT 0,
      receipt_identity_started_at TEXT
    );
    CREATE TABLE receiving_issues (
      id INTEGER PRIMARY KEY,
      incoming_purchase_id INTEGER
    );
    CREATE TABLE incoming_receipt_allocations (
      id INTEGER PRIMARY KEY,
      receipt_key TEXT NOT NULL,
      incoming_purchase_id INTEGER NOT NULL,
      inventory_ledger_id INTEGER,
      receiving_issue_id INTEGER,
      quantity_good INTEGER NOT NULL,
      quantity_issue INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
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
    CREATE TABLE listing_batch_items (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      buy_price_cents INTEGER NOT NULL,
      listing_batch_import_id INTEGER,
      listing_status TEXT
    );

    INSERT INTO incoming_purchases VALUES
      (1, 'RECEIPT-MISMATCH', 'B000000001', 'SKU-RECEIPT', 2, 2, 'received', 1, 0, '2026-07-05T00:00:00Z'),
      (2, 'LEGACY-CANDIDATE', 'B000000002', 'SKU-LEGACY', 1, 0, 'on_order', NULL, 0, NULL);
    INSERT INTO incoming_receipt_allocations VALUES
      (1, 'receipt-under-counted', 1, 1, NULL, 1, 0, 'receive', '2026-07-05T00:00:00Z'),
      (2, 'receipt-orphan', 999, 999, NULL, 1, 0, 'receive', '2026-07-05T00:00:00Z');

    INSERT INTO listing_batches VALUES
      (1, 'MFN', 'closed', NULL),
      (2, 'MFN', 'sending', '2026-07-06T00:00:00Z');
    INSERT INTO listing_batch_imports VALUES
      (1, 1, 'hash-1', 1, 2, 2400, 6000);
    INSERT INTO listing_batch_items VALUES
      (1, 2, 'SKU-STUCK', 1, 1200, NULL, 'PROCESSING');
    INSERT INTO inventory_ledger VALUES
      (1, 'B000000001', 'SKU-RECEIPT', 1200, 1, 1, NULL, '2026-07-01', NULL),
      (2, 'B000000002', 'SKU-LEGACY', 1500, 1, 1, NULL, '2026-07-01', NULL),
      (3, 'B000000003', 'SKU-IMPORT', 1200, 1, 1, 3000, '2026-07-01', 1),
      (4, 'B000000004', 'SKU-ORPHAN-IMPORT', 900, 1, 1, 2000, '2026-07-01', 999);
  `);
  db.close();

  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/data-integrity/route');
    const response = await GET();
    const body = await response.json();
    const checks = new Map<string, {
      severity: string;
      count: number;
      units?: number;
      sample: Array<Record<string, unknown>>;
    }>(body.checks.map((check: { id: string }) => [check.id, check]));

    assert.equal(response.status, 200);
    assert.deepEqual(
      {
        severity: checks.get('receipt_allocation_conservation')?.severity,
        count: checks.get('receipt_allocation_conservation')?.count,
        units: checks.get('receipt_allocation_conservation')?.units,
      },
      { severity: 'error', count: 1, units: 1 },
    );
    assert.equal(checks.get('receipt_identity_integrity')?.severity, 'error');
    assert.equal(checks.get('receipt_identity_integrity')?.count, 1);
    assert.equal(checks.get('buylist_import_conservation')?.severity, 'error');
    assert.equal(checks.get('buylist_import_conservation')?.count, 1);
    assert.equal(checks.get('buylist_import_identity')?.severity, 'error');
    assert.equal(checks.get('buylist_import_identity')?.count, 1);
    assert.equal(checks.get('mfn_stale_sending_batches')?.severity, 'error');
    assert.equal(checks.get('mfn_stale_sending_batches')?.count, 1);
    assert.equal(checks.get('mfn_stale_sending_batches')?.sample[0]?.sku, 'SKU-STUCK');
    assert.equal(checks.get('legacy_incoming_reconciliation')?.severity, 'warn');
    assert.equal(checks.get('legacy_incoming_reconciliation')?.count, 1);
    assert.equal(checks.get('legacy_incoming_reconciliation')?.sample[0]?.orderRef, 'LEGACY-CANDIDATE');
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
