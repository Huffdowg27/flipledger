import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

function makeTaxFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-report-cancelled-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.exec(`
    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,
      purchase_date TEXT NOT NULL,
      status TEXT NOT NULL,
      marketplace TEXT NOT NULL
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL,
      sku TEXT,
      quantity INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      shipping_charged INTEGER NOT NULL DEFAULT 0,
      shipping_cost INTEGER NOT NULL DEFAULT 0,
      promotional_rebate INTEGER NOT NULL DEFAULT 0,
      cogs_per_unit INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE refunds (
      order_id TEXT NOT NULL,
      refund_date TEXT NOT NULL,
      sku TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      refund_amount INTEGER NOT NULL,
      fee_clawback INTEGER NOT NULL DEFAULT 0,
      restocking_fee INTEGER NOT NULL DEFAULT 0,
      marketplace TEXT NOT NULL,
      disposition TEXT,
      item_returned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE financial_events (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      posted_date TEXT NOT NULL,
      order_id TEXT,
      marketplace TEXT NOT NULL,
      raw_data TEXT
    );
    CREATE TABLE fee_details (
      financial_event_id INTEGER NOT NULL,
      order_id TEXT,
      fee_type TEXT NOT NULL,
      fee_category TEXT,
      amount INTEGER NOT NULL,
      posted_date TEXT NOT NULL
    );
    CREATE TABLE reimbursements (
      reimbursement_id TEXT,
      reimbursement_date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      marketplace TEXT NOT NULL
    );
    CREATE TABLE other_income (
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      marketplace TEXT
    );
    CREATE TABLE dispositions (
      disp_date TEXT NOT NULL,
      buy_cost_adj INTEGER NOT NULL
    );
    CREATE TABLE inventory_ledger (
      date_purchased TEXT NOT NULL,
      buy_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL
    );
    CREATE TABLE inbound_shipments (
      date_shipped TEXT NOT NULL,
      cost INTEGER NOT NULL
    );
    CREATE TABLE expenses (
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
    CREATE TABLE sales_tax (
      state TEXT NOT NULL,
      posted_date TEXT NOT NULL,
      tax_collected INTEGER NOT NULL,
      marketplace_facilitator_tax INTEGER NOT NULL,
      marketplace TEXT NOT NULL
    );

    INSERT INTO orders VALUES
      ('SHIPPED-1', '2026-06-10T12:00:00.000Z', 'Shipped', 'amazon'),
      ('CANCELLED-1', '2026-06-11T12:00:00.000Z', 'Cancelled', 'amazon'),
      ('CANCELED-2', '2026-06-12T12:00:00.000Z', 'Canceled', 'amazon');
    INSERT INTO order_items VALUES
      (1, 'SHIPPED-1', 'SKU-SHIPPED', 2, 10000, 500, 700, -100, 3000),
      (2, 'CANCELLED-1', 'SKU-CANCELLED', 1, 4000, 300, 400, -50, 1500),
      (3, 'CANCELED-2', 'SKU-CANCELED', 1, 2000, 200, 150, -25, 800);
    INSERT INTO financial_events VALUES
      (1, 'ShipmentEvent', '2026-06-10T13:00:00.000Z', 'SHIPPED-1', 'amazon', '{}'),
      (2, 'ShipmentEvent', '2026-06-11T13:00:00.000Z', 'CANCELLED-1', 'amazon', '{}'),
      (3, 'ShipmentEvent', '2026-06-12T13:00:00.000Z', 'CANCELED-2', 'amazon', '{}');
    INSERT INTO fee_details VALUES
      (1, 'SHIPPED-1', 'Commission', 'Selling Fees', -1000, '2026-06-10T13:00:00.000Z'),
      (2, 'CANCELLED-1', 'Commission', 'Selling Fees', -500, '2026-06-11T13:00:00.000Z'),
      (3, 'CANCELED-2', 'Commission', 'Selling Fees', -250, '2026-06-12T13:00:00.000Z');
  `);
  db.pragma('journal_mode = WAL');
  db.close();
  return dir;
}

async function callTaxRoute(dir: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/tax-report/route');
    const response = await GET(new NextRequest('http://localhost/api/data/tax-report?year=2026'));
    return { response, body: await response.json() };
  } finally {
    process.chdir(previousCwd);
  }
}

test('Tax Report excludes canceled and cancelled orders from every order-derived total', async () => {
  const dir = makeTaxFixture();
  try {
    const { response, body } = await callTaxRoute(dir);

    assert.equal(response.status, 200);
    assert.deepEqual(body.summary, {
      totalRevenue: 10500,
      totalOrders: 1,
      totalUnits: 2,
      totalRefunds: 0,
      refundCount: 0,
    });
    assert.deepEqual(body.incomeByMonth, [{
      month: '2026-06',
      productSales: 10000,
      shippingIncome: 500,
      orderCount: 1,
      unitsSold: 2,
    }]);
    assert.equal(body.cogs.saleCogsBeforeDispositionAdjustments, 6000);
    assert.equal(body.cogs.costOfGoodsSold, 6000);
    assert.equal(body.amazonFeeSummary[0].total, 1000);
    assert.equal(body.promos, 100);
    assert.equal(body.shippingCosts, 700);
    assert.deepEqual(body.perMarketplace, [{
      marketplace: 'amazon',
      grossReceipts: 10500,
      productSales: 10000,
      shippingIncome: 500,
      cogs: 6000,
      fees: 1000,
      refunds: 0,
      clawbacks: 0,
      shippingCosts: 700,
      orders: 1,
      units: 2,
    }]);
    assert.equal(body.scheduleC.line31_netProfit, 2700);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
