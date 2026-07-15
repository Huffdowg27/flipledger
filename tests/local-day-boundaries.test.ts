import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  MARKETPLACE_TIME_ZONE,
  formatCalendarDateInTimeZone,
  localDayRangeToUtcBounds,
} from '../src/lib/local-day-boundaries';

test('Pacific local-day boundaries are converted to DST-correct UTC instants', () => {
  assert.deepEqual(
    localDayRangeToUtcBounds('2026-07-02', '2026-07-03'),
    {
      startUtc: '2026-07-02T07:00:00.000Z',
      endUtc: '2026-07-03T07:00:00.000Z',
    },
  );
  assert.deepEqual(
    localDayRangeToUtcBounds('2026-01-15', '2026-01-16'),
    {
      startUtc: '2026-01-15T08:00:00.000Z',
      endUtc: '2026-01-16T08:00:00.000Z',
    },
  );
});

test('Pacific UTC boundaries preserve 23-hour and 25-hour DST transition days', () => {
  const spring = localDayRangeToUtcBounds('2026-03-08', '2026-03-09');
  const fall = localDayRangeToUtcBounds('2026-11-01', '2026-11-02');

  assert.equal(
    Date.parse(spring.endUtc) - Date.parse(spring.startUtc),
    23 * 60 * 60 * 1000,
  );
  assert.equal(
    Date.parse(fall.endUtc) - Date.parse(fall.startUtc),
    25 * 60 * 60 * 1000,
  );
});

test('dashboard Today changes at Pacific midnight rather than UTC midnight', () => {
  assert.equal(
    formatCalendarDateInTimeZone(new Date('2026-07-03T06:59:59Z')),
    '2026-07-02',
  );
  assert.equal(
    formatCalendarDateInTimeZone(new Date('2026-07-03T07:00:00Z')),
    '2026-07-03',
  );
});

test('raw UTC bounds select the same known Pacific day as SQLite localtime', () => {
  const previousTimeZone = process.env.TZ;
  process.env.TZ = MARKETPLACE_TIME_ZONE;
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE events (id INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL);
      CREATE INDEX idx_events_occurred_at ON events(occurred_at);
      INSERT INTO events (id, occurred_at) VALUES
        (1, '2026-07-02T06:59:59Z'),
        (2, '2026-07-02T07:00:00Z'),
        (3, '2026-07-03T06:59:59Z'),
        (4, '2026-07-03T07:00:00Z'),
        (5, '2026-07-02T07:00:00.001Z');
    `);

    const oldIds = db.prepare(`
      SELECT id FROM events
      WHERE datetime(occurred_at, 'localtime') >= ?
        AND datetime(occurred_at, 'localtime') < ?
      ORDER BY id
    `).all('2026-07-02', '2026-07-03');
    const bounds = localDayRangeToUtcBounds('2026-07-02', '2026-07-03');
    const newIds = db.prepare(`
      SELECT id FROM events
      WHERE occurred_at >= ? AND occurred_at < ?
      ORDER BY id
    `).all(bounds.startUtc, bounds.endUtc);

    assert.deepEqual(newIds, oldIds);
    assert.deepEqual(newIds, [{ id: 2 }, { id: 3 }, { id: 5 }]);
  } finally {
    db.close();
    if (previousTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimeZone;
    }
  }
});
