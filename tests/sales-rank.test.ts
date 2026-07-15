import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { syncSalesRanks } from '../src/lib/sp-api/salesRank';
import type { SPAPICredentials } from '../src/lib/sp-api/types';

const credentials: SPAPICredentials = {
  clientId: 'client',
  clientSecret: 'secret',
  refreshToken: 'refresh',
  marketplaceId: 'ATVPDKIKX0DER',
};

const silentLogger = { log() {}, warn() {} };

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE live_inventory (
      asin TEXT,
      fulfillable_qty INTEGER
    );

    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,
      purchase_date TEXT,
      marketplace TEXT
    );

    CREATE TABLE order_items (
      order_id TEXT,
      asin TEXT
    );

    CREATE TABLE sales_rank_history (
      asin TEXT,
      marketplace TEXT,
      category TEXT,
      rank INTEGER,
      captured_date TEXT,
      captured_at TEXT,
      UNIQUE(asin, marketplace, captured_date)
    );
  `);
  return db;
}

test('sales rank sync skips ASINs already captured today', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO live_inventory (asin, fulfillable_qty) VALUES (?, ?)').run('B000000001', 1);
  db.prepare('INSERT INTO live_inventory (asin, fulfillable_qty) VALUES (?, ?)').run('B000000002', 1);
  db.prepare(`
    INSERT INTO sales_rank_history (asin, marketplace, category, rank, captured_date, captured_at)
    VALUES (?, 'amazon', ?, ?, ?, ?)
  `).run('B000000001', 'Toys', 1234, '2026-06-16', '2026-06-16T10:00:00.000Z');

  const fetched: string[] = [];
  const result = await syncSalesRanks(credentials, {
    db,
    closeDb: false,
    sleepMs: 0,
    logger: silentLogger,
    now: new Date('2026-06-16T18:00:00.000Z'),
    fetchRank: async (_credentials, asin) => {
      fetched.push(asin);
      return { rank: 2222, category: 'Games' };
    },
  });

  assert.deepEqual(fetched, ['B000000002']);
  assert.equal(result.asinsEligible, 2);
  assert.equal(result.asinsSkippedToday, 1);
  assert.equal(result.asinsAttempted, 1);
  assert.equal(result.asinsUpdated, 1);

  const rows = db
    .prepare('SELECT asin, rank FROM sales_rank_history ORDER BY asin')
    .all() as { asin: string; rank: number }[];
  assert.deepEqual(rows, [
    { asin: 'B000000001', rank: 1234 },
    { asin: 'B000000002', rank: 2222 },
  ]);
  db.close();
});

test('sales rank sync respects a per-run ASIN limit', async () => {
  const db = makeDb();
  const insertInventory = db.prepare('INSERT INTO live_inventory (asin, fulfillable_qty) VALUES (?, ?)');
  insertInventory.run('B000000001', 1);
  insertInventory.run('B000000002', 1);
  insertInventory.run('B000000003', 1);

  const fetched: string[] = [];
  const result = await syncSalesRanks(credentials, {
    db,
    closeDb: false,
    sleepMs: 0,
    logger: silentLogger,
    now: new Date('2026-06-16T18:00:00.000Z'),
    maxAsins: 2,
    fetchRank: async (_credentials, asin) => {
      fetched.push(asin);
      return { rank: 1000 + fetched.length, category: 'Toys' };
    },
  });

  assert.deepEqual(fetched, ['B000000001', 'B000000002']);
  assert.equal(result.asinsEligible, 3);
  assert.equal(result.asinsDeferred, 1);
  assert.equal(result.stoppedReason, 'maxAsins');

  const captured = db
    .prepare('SELECT asin FROM sales_rank_history ORDER BY asin')
    .all() as { asin: string }[];
  assert.deepEqual(captured.map((row) => row.asin), ['B000000001', 'B000000002']);
  db.close();
});

test('sales rank sync does not start another ASIN after the time budget is exhausted', async () => {
  const db = makeDb();
  const insertInventory = db.prepare('INSERT INTO live_inventory (asin, fulfillable_qty) VALUES (?, ?)');
  insertInventory.run('B000000001', 1);
  insertInventory.run('B000000002', 1);

  let nowMs = Date.parse('2026-06-16T18:00:00.000Z');
  const fetched: string[] = [];
  const result = await syncSalesRanks(credentials, {
    db,
    closeDb: false,
    sleepMs: 0,
    logger: silentLogger,
    now: () => new Date(nowMs),
    maxRunMs: 100,
    fetchRank: async (_credentials, asin) => {
      fetched.push(asin);
      nowMs += 150;
      return { rank: 1000, category: 'Toys' };
    },
  });

  assert.deepEqual(fetched, ['B000000001']);
  assert.equal(result.asinsEligible, 2);
  assert.equal(result.asinsAttempted, 1);
  assert.equal(result.asinsDeferred, 1);
  assert.equal(result.stoppedReason, 'timeBudget');
  db.close();
});
