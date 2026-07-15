import test from 'node:test';
import assert from 'node:assert/strict';
import { openFlipLedgerDb } from '../src/lib/sqlite';
import {
  deleteListingBatchChildren,
  deleteListingBatchItemChildren,
} from '../src/lib/listing-batch-cleanup';

function makeDb() {
  const db = openFlipLedgerDb({ dbPath: ':memory:', foreignKeys: false });
  db.exec(`
    CREATE TABLE listing_batch_boxes (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL
    );
    CREATE TABLE listing_batch_box_items (
      id INTEGER PRIMARY KEY,
      box_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL
    );
    CREATE TABLE listing_batch_pack_groups (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL
    );
    CREATE TABLE listing_batch_pack_group_items (
      id INTEGER PRIMARY KEY,
      pack_group_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL
    );
  `);
  return db;
}

function count(db: ReturnType<typeof makeDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

test('deleteListingBatchItemChildren removes only relationships for one item', () => {
  const db = makeDb();
  try {
    db.exec(`
      INSERT INTO listing_batch_boxes (id, batch_id) VALUES (10, 1), (11, 1);
      INSERT INTO listing_batch_box_items (id, box_id, item_id, quantity)
      VALUES (100, 10, 501, 1), (101, 11, 502, 1);
      INSERT INTO listing_batch_pack_groups (id, batch_id) VALUES (20, 1);
      INSERT INTO listing_batch_pack_group_items (id, pack_group_id, item_id, quantity)
      VALUES (200, 20, 501, 1), (201, 20, 502, 1);
    `);

    deleteListingBatchItemChildren(db, 501);

    assert.deepEqual(
      db.prepare('SELECT item_id FROM listing_batch_box_items ORDER BY id').all(),
      [{ item_id: 502 }]
    );
    assert.deepEqual(
      db.prepare('SELECT item_id FROM listing_batch_pack_group_items ORDER BY id').all(),
      [{ item_id: 502 }]
    );
    assert.equal(count(db, 'listing_batch_boxes'), 2);
    assert.equal(count(db, 'listing_batch_pack_groups'), 1);
  } finally {
    db.close();
  }
});

test('deleteListingBatchChildren removes box and pack-group descendants for one batch', () => {
  const db = makeDb();
  try {
    db.exec(`
      INSERT INTO listing_batch_boxes (id, batch_id) VALUES (10, 1), (11, 2);
      INSERT INTO listing_batch_box_items (id, box_id, item_id, quantity)
      VALUES (100, 10, 501, 1), (101, 11, 502, 1);
      INSERT INTO listing_batch_pack_groups (id, batch_id) VALUES (20, 1), (21, 2);
      INSERT INTO listing_batch_pack_group_items (id, pack_group_id, item_id, quantity)
      VALUES (200, 20, 501, 1), (201, 21, 502, 1);
    `);

    deleteListingBatchChildren(db, 1);

    assert.deepEqual(
      db.prepare('SELECT id, batch_id FROM listing_batch_boxes ORDER BY id').all(),
      [{ id: 11, batch_id: 2 }]
    );
    assert.deepEqual(
      db.prepare('SELECT id, batch_id FROM listing_batch_pack_groups ORDER BY id').all(),
      [{ id: 21, batch_id: 2 }]
    );
    assert.deepEqual(
      db.prepare('SELECT item_id FROM listing_batch_box_items ORDER BY id').all(),
      [{ item_id: 502 }]
    );
    assert.deepEqual(
      db.prepare('SELECT item_id FROM listing_batch_pack_group_items ORDER BY id').all(),
      [{ item_id: 502 }]
    );
  } finally {
    db.close();
  }
});
