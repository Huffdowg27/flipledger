import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DAY_MS = 86400000;
function utcStamp(daysAgo: number, time = '12:00:00'): string {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  return `${d.toISOString().slice(0, 10)} ${time} UTC`;
}


test('data integrity measures zero-COGS coverage only in the synced accounting era', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipledger-integrity-era-'));
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
    CREATE TABLE settlement_periods (
      id INTEGER PRIMARY KEY,
      settlement_id TEXT NOT NULL UNIQUE,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      deposit_date TEXT
    );
    CREATE TABLE settlement_transactions (
      id INTEGER PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      order_id TEXT,
      sku TEXT,
      posted_date TEXT,
      transaction_type TEXT,
      amount_type TEXT,
      amount_description TEXT,
      amount_cents INTEGER NOT NULL
    );

    INSERT INTO orders VALUES
      ('HISTORICAL', 'Shipped', '2025-12-31T12:00:00Z'),
      ('MISSING', 'Shipped', '2026-06-20T12:00:00Z'),
      ('MISSING-NULL-SKU', 'Shipped', '2026-06-20T13:00:00Z'),
      ('COVERED', 'Shipped', '2026-06-21T12:00:00Z'),
      ('SAFE-FALLBACK', 'Shipped', '2026-06-21T13:00:00Z'),
      ('CONFLICT-FALLBACK', 'Shipped', '2026-06-21T14:00:00Z'),
      ('GRADED', 'Shipped', '2026-06-22T12:00:00Z');
    INSERT INTO order_items VALUES
      (1, 'HISTORICAL', 'A-HIST', 'OLD-SKU', 3, 15000, 0),
      (2, 'MISSING', 'A-MISSING', 'CURRENT-SKU', 1, 7196, 0),
      (5, 'MISSING-NULL-SKU', 'A-MISSING-NULL', NULL, 1, 3000, 0),
      (3, 'COVERED', 'A-COVERED', 'COVERED-SKU', 1, 5000, 2500),
      (6, 'SAFE-FALLBACK', 'A-SAFE', 'RELABEL-SAFE', 1, 4000, 1000),
      (7, 'CONFLICT-FALLBACK', 'A-CONFLICT', 'RELABEL-CONFLICT', 1, 4000, 1000),
      (4, 'GRADED', 'A-GRADED', 'amzn.gr.OLD-SKU', 2, 6000, 0);
    INSERT INTO inventory_ledger VALUES
      (1, 'A-COVERED', 'COVERED-SKU', 2500, 1, 0, NULL, '2026-06-01', NULL),
      (2, 'A-SAFE', 'SAFE-LOT-1', 1000, 1, 0, NULL, '2026-06-01', NULL),
      (3, 'A-SAFE', 'SAFE-LOT-2', 1000, 1, 0, NULL, '2026-06-02', NULL),
      (4, 'A-CONFLICT', 'CONFLICT-LOT-1', 1000, 1, 0, NULL, '2026-06-01', NULL),
      (5, 'A-CONFLICT', 'CONFLICT-LOT-2', 2000, 1, 1, NULL, '2026-06-02', NULL),
      (6, 'A-GRADED', 'GRADE-LOT-1', 3000, 1, 0, NULL, '2026-06-01', NULL),
      (7, 'A-GRADED', 'GRADE-LOT-2', 4000, 1, 1, NULL, '2026-06-02', NULL),
      (8, 'A-IMPORT-SHRUNK', 'IMP-SKU-1', 1250, 3, 3, NULL, '2026-06-01', 1),
      (9, 'A-IMPORT-BROKEN', 'IMP-SKU-2', 1000, 2, 2, NULL, '2026-06-01', 2);
    INSERT INTO listing_batches VALUES (1, 'MFN', 'receiving', NULL);
    -- Import 1: receipt says 5 units / 6250c; the lot holds 3 after a
    -- lot-shrunk issue removed 2 — must reconcile via the carve-out.
    -- Import 2: receipt says 3 units but the lot holds 2 with no shrunk
    -- issue — a genuine conservation break that must still be flagged.
    INSERT INTO listing_batch_imports VALUES
      (1, 1, 'hash-import-shrunk', 1, 5, 6250, 0),
      (2, 1, 'hash-import-broken', 1, 3, 3000, 0);
    INSERT INTO receiving_issues VALUES
      (1, NULL, 8, 'A-IMPORT-SHRUNK', 'IMP-SKU-1', 2, 'damaged', NULL, 'open', 1, 1250,
       '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z');
    INSERT INTO settlement_periods VALUES
      (1, 'ZERO-JUNE', 'amazon', '${utcStamp(34)}', '${utcStamp(33)}', '${utcStamp(31)}'),
      (2, 'SPARSE-JUNE', 'amazon', '${utcStamp(25)}', '${utcStamp(15)}', '${utcStamp(13)}'),
      (3, 'DENSE-JUNE', 'amazon', '${utcStamp(15)}', '${utcStamp(12)}', '${utcStamp(10)}');
    INSERT INTO settlement_transactions
      (settlement_id, order_id, sku, posted_date, transaction_type, amount_type, amount_description, amount_cents)
    VALUES
      ('SPARSE-JUNE', 'O-1', 'S-1', '2026-06-12', 'Order', 'ItemPrice', 'Principal', 1000),
      ('SPARSE-JUNE', 'O-2', 'S-2', '2026-06-13', 'Order', 'ItemPrice', 'Principal', 1000),
      ('SPARSE-JUNE', 'O-3', 'S-3', '2026-06-14', 'Order', 'ItemPrice', 'Principal', 1000),
      ('DENSE-JUNE', 'O-4', 'S-4', '2026-06-22', 'Order', 'ItemPrice', 'Principal', 1000),
      ('DENSE-JUNE', 'O-5', 'S-5', '2026-06-22', 'Order', 'ItemPrice', 'Principal', 1000),
      ('DENSE-JUNE', 'O-6', 'S-6', '2026-06-23', 'Order', 'ItemPrice', 'Principal', 1000),
      ('DENSE-JUNE', 'O-7', 'S-7', '2026-06-23', 'Order', 'ItemPrice', 'Principal', 1000),
      ('DENSE-JUNE', 'O-8', 'S-8', '2026-06-24', 'Order', 'ItemPrice', 'Principal', 1000);
  `);
  db.close();

  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/data-integrity/route');
    const response = await GET();
    const body = await response.json();
    const checks = new Map<string, { count: number }>(
      body.checks.map((check: { id: string; count: number }) => [check.id, check]),
    );

    assert.equal(response.status, 200);
    const { cogsCoveragePct, ...integerSummary } = body.summary;
    assert.equal(cogsCoveragePct, 60);
    assert.deepEqual(integerSummary, {
      totalUnits: 5,
      coveredUnits: 3,
      zeroCogsUnits: 2,
      zeroCogsRevenueCents: 10196,
    });
    assert.equal(checks.get('zero_cogs_sales')?.count, 2);
    assert.equal(checks.get('sold_without_lot')?.count, 2);
    assert.equal(checks.get('fifo_fallback_collision')?.count, 1);
    // Lot-shrunk issues reconcile against the import receipt; only the
    // genuinely-broken import trips conservation.
    const importConservation = checks.get('buylist_import_conservation') as unknown as {
      count: number;
      sample: { importId: number }[];
    };
    assert.equal(importConservation.count, 1);
    assert.deepEqual(importConservation.sample.map((row) => row.importId), [2]);
    assert.equal(checks.get('receiving_issue_cost_basis')?.count, 0);
    const settlementCoverage = checks.get('settlement_transaction_coverage') as {
      severity: string;
      count: number;
      sample: { settlementId: string; reason: string }[];
    };
    assert.equal(settlementCoverage.severity, 'error');
    assert.equal(settlementCoverage.count, 2);
    assert.deepEqual(
      settlementCoverage.sample.map((row) => [row.settlementId, row.reason]),
      [
        ['SPARSE-JUNE', 'sparse'],
        ['ZERO-JUNE', 'zero_rows'],
      ],
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
