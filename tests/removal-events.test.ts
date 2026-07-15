import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  migrateRemovalIdentities,
  storeRemovalShipmentEvent,
} from '../src/lib/removal-events';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE removals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      removal_order_id TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      removal_type TEXT NOT NULL,
      reason TEXT,
      status TEXT DEFAULT 'Pending',
      date_requested TEXT NOT NULL,
      date_completed TEXT,
      fee INTEGER DEFAULT 0,
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

test('removal migration collapses replays but preserves distinct source items', () => {
  const db = makeDb();
  try {
    const insert = db.prepare(`
      INSERT INTO removals (
        removal_order_id, asin, sku, quantity, removal_type, reason, status,
        date_requested, fee, marketplace, created_at
      ) VALUES (?, ?, ?, ?, ?, 'FBA Removal', 'Completed', ?, ?, 'amazon', ?)
    `);
    for (const seen of ['2026-05-01T01:00:00Z', '2026-05-02T01:00:00Z', '2026-05-03T01:00:00Z']) {
      insert.run('R1', 'A1', 'S1', 2, 'Return', '2026-04-30T12:00:00Z', -100, seen);
    }
    insert.run('R1', 'A2', 'S2', 1, 'Return', '2026-04-30T12:00:00Z', -50, '2026-05-01T01:00:00Z');
    insert.run('R1', 'A1', 'S1', 1, 'Return', '2026-05-10T12:00:00Z', -25, '2026-05-11T01:00:00Z');

    const result = migrateRemovalIdentities(db);

    assert.deepEqual(result, { before: 5, after: 3, removed: 2 });
    assert.deepEqual(
      db.prepare('SELECT removal_order_id, asin, sku, quantity, date_requested, fee FROM removals ORDER BY id').all(),
      [
        { removal_order_id: 'R1', asin: 'A1', sku: 'S1', quantity: 2, date_requested: '2026-04-30T12:00:00Z', fee: -100 },
        { removal_order_id: 'R1', asin: 'A2', sku: 'S2', quantity: 1, date_requested: '2026-04-30T12:00:00Z', fee: -50 },
        { removal_order_id: 'R1', asin: 'A1', sku: 'S1', quantity: 1, date_requested: '2026-05-10T12:00:00Z', fee: -25 },
      ],
    );
  } finally {
    db.close();
  }
});

test('removal ingestion is replay-safe and keeps multiple items from one event', () => {
  const db = makeDb();
  try {
    migrateRemovalIdentities(db);
    const event = {
      OrderId: 'R2',
      PostedDate: '2026-06-15T12:30:00Z',
      RemovalShipmentItemList: [
        {
          ASIN: 'A1',
          SellerSKU: 'S1',
          Quantity: 2,
          RemovalDisposition: 'Return',
          FeeAmount: { CurrencyAmount: -1.25, CurrencyCode: 'USD' },
        },
        {
          ASIN: 'A2',
          SellerSKU: 'S2',
          Quantity: 1,
          RemovalDisposition: 'Disposal',
          FeeAmount: { CurrencyAmount: -0.50, CurrencyCode: 'USD' },
        },
      ],
    };

    assert.equal(storeRemovalShipmentEvent(db, event, '2026-06-16T00:00:00Z'), 2);
    assert.equal(storeRemovalShipmentEvent(db, event, '2026-06-17T00:00:00Z'), 0);
    const totals = db.prepare(
      'SELECT COUNT(*) n, SUM(quantity) qty, SUM(fee) fee FROM removals',
    ).get() as { n: number; qty: number; fee: number };
    assert.equal(totals.n, 2);
    assert.equal(totals.qty, 3);
    assert.equal(totals.fee, -175);
  } finally {
    db.close();
  }
});

test('removal ingestion fails closed without deterministic source identity', () => {
  const db = makeDb();
  try {
    migrateRemovalIdentities(db);
    assert.throws(
      () => storeRemovalShipmentEvent(db, {
        PostedDate: '2026-06-15T12:30:00Z',
        RemovalShipmentItemList: [{ ASIN: 'A1', Quantity: 1 }],
      }),
      /missing OrderId/,
    );
    assert.throws(
      () => storeRemovalShipmentEvent(db, {
        OrderId: 'R3',
        RemovalShipmentItemList: [{ ASIN: 'A1', Quantity: 1 }],
      }),
      /missing PostedDate/,
    );
    const count = db.prepare('SELECT COUNT(*) n FROM removals').get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    db.close();
  }
});
