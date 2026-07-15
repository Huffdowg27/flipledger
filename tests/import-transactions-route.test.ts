import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const HEADER = [
  'date/time',
  'settlement id',
  'type',
  'order id',
  'sku',
  'description',
  'quantity',
  'product sales',
  'selling fees',
  'fba fees',
  'other transaction fees',
  'other',
  'total',
];

function csvRow(values: string[]): string {
  return values.map((value) => `"${value.replaceAll('"', '""')}"`).join(',');
}

function report(rows: string[][]): string {
  return [csvRow(HEADER), ...rows.map(csvRow)].join('\n');
}

function makeFixture(options: { rejectImportedServiceFee?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-transactions-route-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const dbPath = path.join(dataDir, 'flipledger.db');
  const importedServiceCheck = options.rejectImportedServiceFee
    ? `CHECK(event_type != 'TransactionReportServiceFee')`
    : '';
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE financial_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL ${importedServiceCheck},
      posted_date TEXT NOT NULL,
      order_id TEXT,
      asin TEXT,
      sku TEXT,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      total_amount INTEGER NOT NULL,
      raw_data TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE fee_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      financial_event_id INTEGER NOT NULL,
      order_id TEXT,
      asin TEXT,
      fee_type TEXT NOT NULL,
      fee_category TEXT,
      amount INTEGER NOT NULL,
      posted_date TEXT NOT NULL,
      UNIQUE(financial_event_id, order_id, asin, fee_type, amount, posted_date)
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      shipping_cost INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE reimbursements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reimbursement_date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT,
      marketplace TEXT NOT NULL
    );
    INSERT INTO financial_events (
      id, event_type, posted_date, marketplace, total_amount, raw_data, created_at
    ) VALUES (
      1, 'ServiceFeeEvent', '2026-06-01T00:00:00.000Z', 'amazon', -999, '{}',
      '2026-06-01T00:00:00.000Z'
    );
    INSERT INTO fee_details (
      financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date
    ) VALUES (
      1, NULL, NULL, 'Subscription', 'Other Fees', -999, '2026-06-01T00:00:00.000Z'
    );
    INSERT INTO order_items (order_id, shipping_cost) VALUES ('ORDER-1', 111);
  `);
  db.close();
  return { dir, dbPath, csvPath: path.join(dataDir, 'amazon-transaction-report.csv') };
}

async function callImportRoute(dir: string, confirmed = true) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { POST } = await import('../src/app/api/sync/import-transactions/route');
    const suffix = confirmed ? '?confirm=1' : '';
    const response = await POST(new NextRequest(
      `http://localhost/api/sync/import-transactions${suffix}`,
      { method: 'POST' },
    ));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

function existingFeeState(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      events: db.prepare('SELECT event_type, total_amount FROM financial_events ORDER BY id').all(),
      fees: db.prepare('SELECT fee_type, amount FROM fee_details ORDER BY id').all(),
      shippingCost: (db.prepare(
        `SELECT shipping_cost FROM order_items WHERE order_id = 'ORDER-1'`,
      ).get() as { shipping_cost: number }).shipping_cost,
    };
  } finally {
    db.close();
  }
}

