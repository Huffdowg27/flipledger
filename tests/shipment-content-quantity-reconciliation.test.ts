import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  applyShipmentQuantityPlan,
  planShipmentQuantityUpdate,
} from '../src/lib/shipment-content-quantities';

function makeDb(quantity = 10) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE listing_batch_items (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      listing_updated_at TEXT
    );
    INSERT INTO listing_batch_items (id, batch_id, sku, quantity)
    VALUES (1, 7, 'SKU-1', ${quantity});
  `);
  return db;
}

test('shipment changes adjust the batch total by delta instead of overwriting it', () => {
  const db = makeDb(10);
  try {
    const plan = planShipmentQuantityUpdate(
      db,
      7,
      [{ msku: 'SKU-1', quantity: 4 }],
      [{ msku: 'SKU-1', quantity: 3 }],
    );
    assert.deepEqual(plan, [{
      itemId: 1,
      msku: 'SKU-1',
      expectedBatchQuantity: 10,
      nextBatchQuantity: 9,
    }]);

    const updated = applyShipmentQuantityPlan(db, plan, '2026-07-06T12:00:00Z');
    assert.equal(updated, 1);
    assert.deepEqual(
      db.prepare('SELECT quantity, listing_updated_at FROM listing_batch_items WHERE id = 1').get(),
      { quantity: 9, listing_updated_at: '2026-07-06T12:00:00Z' },
    );
  } finally {
    db.close();
  }
});

test('removing a SKU from one shipment subtracts only that shipment quantity', () => {
  const db = makeDb(10);
  try {
    const plan = planShipmentQuantityUpdate(
      db,
      7,
      [{ msku: 'SKU-1', quantity: 2 }],
      [{ msku: 'SKU-1', quantity: 0 }],
    );
    applyShipmentQuantityPlan(db, plan, '2026-07-06T12:00:00Z');

    assert.deepEqual(
      db.prepare('SELECT quantity FROM listing_batch_items WHERE id = 1').get(),
      { quantity: 8 },
    );
  } finally {
    db.close();
  }
});

test('the post-update manifest must include every SKU from the shipment baseline', () => {
  const db = makeDb(10);
  try {
    assert.throws(() => planShipmentQuantityUpdate(
      db,
      7,
      [{ msku: 'SKU-1', quantity: 2 }],
      [],
    ), /complete|SKU-1/i);
  } finally {
    db.close();
  }
});

test('applying a plan fails closed if the batch quantity changed after planning', () => {
  const db = makeDb(10);
  try {
    const plan = planShipmentQuantityUpdate(
      db,
      7,
      [{ msku: 'SKU-1', quantity: 4 }],
      [{ msku: 'SKU-1', quantity: 3 }],
    );
    db.prepare('UPDATE listing_batch_items SET quantity = 11 WHERE id = 1').run();

    assert.throws(
      () => applyShipmentQuantityPlan(db, plan, '2026-07-06T12:00:00Z'),
      /changed|stale/i,
    );
    assert.deepEqual(
      db.prepare('SELECT quantity FROM listing_batch_items WHERE id = 1').get(),
      { quantity: 11 },
    );
  } finally {
    db.close();
  }
});

test('ambiguous duplicate SKU rows fail closed before Amazon confirmation', () => {
  const db = makeDb(10);
  db.prepare(`
    INSERT INTO listing_batch_items (id, batch_id, sku, quantity)
    VALUES (2, 7, 'SKU-1', 1)
  `).run();
  try {
    assert.throws(() => planShipmentQuantityUpdate(
      db,
      7,
      [{ msku: 'SKU-1', quantity: 4 }],
      [{ msku: 'SKU-1', quantity: 3 }],
    ), /multiple|ambiguous/i);
  } finally {
    db.close();
  }
});
