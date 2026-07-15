import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { removeAmazonGradedGhostLots } from '../src/lib/graded-ghost-lots';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY,
      sku TEXT,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL,
      buy_price INTEGER NOT NULL
    );
    CREATE TABLE listing_batch_items (
      id INTEGER PRIMARY KEY,
      inventory_ledger_id INTEGER
    );
    CREATE TABLE incoming_purchases (
      id INTEGER PRIMARY KEY,
      inventory_ledger_id INTEGER
    );
    CREATE TABLE receiving_issues (
      id INTEGER PRIMARY KEY,
      inventory_ledger_id INTEGER
    );
  `);
  return db;
}

test('graded ghost-lot migration deletes only exact amzn.gr.* lots', () => {
  const db = makeDb();
  const insert = db.prepare(`
    INSERT INTO inventory_ledger (id, sku, quantity, quantity_remaining, buy_price)
    VALUES (?, ?, ?, ?, ?)
  `);
  insert.run(1, 'amzn.gr.SKU-A', 2, 1, 1000);
  insert.run(2, 'amzn.gr.SKU-B', 1, 0, 500);
  insert.run(3, 'SKU-A', 4, 3, 1000);
  insert.run(4, 'amzn.grading.SKU-C', 1, 1, 900);
  insert.run(5, 'AMZN.GR.SKU-D', 1, 1, 700);

  const first = removeAmazonGradedGhostLots(db);
  const second = removeAmazonGradedGhostLots(db);
  const survivors = db.prepare('SELECT id, sku FROM inventory_ledger ORDER BY id').all();
  db.close();

  assert.deepEqual(first, {
    beforeLots: 2,
    beforeOriginalUnits: 3,
    beforeRemainingUnits: 1,
    beforeRemainingValueCents: 1000,
    removedLots: 2,
  });
  assert.deepEqual(second, {
    beforeLots: 0,
    beforeOriginalUnits: 0,
    beforeRemainingUnits: 0,
    beforeRemainingValueCents: 0,
    removedLots: 0,
  });
  assert.deepEqual(survivors, [
    { id: 3, sku: 'SKU-A' },
    { id: 4, sku: 'amzn.grading.SKU-C' },
    { id: 5, sku: 'AMZN.GR.SKU-D' },
  ]);
});

test('graded ghost-lot migration fails closed when an operational row references a lot', () => {
  const db = makeDb();
  db.prepare(`
    INSERT INTO inventory_ledger (id, sku, quantity, quantity_remaining, buy_price)
    VALUES (1, 'amzn.gr.SKU-A', 1, 1, 1000)
  `).run();
  db.prepare(`
    INSERT INTO listing_batch_items (id, inventory_ledger_id) VALUES (1, 1)
  `).run();

  assert.throws(
    () => removeAmazonGradedGhostLots(db),
    /refusing to delete 1 referenced amzn\.gr inventory lot/,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) count FROM inventory_ledger').get() as { count: number }).count,
    1,
  );
  db.close();
});
