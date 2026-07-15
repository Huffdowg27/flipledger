import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

function makeSettlementFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-net-metrics-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
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

    INSERT INTO settlement_periods VALUES
      (1, 'SETTLE-JUNE', 'amazon', '2026-06-01 00:00:00 UTC', '2026-06-15 23:59:59 UTC', '2026-06-17 12:00:00 UTC'),
      (2, 'SETTLE-JULY', 'amazon', '2026-07-01 00:00:00 UTC', '2026-07-15 23:59:59 UTC', '2026-07-17 12:00:00 UTC');
    INSERT INTO settlement_transactions
      (settlement_id, order_id, sku, posted_date, transaction_type, amount_type, amount_description, amount_cents)
    VALUES
      ('SETTLE-JUNE', 'O-1', 'SKU-1', '2026-06-02', 'Order', 'ItemPrice', 'Principal', 10000),
      ('SETTLE-JUNE', 'O-1', 'SKU-1', '2026-06-02', 'Order', 'ItemPrice', 'Tax', 700),
      ('SETTLE-JUNE', 'O-1', 'SKU-1', '2026-06-02', 'Order', 'ItemFees', 'Commission', -1500),
      ('SETTLE-JUNE', 'O-2', 'SKU-2', '2026-06-03', 'Refund', 'ItemPrice', 'Principal', -1000),
      ('SETTLE-JUNE', 'O-2', 'SKU-2', '2026-06-03', 'Refund', 'ItemFees', 'Commission', 150),
      ('SETTLE-JUNE', 'O-2', 'SKU-2', '2026-06-03', 'Refund', 'ItemFees', 'RefundCommission', -50),
      ('SETTLE-JUNE', 'O-2', 'SKU-2', '2026-06-03', 'Refund', 'ItemPrice', 'RestockingFee', 100),
      ('SETTLE-JUNE', 'O-2', 'SKU-2', '2026-06-03', 'Refund', 'ItemPrice', 'Tax', -70),
      ('SETTLE-JUNE', 'O-2', 'SKU-2', '2026-06-03', 'Refund', 'ItemWithheldTax', 'MarketplaceFacilitatorTax-Principal', 70),
      ('SETTLE-JULY', 'O-3', 'SKU-3', '2026-07-02', 'Order', 'ItemPrice', 'Principal', 5000);
  `);
  db.close();
  return dir;
}

async function callSettlementMetrics(dir: string, query: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/settlement-net-metrics/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/settlement-net-metrics?${query}`));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

test('settlement-net metrics expose statement-basis sales and net refunds separately from gross refunds', async () => {
  const dir = makeSettlementFixture();
  try {
    const { response, body } = await callSettlementMetrics(
      dir,
      'startDate=2026-06-01&endDate=2026-06-30',
    );

    assert.equal(response.status, 200);
    assert.equal(body.basis.sales, 'settlement product sales basis');
    assert.equal(body.basis.netRefunds, 'settlement net basis');
    assert.equal(body.basis.grossRefunds, 'gross refund basis');
    assert.deepEqual(body.totals, {
      depositedCents: 8400,
      salesCents: 10000,
      netRefundsCents: -800,
      grossRefundsCents: -1000,
      refundRatePct: 8,
      transactionCount: 9,
    });
    assert.equal(body.periods.length, 1);
    assert.equal(body.periods[0].settlementId, 'SETTLE-JUNE');
    assert.equal(body.periods[0].netRefundsCents, -800);
    assert.equal(body.periods[0].grossRefundsCents, -1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
