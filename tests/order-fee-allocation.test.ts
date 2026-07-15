import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  orderFeeAllocationCtes,
  productNameExpr,
} from '../src/lib/order-fee-allocation';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL,
      asin TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      total_price INTEGER NOT NULL
    );
    CREATE TABLE fee_details (
      id INTEGER PRIMARY KEY,
      financial_event_id INTEGER NOT NULL,
      order_id TEXT,
      amount INTEGER NOT NULL
    );
    CREATE TABLE financial_events (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL
    );
    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,
      marketplace TEXT NOT NULL
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      asin TEXT NOT NULL,
      name TEXT,
      marketplace TEXT
    );
  `);
  return db;
}

test('order fees allocate by revenue and remain penny-exact across lines', () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO order_items VALUES
      (1, 'ORDER-1', 'ASIN-A', 1, 700),
      (2, 'ORDER-1', 'ASIN-B', 1, 300);
    INSERT INTO financial_events VALUES (1, 'ShipmentEvent');
    INSERT INTO fee_details VALUES (1, 1, 'ORDER-1', -101);
  `);

  const rows = db.prepare(`
    WITH ${orderFeeAllocationCtes({ realFeesOnly: false })}
    SELECT id, allocated_fee AS fee
    FROM allocated_order_fees
    ORDER BY id
  `).all() as Array<{ id: number; fee: number }>;
  db.close();

  assert.deepEqual(rows, [
    { id: 1, fee: -71 },
    { id: 2, fee: -30 },
  ]);
  assert.equal(rows.reduce((sum, row) => sum + row.fee, 0), -101);
});

test('allocation matches P&L fee eligibility and can exclude estimates', () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO order_items VALUES
      (1, 'ORDER-1', 'ASIN-A', 2, 0),
      (2, 'ORDER-1', 'ASIN-B', 1, 0);
    INSERT INTO financial_events VALUES
      (1, 'ShipmentEvent'),
      (2, 'RefundEvent');
    INSERT INTO fee_details VALUES
      (1, 1, 'ORDER-1', -90),
      (2, 2, 'ORDER-1', 30),
      (3, 0, 'ORDER-1', -60);
  `);

  const allRows = db.prepare(`
    WITH ${orderFeeAllocationCtes({ realFeesOnly: false })}
    SELECT id, allocated_fee AS fee
    FROM allocated_order_fees
    ORDER BY id
  `).all() as Array<{ id: number; fee: number }>;
  const realRows = db.prepare(`
    WITH ${orderFeeAllocationCtes({ realFeesOnly: true })}
    SELECT id, allocated_fee AS fee
    FROM allocated_order_fees
    ORDER BY id
  `).all() as Array<{ id: number; fee: number }>;
  db.close();

  assert.deepEqual(allRows, [
    { id: 1, fee: -100 },
    { id: 2, fee: -50 },
  ]);
  assert.deepEqual(realRows, [
    { id: 1, fee: -60 },
    { id: 2, fee: -30 },
  ]);
});

test('product lookup returns one marketplace-preferred name without row fanout', () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO orders VALUES ('ORDER-1', 'amazon');
    INSERT INTO order_items VALUES (1, 'ORDER-1', 'ASIN-A', 1, 1000);
    INSERT INTO products VALUES
      (1, 'ASIN-A', 'Walmart name', 'walmart'),
      (2, 'ASIN-A', 'Amazon name', 'amazon'),
      (3, 'UNRELATED', 'Unrelated', 'amazon');
  `);

  const rows = db.prepare(`
    SELECT ${productNameExpr('oi', 'o')} AS product_name
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
  `).all();
  db.close();

  assert.deepEqual(rows, [{ product_name: 'Amazon name' }]);
});
