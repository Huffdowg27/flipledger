import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import {
  addCalendarDays,
  calendarDaysBetween,
  formatCalendarDateInTimeZone,
} from '../src/lib/local-day-boundaries';

function makeProfitLossFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-reconciliation-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.exec(`
    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,
      purchase_date TEXT NOT NULL,
      status TEXT NOT NULL,
      marketplace TEXT NOT NULL,
      fulfillment_channel TEXT NOT NULL,
      order_total INTEGER NOT NULL
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      price_per_unit INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      shipping_charged INTEGER NOT NULL DEFAULT 0,
      shipping_cost INTEGER NOT NULL DEFAULT 0,
      promotional_rebate INTEGER NOT NULL DEFAULT 0,
      cogs_per_unit INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE financial_events (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      posted_date TEXT NOT NULL,
      order_id TEXT,
      marketplace TEXT NOT NULL,
      total_amount INTEGER NOT NULL DEFAULT 0,
      raw_data TEXT
    );
    CREATE INDEX idx_financial_events_posted ON financial_events(posted_date);
    CREATE INDEX idx_financial_events_order ON financial_events(order_id);
    CREATE TABLE fee_details (
      id INTEGER PRIMARY KEY,
      financial_event_id INTEGER NOT NULL,
      order_id TEXT,
      fee_type TEXT NOT NULL,
      fee_category TEXT,
      amount INTEGER NOT NULL,
      posted_date TEXT NOT NULL
    );
    CREATE TABLE refunds (
      id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL,
      refund_date TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      refund_amount INTEGER NOT NULL,
      reason TEXT,
      item_returned INTEGER NOT NULL DEFAULT 0,
      fee_clawback INTEGER NOT NULL DEFAULT 0,
      restocking_fee INTEGER NOT NULL DEFAULT 0,
      marketplace TEXT NOT NULL,
      disposition TEXT
    );
    CREATE TABLE other_income (
      date TEXT NOT NULL,
      income_type TEXT,
      amount INTEGER NOT NULL,
      description TEXT,
      marketplace TEXT
    );
    CREATE TABLE dispositions (
      disp_date TEXT NOT NULL,
      buy_cost_adj INTEGER NOT NULL
    );
    CREATE TABLE expenses (
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
    CREATE TABLE reimbursements (
      reimbursement_id TEXT,
      reimbursement_date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      marketplace TEXT NOT NULL
    );
    CREATE TABLE sales_tax (
      posted_date TEXT NOT NULL,
      tax_collected INTEGER NOT NULL,
      marketplace_facilitator_tax INTEGER NOT NULL,
      marketplace TEXT NOT NULL
    );
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

    INSERT INTO orders VALUES
      ('O-FBA', '2026-06-15T20:00:00Z', 'Shipped',  'amazon', 'FBA', 1100),
      ('O-MFN', '2026-06-16T20:00:00Z', 'Shipped',  'amazon', 'MFN', 2200),
      ('O-CANCEL', '2026-06-17T20:00:00Z', 'Canceled', 'amazon', 'MFN', 3300);
    INSERT INTO order_items VALUES
      (1, 'O-FBA', 'A-FBA', 'S-FBA', 1, 1000, 1000, 0,   0,   0, 400),
      (2, 'O-MFN', 'A-MFN', 'S-MFN', 2, 1000, 2000, 200, 300, 0, 500),
      (3, 'O-CANCEL', 'A-CANCEL', 'S-CANCEL', 3, 1000, 3000, 300, 400, 0, 600);
    INSERT INTO financial_events VALUES
      (1, 'ShipmentEvent', '2026-06-15T21:00:00Z', 'O-FBA', 'amazon', 1000, '{}'),
      (2, 'ShipmentEvent', '2026-06-16T21:00:00Z', 'O-MFN', 'amazon', 2000, '{}'),
      (3, 'ShipmentEvent', '2026-06-17T21:00:00Z', 'O-CANCEL', 'amazon', 3000, '{}');
    INSERT INTO fee_details VALUES
      (1, 1, 'O-FBA', 'Commission', 'Selling Fees', -100, '2026-06-15T21:00:00Z'),
      (2, 2, 'O-MFN', 'Commission', 'Selling Fees', -200, '2026-06-16T21:00:00Z'),
      (3, 3, 'O-CANCEL', 'Commission', 'Selling Fees', -300, '2026-06-17T21:00:00Z');
    INSERT INTO sales_tax VALUES
      ('2026-06-15T21:00:00Z', -123, -123, 'amazon');
    INSERT INTO settlement_periods VALUES
      (1, 'SETTLE-JUNE', 'amazon', '2026-06-01 00:00:00 UTC', '2026-06-30 23:59:59 UTC', '2026-07-02 12:00:00 UTC');
    INSERT INTO settlement_transactions
      (settlement_id, order_id, sku, posted_date, transaction_type, amount_type, amount_description, amount_cents)
    VALUES
      ('SETTLE-JUNE', 'O-FBA', 'S-FBA', '2026-06-15', 'Order', 'ItemPrice', 'Principal', 999999),
      ('SETTLE-JUNE', 'O-MFN', 'S-MFN', '2026-06-16', 'Refund', 'ItemPrice', 'Principal', -888888),
      ('SETTLE-JUNE', 'O-MFN', 'S-MFN', '2026-06-16', 'Refund', 'ItemFees', 'Commission', 77777);
  `);
  db.pragma('journal_mode = WAL');
  db.close();
  return dir;
}

