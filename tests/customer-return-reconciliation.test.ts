import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  applyCustomerReturnRows,
  type CustomerReturnRow,
} from '../src/lib/sp-api/customerReturns';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE refunds (
      id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL,
      refund_date TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      quantity INTEGER DEFAULT 1,
      refund_amount INTEGER NOT NULL,
      reason TEXT,
      disposition TEXT,
      item_returned INTEGER DEFAULT 0,
      inventory_restored_quantity INTEGER NOT NULL DEFAULT 0,
      inventory_restore_error TEXT,
      inventory_restore_checked_at TEXT,
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      sku TEXT,
      asin TEXT,
      quantity INTEGER,
      quantity_remaining INTEGER
    );
  `);
  return db;
}

function returned(overrides: Partial<CustomerReturnRow> = {}): CustomerReturnRow {
  return {
    returnDate: '2026-06-02T00:00:00Z',
    orderId: 'O1',
    sku: 'SKU-1',
    asin: 'ASIN-1',
    fnsku: null,
    productName: null,
    quantity: 1,
    fulfillmentCenterId: null,
    detailedDisposition: 'SELLABLE',
    reason: 'UNWANTED_ITEM',
    status: null,
    licensePlateNumber: null,
    customerComments: null,
    ...overrides,
  };
}

test('confirmed SELLABLE return is recorded independently from FIFO restoration', () => {
  const db = makeDb();
  db.prepare(`
    INSERT INTO refunds (
      id, order_id, refund_date, asin, sku, quantity, refund_amount,
      reason, disposition, item_returned, marketplace, created_at
    ) VALUES (
      1, 'O1', '2026-06-01', 'ASIN-1', 'SKU-1', 1, -2000,
      'CUSTOMER_RETURN', NULL, 0, 'amazon', '2026-06-01'
    )
  `).run();
  db.prepare(`
    INSERT INTO inventory_ledger (id, sku, asin, quantity, quantity_remaining)
    VALUES (1, 'SKU-1', 'ASIN-1', 1, 0)
  `).run();

  const result = applyCustomerReturnRows(db, [returned()]);
  const refund = db.prepare(`
    SELECT reason, disposition, item_returned confirmed,
      inventory_restored_quantity restored, inventory_restore_error error
    FROM refunds WHERE id = 1
  `).get();
  const lot = db.prepare('SELECT quantity_remaining remaining FROM inventory_ledger WHERE id = 1').get();
  db.close();

  assert.deepEqual(result, {
    refundsMatched: 1,
    refundsUpdated: 1,
    unmatched: 0,
    ambiguous: 0,
    quantityMismatches: 0,
    returnsConfirmed: 1,
    reasonBreakdown: { UNWANTED_ITEM: 1 },
  });
  assert.deepEqual(refund, {
    reason: 'UNWANTED_ITEM',
    disposition: 'SELLABLE',
    confirmed: 1,
    restored: 0,
    error: null,
  });
  assert.deepEqual(lot, { remaining: 0 }, 'report matching must not mutate FIFO lots directly');
});

test('non-SELLABLE report row updates disposition without confirming a restorable return', () => {
  const db = makeDb();
  db.prepare(`
    INSERT INTO refunds (
      id, order_id, refund_date, asin, sku, quantity, refund_amount,
      reason, disposition, item_returned, marketplace, created_at
    ) VALUES (
      1, 'O1', '2026-06-01', 'ASIN-1', 'SKU-1', 1, -2000,
      'CUSTOMER_RETURN', 'SELLABLE', 1, 'amazon', '2026-06-01'
    )
  `).run();

  const result = applyCustomerReturnRows(db, [
    returned({ detailedDisposition: 'CUSTOMER_DAMAGED', reason: 'DEFECTIVE' }),
  ]);
  const refund = db.prepare(`
    SELECT reason, disposition, item_returned confirmed FROM refunds WHERE id = 1
  `).get();
  db.close();

  assert.equal(result.returnsConfirmed, 0);
  assert.deepEqual(refund, {
    reason: 'DEFECTIVE',
    disposition: 'CUSTOMER_DAMAGED',
    confirmed: 0,
  });
});

test('ambiguous refund candidates fail closed instead of double-confirming a return', () => {
  const db = makeDb();
  const insert = db.prepare(`
    INSERT INTO refunds (
      id, order_id, refund_date, asin, sku, quantity, refund_amount,
      reason, disposition, item_returned, marketplace, created_at
    ) VALUES (?, 'O1', ?, 'ASIN-1', 'SKU-1', 1, ?, 'CUSTOMER_RETURN', NULL, 0, 'amazon', ?)
  `);
  insert.run(1, '2026-06-01', -1200, '2026-06-01');
  insert.run(2, '2026-06-02', -800, '2026-06-02');

  const result = applyCustomerReturnRows(db, [returned()]);
  const confirmed = db.prepare('SELECT SUM(item_returned) total FROM refunds').get() as { total: number };
  db.close();

  assert.equal(result.refundsMatched, 0);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.returnsConfirmed, 0);
  assert.equal(confirmed.total, 0);
});

test('report and financial-refund quantity disagreement fails closed', () => {
  const db = makeDb();
  db.prepare(`
    INSERT INTO refunds (
      id, order_id, refund_date, asin, sku, quantity, refund_amount,
      reason, disposition, item_returned, marketplace, created_at
    ) VALUES (
      1, 'O1', '2026-06-01', 'ASIN-1', 'SKU-1', 1, -2000,
      'CUSTOMER_RETURN', NULL, 0, 'amazon', '2026-06-01'
    )
  `).run();

  const result = applyCustomerReturnRows(db, [returned({ quantity: 2 })]);
  const refund = db.prepare(`
    SELECT reason, disposition, item_returned confirmed FROM refunds WHERE id = 1
  `).get();
  db.close();

  assert.equal(result.refundsMatched, 0);
  assert.equal(result.quantityMismatches, 1);
  assert.equal(result.returnsConfirmed, 0);
  assert.deepEqual(refund, {
    reason: 'CUSTOMER_RETURN',
    disposition: null,
    confirmed: 0,
  });
});
