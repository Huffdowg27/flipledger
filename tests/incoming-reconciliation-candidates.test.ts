import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GET } from '../src/app/api/incoming/route';

interface IncomingPayloadRow {
  id: number;
  reconciliationCandidates: Array<Record<string, unknown>>;
  bulkReconciliation?: Record<string, unknown>;
  highConfidenceReconciliation?: boolean;
  selectedInventoryLedgerId?: number;
}

test('incoming payload exposes candidate lots without selecting one automatically', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incoming-candidates-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const dbPath = path.join(dir, 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE incoming_purchases (
      id INTEGER PRIMARY KEY,
      airtable_record_id TEXT,
      order_source TEXT,
      order_ref TEXT,
      asin TEXT,
      sku TEXT,
      product_name TEXT,
      image_url TEXT,
      quantity INTEGER NOT NULL,
      quantity_received INTEGER NOT NULL DEFAULT 0,
      unit_cost_cents INTEGER NOT NULL,
      profit_cents INTEGER,
      ordered_at TEXT,
      tracking_number TEXT,
      delivery_status TEXT,
      status TEXT NOT NULL,
      received_at TEXT,
      inventory_ledger_id INTEGER,
      notes TEXT,
      snoozed_until TEXT
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
    CREATE TABLE incoming_receipt_allocations (
      id INTEGER PRIMARY KEY,
      inventory_ledger_id INTEGER,
      quantity_good INTEGER NOT NULL
    );
    CREATE TABLE receiving_issues (
      id INTEGER PRIMARY KEY,
      incoming_purchase_id INTEGER,
      inventory_ledger_id INTEGER,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      issue_type TEXT,
      note TEXT,
      status TEXT,
      resolution TEXT,
      refund_cents INTEGER,
      resolved_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE merchant_listings (
      sku TEXT, asin TEXT, marketplace TEXT, status TEXT
    );
    INSERT INTO incoming_purchases (
      id, asin, sku, product_name, quantity, quantity_received,
      unit_cost_cents, ordered_at, status
    ) VALUES
      (1, 'B000000001', 'SKU-1', 'Legacy exact SKU', 2, 0, 1200, '2026-06-01', 'on_order'),
      (2, 'B000000002', NULL, 'Legacy ASIN fallback', 1, 0, 1500, '2026-06-02', 'on_order'),
      (3, 'B000000003', 'SKU-NEW', 'Actually incoming', 1, 0, 1800, '2026-07-05', 'on_order'),
      (4, 'B000000004', 'SKU-HC', 'High confidence legacy row', 1, 0, 1800, '2026-07-01', 'on_order');
    INSERT INTO inventory_ledger (
      id, asin, sku, buy_price, quantity, quantity_remaining,
      quantity_received, date_purchased, received_at, bin_location, created_at
    ) VALUES
      (10, 'B000000001', 'SKU-1', 1200, 2, 1, 2,
       '2026-06-10', '2026-06-10T12:00:00Z', 'R1-A1', '2026-06-10T12:00:00Z'),
      (20, 'B000000002', 'SKU-OTHER', 1500, 1, 1, NULL,
       '2026-06-11', '2026-06-11T12:00:00Z', 'R1-B1', '2026-06-11T12:00:00Z'),
      (30, 'B000000004', 'SKU-HC', 1800, 1, 1, 1,
       '2026-07-02', '2026-07-02T12:00:00Z', 'R1-C1', '2026-07-02T12:00:00Z');
    INSERT INTO incoming_receipt_allocations (id, inventory_ledger_id, quantity_good)
    VALUES (1, 10, 1);
  `);
  db.close();

  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const response = await GET();
    const payload = await response.json();
    const rows = payload.open as IncomingPayloadRow[];

    assert.equal(response.status, 200);
    assert.equal(payload.stats.reconciliationCandidateCount, 3);
    assert.equal(payload.stats.highConfidenceReconciliationCount, 1);
    assert.deepEqual(rows.find((row) => row.id === 1)?.reconciliationCandidates, [{
      inventoryLedgerId: 10,
      asin: 'B000000001',
      sku: 'SKU-1',
      quantity: 2,
      quantityReceived: 2,
      quantityRemaining: 1,
      attributedUnits: 1,
      availableToReconcile: 1,
      buyPriceCents: 1200,
      datePurchased: '2026-06-10',
      receivedAt: '2026-06-10T12:00:00Z',
      binLocation: 'R1-A1',
      matchType: 'sku',
    }]);
    assert.equal(rows.find((row) => row.id === 1)?.selectedInventoryLedgerId, undefined);
    assert.deepEqual(rows.find((row) => row.id === 1)?.bulkReconciliation, {
      highConfidence: false,
      reason: 'insufficient_available',
    });
    assert.equal(rows.find((row) => row.id === 2)?.reconciliationCandidates[0].matchType, 'asin');
    assert.deepEqual(rows.find((row) => row.id === 3)?.reconciliationCandidates, []);
    assert.deepEqual(rows.find((row) => row.id === 4)?.bulkReconciliation, {
      highConfidence: true,
      inventoryLedgerId: 30,
      quantity: 1,
      lotDate: '2026-07-02T12:00:00Z',
    });
    assert.equal(rows.find((row) => row.id === 4)?.highConfidenceReconciliation, true);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