async function callProfitLoss(dir: string, query: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/profitloss/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/profitloss?${query}`));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

async function callSnapshotWithProfitLossFixture(dir: string, query: string) {
  const previousCwd = process.cwd();
  const originalFetch = global.fetch;
  try {
    process.chdir(dir);
    global.fetch = async (input) => {
      const url = new URL(String(input));
      const { GET } = await import('../src/app/api/data/profitloss/route');
      return GET(new NextRequest(`http://localhost/api/data/profitloss?${url.searchParams.toString()}`));
    };
    const { GET } = await import('../src/app/api/data/snapshot/route');
    const response = await GET(new NextRequest(`http://localhost/api/data/snapshot?${query}`));
    return { response, body: await response.json() };
  } finally {
    global.fetch = originalFetch;
    process.chdir(previousCwd);
  }
}

function financialFields(body: Record<string, unknown>) {
  return {
    income: body.income,
    expenses: body.expenses,
    refunds: body.refunds,
    reimbursements: body.reimbursements,
    salesTax: body.salesTax,
    netProfit: body.netProfit,
    margin: body.margin,
  };
}

type SnapshotResponseCard = {
  key: string;
  start: string;
  end: string;
  sales: number;
  netProfit: number;
  cogs: number;
  margin: number;
  refunds: number;
  refundCount: number;
  refundUnits: number;
  orders: number;
  units: number;
  roi: number;
};

function findSnapshotCard(cards: SnapshotResponseCard[], key: string): SnapshotResponseCard {
  const card = cards.find((candidate) => candidate.key === key);
  assert.ok(card);
  return card;
}

