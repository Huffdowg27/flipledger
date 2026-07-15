import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  normalizeSettlementDate,
  parseSettlementPeriodMetadata,
  upsertSettlementPeriod,
} from '../src/lib/settlement-periods';

test('settlement dates normalize explicit offsets to exact UTC and reject invalid calendars', () => {
  assert.equal(
    normalizeSettlementDate('2026-06-30T14:23:24-07:00'),
    '2026-06-30 21:23:24 UTC',
  );
  assert.equal(
    normalizeSettlementDate('16.02.2026 18:58:33 UTC'),
    '2026-02-16 18:58:33 UTC',
  );
  assert.equal(normalizeSettlementDate('2026-02-31 12:00:00 UTC'), null);
  assert.equal(normalizeSettlementDate('not-a-date'), null);
});

test('one parser extracts normalized settlement metadata from a repeated-row report', () => {
  const tsv = [
    'settlement-id\tsettlement-start-date\tsettlement-end-date\tdeposit-date\tmarketplace-name\tamount',
    'S-100\t2026-06-01T00:00:00Z\t2026-06-15T23:59:59Z\t16.06.2026 08:00:00 UTC\tAmazon.com\t1.00',
    'S-100\t2026-06-01T00:00:00Z\t2026-06-15T23:59:59Z\t16.06.2026 08:00:00 UTC\tAmazon.com\t2.00',
  ].join('\n');

  assert.deepEqual(parseSettlementPeriodMetadata(tsv), {
    settlementId: 'S-100',
    marketplace: 'amazon',
    startDate: '2026-06-01 00:00:00 UTC',
    endDate: '2026-06-15 23:59:59 UTC',
    depositDate: '2026-06-16 08:00:00 UTC',
  });
});

test('settlement-period upsert is replay-safe and stores the normalized replacement', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settlement_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_id TEXT NOT NULL UNIQUE,
      marketplace TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      deposit_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const first = {
    settlementId: 'S-100',
    marketplace: 'amazon',
    startDate: '2026-06-01 00:00:00 UTC',
    endDate: '2026-06-15 23:59:59 UTC',
    depositDate: null,
  };
  upsertSettlementPeriod(db, first);
  upsertSettlementPeriod(db, { ...first, depositDate: '2026-06-16 08:00:00 UTC' });

  const rows = db.prepare(`
    SELECT settlement_id settlementId, marketplace, start_date startDate,
      end_date endDate, deposit_date depositDate
    FROM settlement_periods
  `).all();
  db.close();

  assert.deepEqual(rows, [{
    ...first,
    depositDate: '2026-06-16 08:00:00 UTC',
  }]);
});