test('legacy transaction import refuses to run without explicit confirmation and changes nothing', async () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(fixture.csvPath, report([[
      'Jun 2, 2026 1:00:00 AM PDT', 'SETTLEMENT-1', 'Service Fee', '', '',
      'Subscription', '0', '', '', '', '', '-12.34', '-12.34',
    ]]));
    const before = existingFeeState(fixture.dbPath);

    const { response, body } = await callImportRoute(fixture.dir, false);

    assert.equal(response.status, 400);
    assert.match(body.error, /confirm=1/);
    assert.deepEqual(existingFeeState(fixture.dbPath), before);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('malformed legacy transaction input is rejected before any prior fee rows are deleted', async () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(fixture.csvPath, report([[
      'Jun 2, 2026 1:00:00 AM PDT', 'SETTLEMENT-1', 'Service Fee', '', '',
      'Subscription', '0', '', '', '', '', 'not-money', 'not-money',
    ]]));
    const before = existingFeeState(fixture.dbPath);

    const { response, body } = await callImportRoute(fixture.dir);

    assert.equal(response.status, 400);
    assert.match(body.error, /malformed amount/i);
    assert.deepEqual(existingFeeState(fixture.dbPath), before);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a truncated transaction row is rejected rather than partially parsed and imported', async () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(
      fixture.csvPath,
      [
        csvRow(HEADER),
        csvRow([
          'Jun 2, 2026 1:00:00 AM PDT', 'SETTLEMENT-1', 'Service Fee', '', '',
          'Subscription', '0', '', '', '', '', '-12.34', '-12.34',
        ]),
        csvRow([
          'Jun 3, 2026 1:00:00 AM PDT', 'SETTLEMENT-2', 'Service Fee', '', '',
          'Subscription',
        ]),
      ].join('\n'),
    );
    const before = existingFeeState(fixture.dbPath);

    const { response, body } = await callImportRoute(fixture.dir);

    assert.equal(response.status, 400);
    assert.match(body.error, /has 6 columns, expected 13/i);
    assert.deepEqual(existingFeeState(fixture.dbPath), before);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a report with zero replacement fee rows cannot erase an existing fee scope', async () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(fixture.csvPath, report([[
      'Jun 2, 2026 1:00:00 AM PDT', 'SETTLEMENT-1', 'Order', 'ORDER-1', 'SKU-1',
      'Synthetic product', '1', '20.00', '-3.00', '-4.00', '', '', '13.00',
    ]]));
    const before = existingFeeState(fixture.dbPath);

    const { response, body } = await callImportRoute(fixture.dir);

    assert.equal(response.status, 400);
    assert.match(body.error, /zero replacement rows/i);
    assert.deepEqual(existingFeeState(fixture.dbPath), before);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a database failure after deletion rolls back the entire transaction', async () => {
  const fixture = makeFixture({ rejectImportedServiceFee: true });
  try {
    fs.writeFileSync(fixture.csvPath, report([[
      'Jun 2, 2026 1:00:00 AM PDT', 'SETTLEMENT-1', 'Service Fee', '', '',
      'Subscription', '0', '', '', '', '', '-12.34', '-12.34',
    ]]));
    const before = existingFeeState(fixture.dbPath);

    const { response } = await callImportRoute(fixture.dir);

    assert.equal(response.status, 500);
    assert.deepEqual(existingFeeState(fixture.dbPath), before);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a valid confirmed full import preserves the legacy numeric results', async () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(fixture.csvPath, report([
      [
        'Jun 2, 2026 1:00:00 AM PDT', 'SETTLEMENT-1', 'Service Fee', '', '',
        'Subscription', '0', '', '', '', '', '-12.34', '-12.34',
      ],
      [
        'Jun 3, 2026 1:00:00 AM PDT', 'SETTLEMENT-2', 'FBA Inventory Fee', '', '',
        'FBA storage fee', '0', '', '', '', '', '-5.67', '-5.67',
      ],
      [
        'Jun 4, 2026 1:00:00 AM PDT', 'SETTLEMENT-3', 'Shipping Services', 'ORDER-1', '',
        'Shipping Label Purchased through Amazon', '0', '', '', '', '', '-4.99', '-4.99',
      ],
      [
        'Jun 5, 2026 1:00:00 AM PDT', 'SETTLEMENT-4', 'Shipping Services', 'ORDER-1', '',
        'Adjustment', '0', '', '', '', '', '-1.25', '-1.25',
      ],
      [
        'Jun 6, 2026 1:00:00 AM PDT', 'SETTLEMENT-5', 'Shipping Services', 'ORDER-1', '',
        'ReturnPostageBilling', '0', '', '', '', '', '-3.50', '-3.50',
      ],
      [
        'Jun 7, 2026 1:00:00 AM PDT', 'SETTLEMENT-6', 'Liquidations', 'LIQUIDATION-1', 'SKU-1',
        'Liquidation Proceeds', '1', '', '', '', '', '10.00', '10.00',
      ],
    ]));

    const { response, body } = await callImportRoute(fixture.dir);

    assert.equal(response.status, 200);
    assert.deepEqual(body.stats, {
      totalRows: 6,
      serviceFees: { oldEventsDeleted: 1, newInserted: 1, totalDollars: '-12.34' },
      fbaInventoryFees: { orphanFeesDeleted: 1, newInserted: 1, totalDollars: '-5.67' },
      shippingLabels: { ordersUpdated: 1, totalDollars: '-4.99' },
      shippingAdjustments: { inserted: 1, totalDollars: '-1.25' },
      returnPostage: { inserted: 1, totalDollars: '-3.50' },
      adjustments: { datesFixed: 0, totalDollars: '0.00' },
      liquidations: { inserted: 1, totalDollars: '10.00' },
      skipped: 0,
    });

    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      const totals = db.prepare(`
        SELECT event_type, COUNT(*) AS rows, SUM(total_amount) AS cents
        FROM financial_events GROUP BY event_type ORDER BY event_type
      `).all();
      assert.deepEqual(totals, [
        { event_type: 'TransactionReportInventoryFee', rows: 1, cents: -567 },
        { event_type: 'TransactionReportLiquidation', rows: 1, cents: 1000 },
        { event_type: 'TransactionReportServiceFee', rows: 1, cents: -1234 },
      ]);
      assert.equal((db.prepare(
        `SELECT shipping_cost FROM order_items WHERE order_id = 'ORDER-1'`,
      ).get() as { shipping_cost: number }).shipping_cost, 499);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
