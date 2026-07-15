import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openFlipLedgerDb } from '../src/lib/sqlite';
import {
  COOLDOWN_MS_AFTER_429,
  MAX_DOWNLOADS_PER_RUN,
  SETTLEMENT_DRIP_DELAY_MAX_MS,
  SETTLEMENT_DRIP_DELAY_MIN_MS,
  createSettlementDripBackfillDependencies,
  getSettlementDripStatus,
  runSettlementDripBackfill,
  runSettlementDripTick,
  type SettlementDripDependencies,
} from '../src/lib/sp-api/settlement-drip-backfill';
import type { SettlementReportListItem } from '../src/lib/sp-api/settlement-report-resolution';

function fixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipledger-drip-'));
  const dbPath = path.join(dir, 'flipledger.db');
  const db = openFlipLedgerDb({ dbPath, foreignKeys: false });
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE settlement_periods (
      id INTEGER PRIMARY KEY,
      settlement_id TEXT NOT NULL UNIQUE,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      deposit_date TEXT
    );
    CREATE TABLE settlement_transactions (
      id INTEGER PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      order_id TEXT,
      sku TEXT,
      posted_date TEXT,
      transaction_type TEXT,
      amount_type TEXT,
      amount_description TEXT,
      amount_cents INTEGER NOT NULL
    );

    INSERT INTO settlement_periods (settlement_id, start_date, end_date) VALUES
      ('ZERO-A', '2026-06-01 00:00:00 UTC', '2026-06-05 00:00:00 UTC'),
      ('SPARSE-B', '2026-06-05 00:00:00 UTC', '2026-06-15 00:00:00 UTC'),
      ('DENSE-C', '2026-06-15 00:00:00 UTC', '2026-06-18 00:00:00 UTC');
    INSERT INTO settlement_transactions
      (settlement_id, order_id, sku, posted_date, transaction_type, amount_type, amount_description, amount_cents)
    VALUES
      ('SPARSE-B', 'O-1', 'S-1', '2026-06-05', 'Order', 'ItemPrice', 'Principal', 100),
      ('SPARSE-B', 'O-2', 'S-2', '2026-06-06', 'Order', 'ItemPrice', 'Principal', 100),
      ('DENSE-C', 'O-3', 'S-3', '2026-06-15', 'Order', 'ItemPrice', 'Principal', 100),
      ('DENSE-C', 'O-4', 'S-4', '2026-06-15', 'Order', 'ItemPrice', 'Principal', 100),
      ('DENSE-C', 'O-5', 'S-5', '2026-06-16', 'Order', 'ItemPrice', 'Principal', 100),
      ('DENSE-C', 'O-6', 'S-6', '2026-06-16', 'Order', 'ItemPrice', 'Principal', 100);
  `);
  return {
    db,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function reports(): SettlementReportListItem[] {
  return [
    {
      reportId: 'R-ZERO-A',
      reportDocumentId: 'D-ZERO-A',
      dataStartTime: '2026-06-01T00:00:00Z',
      dataEndTime: '2026-06-05T00:00:00Z',
    },
    {
      reportId: 'R-SPARSE-B',
      reportDocumentId: 'D-SPARSE-B',
      dataStartTime: '2026-06-05T00:00:00Z',
      dataEndTime: '2026-06-15T00:00:00Z',
    },
  ];
}

function deps(overrides: Partial<SettlementDripDependencies> = {}): SettlementDripDependencies {
  return {
    listReports: async () => reports(),
    ingestReport: async ({ expectedSettlementId, report }) => ({
      settlementId: expectedSettlementId,
      reportId: report.reportId,
      reportDocumentId: report.reportDocumentId || '',
      rowsPersisted: 12,
      shippingCostsUpdated: 0,
    }),
    sleep: async () => undefined,
    now: () => new Date('2026-07-07T12:00:00.000Z'),
    randomDelayMs: () => SETTLEMENT_DRIP_DELAY_MIN_MS,
    log: () => undefined,
    ...overrides,
  };
}

test('drip tick processes exactly one flagged settlement and persists done progress', async () => {
  const { db, cleanup } = fixtureDb();
  const ingested: string[] = [];
  try {
    const result = await runSettlementDripTick(db, deps({
      ingestReport: async ({ expectedSettlementId, report }) => {
        ingested.push(`${expectedSettlementId}:${report.reportId}`);
        return {
          settlementId: expectedSettlementId,
          reportId: report.reportId,
          reportDocumentId: report.reportDocumentId || '',
          rowsPersisted: 12,
          shippingCostsUpdated: 0,
        };
      },
    }));

    assert.equal(result.status, 'processed');
    assert.deepEqual(ingested, ['SPARSE-B:R-SPARSE-B']);

    const status = getSettlementDripStatus(db, new Date('2026-07-07T12:00:00.000Z'));
    assert.equal(status.pending, 1);
    assert.equal(status.done, 1);
    assert.equal(status.failed, 0);
    assert.equal(status.inCooldown, false);
  } finally {
    db.close();
    cleanup();
  }
});

test('drip run resumes after restart and skips settlements already marked done', async () => {
  const { db, cleanup } = fixtureDb();
  const seen: string[] = [];
  try {
    await runSettlementDripTick(db, deps({
      ingestReport: async ({ expectedSettlementId, report }) => {
        seen.push(`${expectedSettlementId}:${report.reportId}`);
        return {
          settlementId: expectedSettlementId,
          reportId: report.reportId,
          reportDocumentId: report.reportDocumentId || '',
          rowsPersisted: 12,
          shippingCostsUpdated: 0,
        };
      },
    }));
    await runSettlementDripTick(db, deps({
      ingestReport: async ({ expectedSettlementId, report }) => {
        seen.push(`${expectedSettlementId}:${report.reportId}`);
        return {
          settlementId: expectedSettlementId,
          reportId: report.reportId,
          reportDocumentId: report.reportDocumentId || '',
          rowsPersisted: 12,
          shippingCostsUpdated: 0,
        };
      },
    }));

    assert.deepEqual(seen, ['SPARSE-B:R-SPARSE-B', 'ZERO-A:R-ZERO-A']);
    const status = getSettlementDripStatus(db, new Date('2026-07-07T12:00:00.000Z'));
    assert.equal(status.pending, 0);
    assert.equal(status.done, 2);
  } finally {
    db.close();
    cleanup();
  }
});

test('drip stops completely on first 429 and records a one-hour cooldown', async () => {
  const { db, cleanup } = fixtureDb();
  try {
    const result = await runSettlementDripTick(db, deps({
      ingestReport: async () => {
        throw new Error('SP-API 429 on /reports/2021-06-30/documents/D-SPARSE-B: rate limited');
      },
    }));

    assert.equal(result.status, 'cooldown');
    const status = getSettlementDripStatus(db, new Date('2026-07-07T12:00:00.000Z'));
    assert.equal(status.inCooldown, true);
    assert.equal(status.failed, 1);
    assert.equal(status.lastError?.includes('429'), true);
    assert.equal(
      new Date(status.cooldownUntil || '').getTime(),
      new Date('2026-07-07T12:00:00.000Z').getTime() + COOLDOWN_MS_AFTER_429,
    );

    const skipped = await runSettlementDripTick(db, deps());
    assert.equal(skipped.status, 'cooldown');
  } finally {
    db.close();
    cleanup();
  }
});

test('drip run sleeps 150-180 seconds between downloads and caps each run at 40 downloads', async () => {
  const { db, cleanup } = fixtureDb();
  const slept: number[] = [];
  const attempted: string[] = [];
  try {
    db.prepare('DELETE FROM settlement_periods').run();
    const insertPeriod = db.prepare(`
      INSERT INTO settlement_periods (settlement_id, start_date, end_date)
      VALUES (?, ?, ?)
    `);
    const syntheticReports: SettlementReportListItem[] = [];
    for (let i = 0; i < MAX_DOWNLOADS_PER_RUN + 2; i++) {
      const start = new Date(Date.UTC(2026, 5, 1 + i, 0, 0, 0));
      const end = new Date(Date.UTC(2026, 5, 1 + i, 12, 0, 0));
      const day = String(i + 1).padStart(2, '0');
      const startSql = start.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
      const endSql = end.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
      insertPeriod.run(
        `ZERO-${day}`,
        startSql,
        endSql,
      );
      syntheticReports.push({
        reportId: `R-ZERO-${day}`,
        reportDocumentId: `D-ZERO-${day}`,
        dataStartTime: start.toISOString(),
        dataEndTime: end.toISOString(),
      });
    }

    const result = await runSettlementDripBackfill(db, deps({
      listReports: async () => syntheticReports,
      ingestReport: async ({ expectedSettlementId, report }) => {
        attempted.push(`${expectedSettlementId}:${report.reportId}`);
        return {
          settlementId: expectedSettlementId,
          reportId: report.reportId,
          reportDocumentId: report.reportDocumentId || '',
          rowsPersisted: 12,
          shippingCostsUpdated: 0,
        };
      },
      randomDelayMs: () => SETTLEMENT_DRIP_DELAY_MAX_MS,
      sleep: async (ms) => { slept.push(ms); },
    }));

    assert.equal(result.downloadsAttempted, MAX_DOWNLOADS_PER_RUN);
    assert.equal(attempted.length, MAX_DOWNLOADS_PER_RUN);
    assert.equal(slept.length, MAX_DOWNLOADS_PER_RUN - 1);
    assert.ok(slept.every((ms) => ms >= SETTLEMENT_DRIP_DELAY_MIN_MS && ms <= SETTLEMENT_DRIP_DELAY_MAX_MS));
  } finally {
    db.close();
    cleanup();
  }
});

test('default drip dependencies ingest through the existing single-report settlement path', () => {
  const defaults = createSettlementDripBackfillDependencies({} as never);
  assert.equal(defaults.ingestReport.name, 'syncSettlementReportByReportId');
});