test('Operating basis excludes canceled orders from all order-derived financials and counts', async () => {
  const dir = makeProfitLossFixture();
  try {
    const { response, body } = await callProfitLoss(
      dir,
      'startDate=2026-06-01&endDate=2026-06-30&dateBasis=purchase&summaryOnly=1',
    );
    assert.equal(response.status, 200);
    assert.equal(body.income.sales, 3000);
    assert.equal(body.expenses.cogs, 1400);
    assert.equal(body.expenses.totalFees, 300);
    assert.equal(body.expenses.shippingCosts, 300);
    assert.equal(body.netProfit, 1200);
    assert.equal(body.operatingSales, 3300);
    assert.deepEqual(body.unitSummary, { units: 3, orders: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Settled basis keeps its existing population even if an order later becomes canceled', async () => {
  const dir = makeProfitLossFixture();
  try {
    const { body } = await callProfitLoss(
      dir,
      'startDate=2026-06-01&endDate=2026-06-30&summaryOnly=1',
    );
    assert.equal(body.income.sales, 6000);
    assert.deepEqual(body.unitSummary, { units: 6, orders: 3 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standard June cash-basis P&L totals are unchanged by settlement-net metric rows', async () => {
  const dir = makeProfitLossFixture();
  try {
    const { response, body } = await callProfitLoss(
      dir,
      'startDate=2026-06-01&endDate=2026-06-30&summaryOnly=1',
    );
    assert.equal(response.status, 200);
    assert.deepEqual(financialFields(body), {
      income: {
        sales: 6000,
        shippingCredits: 500,
        mfnShippingCredits: 500,
        fbaShippingCredits: 0,
        promoRebates: 0,
        restockingFees: 0,
        otherIncome: 0,
        total: 6500,
      },
      expenses: {
        cogs: 3200,
        cogsGross: 3200,
        feeHierarchy: {
          'Selling Fees': {
            total: 600,
            children: [
              { name: 'Commission', amount: 600 },
            ],
          },
        },
        shippingCosts: 700,
        otherExpenses: 0,
        otherExpensesByCategory: [],
        inventoryWriteoff: 0,
        dispositionRestockReversal: 0,
        totalFees: 600,
        total: 4500,
      },
      refunds: {
        total: 0,
        clawback: 0,
        net: 0,
      },
      reimbursements: 0,
      salesTax: {
        collected: 123,
        facilitator: 123,
      },
      netProfit: 2000,
      margin: 30.76923076923077,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('channel counts and order-level financials add exactly to All on Operating basis', async () => {
  const dir = makeProfitLossFixture();
  try {
    const base = 'startDate=2026-06-01&endDate=2026-06-30&dateBasis=purchase&summaryOnly=1';
    const all = (await callProfitLoss(dir, base)).body;
    const fba = (await callProfitLoss(dir, `${base}&channel=fba`)).body;
    const mfn = (await callProfitLoss(dir, `${base}&channel=mfn`)).body;

    assert.equal(fba.unitSummary.orders + mfn.unitSummary.orders, all.unitSummary.orders);
    assert.equal(fba.unitSummary.units + mfn.unitSummary.units, all.unitSummary.units);
    assert.equal(fba.income.sales + mfn.income.sales, all.income.sales);
    assert.equal(fba.expenses.cogs + mfn.expenses.cogs, all.expenses.cogs);
    assert.equal(fba.netProfit + mfn.netProfit, all.netProfit);
    assert.equal(fba.operatingSales + mfn.operatingSales, all.operatingSales);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('channel views exclude unassignable sales-tax totals', async () => {
  const dir = makeProfitLossFixture();
  try {
    const base = 'startDate=2026-06-01&endDate=2026-06-30&summaryOnly=1';
    const all = (await callProfitLoss(dir, base)).body;
    const fba = (await callProfitLoss(dir, `${base}&channel=fba`)).body;
    const mfn = (await callProfitLoss(dir, `${base}&channel=mfn`)).body;

    assert.deepEqual(all.salesTax, { collected: 123, facilitator: 123 });
    assert.deepEqual(fba.salesTax, { collected: 0, facilitator: 0 });
    assert.deepEqual(mfn.salesTax, { collected: 0, facilitator: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('localDays absent and explicitly off return identical financial fields', async () => {
  const dir = makeProfitLossFixture();
  try {
    const base = 'startDate=2026-06-01&endDate=2026-06-30&summaryOnly=1';
    const absent = (await callProfitLoss(dir, base)).body;
    const off = (await callProfitLoss(dir, `${base}&localDays=0`)).body;
    assert.deepEqual(financialFields(off), financialFields(absent));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot reads exact aggregate counts rather than truncated detail arrays', async () => {
  const originalFetch = global.fetch;
  const cappedDetail = Array.from({ length: 500 }, (_, i) => ({
    order_id: `O-${i}`,
    quantity: 1,
  }));
  global.fetch = async () => new Response(JSON.stringify({
    income: { sales: 3005978 },
    expenses: { cogs: 1744026 },
    refunds: { total: 0 },
    netProfit: 266217,
    margin: 8.42,
    unitSummary: { orders: 544, units: 576 },
    refundSummary: { count: 66, units: 67 },
    salesDetail: cappedDetail,
    refundDetail: [],
  }));
  try {
    const { GET } = await import('../src/app/api/data/snapshot/route');
    const response = await GET(new NextRequest('http://localhost/api/data/snapshot?dateBasis=posted'));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.cards[0].orders, 544);
    assert.equal(body.cards[0].units, 576);
    assert.equal(body.cards[0].refundCount, 66);
    assert.equal(body.cards[0].refundUnits, 67);
  } finally {
    global.fetch = originalFetch;
  }
});

test('snapshot Operating sales uses the same gross order-total aggregate exposed to its drilldown', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    income: { sales: 9069 },
    operatingSales: 9870,
    expenses: { cogs: 6698 },
    refunds: { total: 7952 },
    netProfit: -3587,
    margin: -36.34,
    unitSummary: { orders: 1, units: 1 },
    refundSummary: { count: 1, units: 1 },
  }));
  try {
    const { GET } = await import('../src/app/api/data/snapshot/route');
    const response = await GET(new NextRequest('http://localhost/api/data/snapshot?dateBasis=purchase'));
    const body = await response.json();
    assert.equal(body.cards[0].sales, 9870);
    assert.equal(body.cards[0].orders, 1);
    assert.equal(body.cards[0].netProfit, -3587);
  } finally {
    global.fetch = originalFetch;
  }
});

test('snapshot FBA and FBM aggregate counts add exactly to All', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    const unitSummary = url.includes('channel=fba')
      ? { orders: 436, units: 456 }
      : url.includes('channel=mfn')
        ? { orders: 108, units: 120 }
        : { orders: 544, units: 576 };
    return new Response(JSON.stringify({
      income: { sales: 3005978 },
      expenses: { cogs: 1744026 },
      refunds: { total: 0 },
      netProfit: 266217,
      margin: 8.42,
      unitSummary,
      refundSummary: { count: 0, units: 0 },
    }));
  };
  try {
    const { GET } = await import('../src/app/api/data/snapshot/route');
    const all = await (await GET(new NextRequest('http://localhost/api/data/snapshot'))).json();
    const fba = await (await GET(new NextRequest('http://localhost/api/data/snapshot?channel=fba'))).json();
    const mfn = await (await GET(new NextRequest('http://localhost/api/data/snapshot?channel=mfn'))).json();

    assert.equal(fba.cards[0].orders + mfn.cards[0].orders, all.cards[0].orders);
    assert.equal(fba.cards[0].units + mfn.cards[0].units, all.cards[0].units);
  } finally {
    global.fetch = originalFetch;
  }
});

test('snapshot arbitrary range matches the same fixed-card window', async () => {
  const today = formatCalendarDateInTimeZone(new Date());
  const start = addCalendarDays(today, -6);
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = new URL(String(input));
    const queryStart = url.searchParams.get('startDate') || '';
    const queryEnd = url.searchParams.get('endDate') || '';
    const seed = calendarDaysBetween(queryStart, queryEnd) + queryStart.charCodeAt(8);
    return new Response(JSON.stringify({
      income: { sales: seed },
      expenses: { cogs: seed + 1 },
      refunds: { total: seed + 2 },
      netProfit: seed + 3,
      margin: seed + 4,
      unitSummary: { orders: seed + 5, units: seed + 6 },
      refundSummary: { count: seed + 7, units: seed + 8 },
    }));
  };
  try {
    const { GET } = await import('../src/app/api/data/snapshot/route');
    const response = await GET(new NextRequest(
      `http://localhost/api/data/snapshot?dateBasis=posted&startDate=${start}&endDate=${today}`,
    ));
    const body = await response.json();
    assert.equal(response.status, 200);
    const fixed = findSnapshotCard(body.cards, '7d');
    const custom = findSnapshotCard(body.cards, 'custom');
    assert.deepEqual(
      {
        start: custom.start,
        end: custom.end,
        sales: custom.sales,
        netProfit: custom.netProfit,
        cogs: custom.cogs,
        margin: custom.margin,
        refunds: custom.refunds,
        refundCount: custom.refundCount,
        refundUnits: custom.refundUnits,
        orders: custom.orders,
        units: custom.units,
        roi: custom.roi,
      },
      {
        start: fixed.start,
        end: fixed.end,
        sales: fixed.sales,
        netProfit: fixed.netProfit,
        cogs: fixed.cogs,
        margin: fixed.margin,
        refunds: fixed.refunds,
        refundCount: fixed.refundCount,
        refundUnits: fixed.refundUnits,
        orders: fixed.orders,
        units: fixed.units,
        roi: fixed.roi,
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('snapshot custom ranges use calendar-month and explicit prior windows', async () => {
  const today = formatCalendarDateInTimeZone(new Date());
  const thisMonthStart = `${today.slice(0, 7)}-01`;
  const previousMonthEnd = addCalendarDays(thisMonthStart, -1);
  const previousMonthStart = `${previousMonthEnd.slice(0, 7)}-01`;
  const originalFetch = global.fetch;
  const requestedRanges: string[] = [];
  global.fetch = async (input) => {
    const url = new URL(String(input));
    requestedRanges.push(`${url.searchParams.get('startDate')}..${url.searchParams.get('endDate')}`);
    return new Response(JSON.stringify({
      income: { sales: 100 },
      expenses: { cogs: 50 },
      refunds: { total: 0 },
      netProfit: 25,
      margin: 25,
      unitSummary: { orders: 1, units: 1 },
      refundSummary: { count: 0, units: 0 },
    }));
  };
  try {
    const { GET } = await import('../src/app/api/data/snapshot/route');
    let response = await GET(new NextRequest(
      `http://localhost/api/data/snapshot?startDate=${thisMonthStart}&endDate=${today}&customPreset=this-month`,
    ));
    assert.equal(response.status, 200);
    assert.ok(requestedRanges.includes(`${previousMonthStart}..${previousMonthEnd}`));

    requestedRanges.length = 0;
    response = await GET(new NextRequest(
      'http://localhost/api/data/snapshot?startDate=2026-06-10&endDate=2026-06-12',
    ));
    assert.equal(response.status, 200);
    assert.ok(requestedRanges.includes('2026-06-07..2026-06-09'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('snapshot custom range uses Pacific calendar month boundaries against fixture data', async () => {
  const dir = makeProfitLossFixture();
  try {
    const db = new Database(path.join(dir, 'data', 'flipledger.db'));
    db.exec(`
      INSERT INTO orders VALUES
        ('O-PACIFIC-JUNE', '2026-07-01T02:00:00Z', 'Shipped', 'amazon', 'FBA', 1200);
      INSERT INTO order_items VALUES
        (4, 'O-PACIFIC-JUNE', 'A-PACIFIC', 'S-PACIFIC', 1, 1200, 1200, 0, 0, 0, 300);
      INSERT INTO financial_events VALUES
        (4, 'ShipmentEvent', '2026-07-01T02:00:00Z', 'O-PACIFIC-JUNE', 'amazon', 1200, '{}');
    `);
    db.close();

    const june = await callSnapshotWithProfitLossFixture(
      dir,
      'dateBasis=posted&startDate=2026-06-01&endDate=2026-06-30&customPreset=last-month',
    );
    const julyFirst = await callSnapshotWithProfitLossFixture(
      dir,
      'dateBasis=posted&startDate=2026-07-01&endDate=2026-07-01',
    );

    assert.equal(june.response.status, 200);
    assert.equal(findSnapshotCard(june.body.cards, 'custom').sales, 7200);
    assert.equal(julyFirst.response.status, 200);
    assert.equal(findSnapshotCard(julyFirst.body.cards, 'custom').sales, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot rejects invalid channel, dateBasis, and custom date ranges before fetching', async () => {
  const originalFetch = global.fetch;
  let fetched = false;
  global.fetch = async () => {
    fetched = true;
    throw new Error('unexpected fetch');
  };
  try {
    const { GET } = await import('../src/app/api/data/snapshot/route');
    const badChannel = await GET(new NextRequest('http://localhost/api/data/snapshot?channel=bogus'));
    const badBasis = await GET(new NextRequest('http://localhost/api/data/snapshot?dateBasis=bogus'));
    const badDate = await GET(new NextRequest('http://localhost/api/data/snapshot?startDate=2026-06-31&endDate=2026-07-01'));
    const reversed = await GET(new NextRequest('http://localhost/api/data/snapshot?startDate=2026-07-02&endDate=2026-07-01'));

    assert.equal(badChannel.status, 400);
    assert.deepEqual(await badChannel.json(), { error: 'Invalid channel' });
    assert.equal(badBasis.status, 400);
    assert.deepEqual(await badBasis.json(), { error: 'Invalid date basis' });
    assert.equal(badDate.status, 400);
    assert.deepEqual(await badDate.json(), { error: 'Invalid date range' });
    assert.equal(reversed.status, 400);
    assert.deepEqual(await reversed.json(), { error: 'Invalid date range' });
    assert.equal(fetched, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('snapshot drilldown preserves local-day, channel, and Operating sales semantics', async () => {
  const { buildSnapshotDrilldownHref } = await import('../src/lib/snapshot-drilldown');
  assert.equal(
    buildSnapshotDrilldownHref({
      key: 'today',
      start: '2026-07-02',
      end: '2026-07-02',
      dateBasis: 'purchase',
      channel: 'mfn',
    }),
    '/analyze/profitloss?preset=today&startDate=2026-07-02&endDate=2026-07-02&dateBasis=purchase&channel=mfn&localDays=1&salesMetric=orderTotal',
  );
  assert.equal(
    buildSnapshotDrilldownHref({
      key: '14d',
      start: '2026-06-19',
      end: '2026-07-02',
      dateBasis: 'posted',
      channel: null,
    }),
    '/analyze/profitloss?preset=custom&startDate=2026-06-19&endDate=2026-07-02&localDays=1',
  );
});
