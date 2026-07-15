import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { storeShippingLabelFee } from '../src/lib/shipping-label-events';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE financial_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      posted_date TEXT NOT NULL,
      order_id TEXT,
      asin TEXT,
      sku TEXT,
      marketplace TEXT,
      total_amount INTEGER NOT NULL,
      raw_data TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_financial_events_unique ON financial_events(
      event_type, COALESCE(order_id,''), COALESCE(asin,''), COALESCE(sku,''),
      posted_date, total_amount
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL,
      shipping_cost INTEGER DEFAULT 0
    );
  `);
  return db;
}

test('shipping-label fees are replay-safe and assigned to one deterministic order line', () => {
  const db = makeDb();
  db.prepare(`
    INSERT INTO order_items (id, order_id, shipping_cost)
    VALUES (10, 'O1', 0), (11, 'O1', 0)
  `).run();

  const billing = {
    orderId: 'O1',
    postedDate: '2026-06-01T00:00:00Z',
    feeType: 'PostageBilling' as const,
    amountCents: 500,
    rawData: '{"source":"amazon"}',
    createdAt: '2026-06-02T00:00:00Z',
  };
  assert.equal(storeShippingLabelFee(db, billing), 1);
  assert.equal(storeShippingLabelFee(db, billing), 0);
  assert.equal(storeShippingLabelFee(db, {
    ...billing,
    feeType: 'PostageRefund',
    amountCents: 200,
  }), 1);
  assert.equal(storeShippingLabelFee(db, {
    ...billing,
    feeType: 'PostageRefund',
    amountCents: 200,
  }), 0);

  const lines = db.prepare(`
    SELECT id, shipping_cost shippingCost FROM order_items ORDER BY id
  `).all();
  const events = (db.prepare('SELECT COUNT(*) count FROM financial_events').get() as { count: number }).count;
  db.close();

  assert.deepEqual(lines, [
    { id: 10, shippingCost: 300 },
    { id: 11, shippingCost: 0 },
  ]);
  assert.equal(events, 2);
});

test('shipping-label fee fails closed until its order item exists', () => {
  const db = makeDb();
  const fee = {
    orderId: 'MISSING',
    postedDate: '2026-06-01T00:00:00Z',
    feeType: 'PostageBilling' as const,
    amountCents: 500,
    rawData: '{}',
    createdAt: '2026-06-02T00:00:00Z',
  };

  assert.throws(() => storeShippingLabelFee(db, fee), /no order item exists/);
  assert.equal(
    (db.prepare('SELECT COUNT(*) count FROM financial_events').get() as { count: number }).count,
    0,
  );
  db.close();
});
