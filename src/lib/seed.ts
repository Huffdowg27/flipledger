/**
 * seed.ts — Populate the database with realistic mock data.
 * Run with: npx tsx src/lib/seed.ts
 *
 * All monetary values in CENTS.
 * Uses realistic Amazon fee types, ASIN formats, and supplier names.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { initializeDatabase } from './db';

const DB_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// Use the canonical schema from db.ts so seed never drifts behind the app's
// migrations. This creates every table the app expects.
initializeDatabase();

const DB_PATH = path.join(DB_DIR, 'flipledger.db');
const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');

// ─── Helpers ────────────────────────────────────────────────────────────────
const now = new Date().toISOString();
function randomDate(startDaysAgo: number, endDaysAgo: number = 0): string {
  const start = Date.now() - startDaysAgo * 86400000;
  const end = Date.now() - endDaysAgo * 86400000;
  return new Date(start + Math.random() * (end - start)).toISOString();
}
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function orderId(): string {
  return `${randomInt(100, 999)}-${randomInt(1000000, 9999999)}-${randomInt(1000000, 9999999)}`;
}

// ─── Seed Suppliers ─────────────────────────────────────────────────────────
const supplierNames = ['Walmart', 'Target', 'Best Buy', 'Costco', 'Amazon Retail', "Sam's Club", 'Walgreens', 'CVS', 'Home Depot', 'Staples'];
const insertSupplier = sqlite.prepare('INSERT OR IGNORE INTO suppliers (name, created_at) VALUES (?, ?)');
for (const name of supplierNames) {
  insertSupplier.run(name, now);
}

// ─── Seed Products ──────────────────────────────────────────────────────────
const productData = [
  { asin: 'B09V3KXJPB', sku: 'FL-LOG-001', name: 'Logitech MX Master 3S Wireless Mouse', category: 'Electronics', price: 9999 },
  { asin: 'B0BSHF7WHW', sku: 'FL-SON-002', name: 'Sony WH-1000XM5 Wireless Headphones', category: 'Electronics', price: 27999 },
  { asin: 'B0CHX3QBCH', sku: 'FL-APP-003', name: 'Apple AirPods Pro (2nd Gen) USB-C', category: 'Electronics', price: 18999 },
  { asin: 'B0D1XD1ZV3', sku: 'FL-SAM-004', name: 'Samsung Galaxy Buds3 Pro', category: 'Electronics', price: 16999 },
  { asin: 'B0BTFK22V2', sku: 'FL-FUJ-005', name: 'Fujifilm Instax Mini 12 Camera', category: 'Camera & Photo', price: 6799 },
  { asin: 'B0C8P5YXHQ', sku: 'FL-NIN-006', name: 'Nintendo Switch OLED Model', category: 'Video Games', price: 34999 },
  { asin: 'B0BT9CXXXX', sku: 'FL-DYS-007', name: 'Dyson V15 Detect Cordless Vacuum', category: 'Home & Kitchen', price: 59999 },
  { asin: 'B0CXXX1234', sku: 'FL-LEG-008', name: 'LEGO Star Wars Millennium Falcon', category: 'Toys & Games', price: 16999 },
  { asin: 'B0D2XXXX56', sku: 'FL-KUR-009', name: 'Keurig K-Supreme Plus Coffee Maker', category: 'Home & Kitchen', price: 14999 },
  { asin: 'B0B3CXXXX7', sku: 'FL-BOS-010', name: 'Bose SoundLink Flex Bluetooth Speaker', category: 'Electronics', price: 11999 },
  { asin: 'B0CXYZ0011', sku: 'FL-IRO-011', name: 'iRobot Roomba j9+ Self-Emptying Vacuum', category: 'Home & Kitchen', price: 54999 },
  { asin: 'B0D3YZ0012', sku: 'FL-CRS-012', name: 'Cricut Maker 3 Smart Cutting Machine', category: 'Arts & Crafts', price: 32999 },
  { asin: 'B09HGXXXX3', sku: 'FL-GPR-013', name: 'GoPro HERO12 Black Action Camera', category: 'Camera & Photo', price: 29999 },
  { asin: 'B0BTXXXX14', sku: 'FL-PHI-014', name: 'Philips Sonicare DiamondClean Toothbrush', category: 'Health & Personal Care', price: 14999 },
  { asin: 'B0CXZZ0015', sku: 'FL-SHK-015', name: 'Shark FlexStyle Air Drying System', category: 'Health & Personal Care', price: 24999 },
  { asin: 'B0D1ZZ0016', sku: 'FL-JBL-016', name: 'JBL Charge 5 Portable Bluetooth Speaker', category: 'Electronics', price: 13999 },
  { asin: 'B0C8ZZ0017', sku: 'FL-NRF-017', name: 'Nerf Elite 2.0 Commander RD-6 Blaster', category: 'Toys & Games', price: 2499 },
  { asin: 'B0BTZZ0018', sku: 'FL-KIT-018', name: 'KitchenAid Artisan Stand Mixer', category: 'Home & Kitchen', price: 37999 },
  { asin: 'B0CXAA0019', sku: 'FL-OSM-019', name: 'Osmo Genius Starter Kit for iPad', category: 'Toys & Games', price: 7999 },
  { asin: 'B0D2AA0020', sku: 'FL-RAZ-020', name: 'Razer DeathAdder V3 Gaming Mouse', category: 'Electronics', price: 6999 },
];

const insertProduct = sqlite.prepare('INSERT OR IGNORE INTO products (asin, sku, name, category, marketplace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
for (const p of productData) {
  insertProduct.run(p.asin, p.sku, p.name, p.category, 'amazon', now, now);
}

// ─── Seed Inventory Ledger (COGS) ───────────────────────────────────────────
const insertLedger = sqlite.prepare('INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, supplier_id, date_purchased, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
for (const p of productData) {
  const supplierId = randomInt(1, supplierNames.length);
  const buyPrice = Math.round(p.price * (0.4 + Math.random() * 0.25)); // 40-65% of sale price
  const qty = randomInt(5, 30);
  const remaining = randomInt(0, qty);
  insertLedger.run(p.asin, p.sku, buyPrice, qty, remaining, supplierId, randomDate(90, 30), now);
}

// ─── Seed Orders & Order Items ──────────────────────────────────────────────
const insertOrder = sqlite.prepare('INSERT OR IGNORE INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const insertOrderItem = sqlite.prepare('INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const insertFinEvent = sqlite.prepare('INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const insertFeeDetail = sqlite.prepare('INSERT INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date) VALUES (?, ?, ?, ?, ?, ?, ?)');
const insertSalesTax = sqlite.prepare('INSERT INTO sales_tax (order_id, state, tax_collected, marketplace_facilitator_tax, posted_date) VALUES (?, ?, ?, ?, ?)');

const states = ['CA', 'TX', 'NY', 'FL', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI', 'NJ', 'VA', 'WA', 'AZ', 'MA', 'CO', 'TN', 'IN', 'MN', 'WI'];

const seedOrders = sqlite.transaction(() => {
  for (let i = 0; i < 350; i++) {
    const oid = orderId();
    const product = randomChoice(productData);
    const isFBA = Math.random() > 0.2; // 80% FBA
    const channel = isFBA ? 'FBA' : 'MFN';
    const purchaseDate = randomDate(90);
    const isEstimated = Math.random() > 0.7 ? 1 : 0;
    const qty = Math.random() > 0.8 ? randomInt(2, 4) : 1;

    insertOrder.run(oid, purchaseDate, 'Shipped', 'amazon', channel, isEstimated, now);

    const shippingCharged = isFBA ? 0 : randomInt(499, 1299);
    const shippingCost = isFBA ? 0 : randomInt(399, 999);
    insertOrderItem.run(oid, product.asin, product.sku, qty, product.price, product.price * qty, shippingCharged, shippingCost);

    // Financial event for this sale
    const referralFee = -Math.round(product.price * qty * 0.15); // ~15% referral
    const fbaFee = isFBA ? -randomInt(350, 1200) : 0;
    const variableClosingFee = product.category === 'Video Games' ? -180 : 0;
    const totalFees = referralFee + fbaFee + variableClosingFee;
    const totalAmount = product.price * qty + totalFees + shippingCharged;

    const result = insertFinEvent.run('ShipmentEvent', purchaseDate, oid, product.asin, product.sku, 'amazon', totalAmount, now);
    const eventId = Number(result.lastInsertRowid);

    // Broken-out fee details
    insertFeeDetail.run(eventId, oid, product.asin, 'Commission', 'Selling Fees', referralFee, purchaseDate);
    if (fbaFee) {
      insertFeeDetail.run(eventId, oid, product.asin, 'FBAPerUnitFulfillmentFee', 'FBA Transaction Fees', fbaFee, purchaseDate);
    }
    if (variableClosingFee) {
      insertFeeDetail.run(eventId, oid, product.asin, 'VariableClosingFee', 'Selling Fees', variableClosingFee, purchaseDate);
    }

    // Sales tax
    const state = randomChoice(states);
    const taxAmount = Math.round(product.price * qty * (0.04 + Math.random() * 0.06));
    insertSalesTax.run(oid, state, taxAmount, taxAmount, purchaseDate);
  }
});

seedOrders();

// ─── Seed Refunds ───────────────────────────────────────────────────────────
const insertRefund = sqlite.prepare('INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const refundReasons = ['CUSTOMER_RETURN', 'DEFECTIVE', 'NOT_AS_DESCRIBED', 'WRONG_ITEM', 'ARRIVED_LATE', 'NO_REASON_GIVEN'];

// Get some existing orders to refund
const existingOrders = sqlite.prepare('SELECT order_id, asin, sku, total_price FROM order_items LIMIT 30').all() as any[];
for (let i = 0; i < 25; i++) {
  const order = existingOrders[i % existingOrders.length];
  const refundAmount = order.total_price;
  const feeClawback = Math.round(refundAmount * 0.12); // ~12% fees returned
  insertRefund.run(
    order.order_id, randomDate(60), order.asin, order.sku, 1,
    refundAmount, randomChoice(refundReasons),
    Math.random() > 0.3 ? 1 : 0, feeClawback, 'amazon', now
  );
}

// ─── Seed Reimbursements ────────────────────────────────────────────────────
const insertReimb = sqlite.prepare('INSERT INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const reimbReasons = ['LOST_INBOUND', 'DAMAGED_WAREHOUSE', 'CUSTOMER_RETURN_NOT_RECEIVED', 'FEE_CORRECTION', 'INVENTORY_LOST'];
for (let i = 0; i < 15; i++) {
  const product = randomChoice(productData);
  insertReimb.run(
    `R${randomInt(100000, 999999)}`, randomDate(60),
    product.asin, product.sku, randomChoice(reimbReasons),
    randomInt(1500, 25000), randomInt(1, 3),
    randomChoice(['Approved', 'Paid']), 'amazon', now
  );
}

// ─── Seed Removals ──────────────────────────────────────────────────────────
const insertRemoval = sqlite.prepare('INSERT INTO removals (removal_order_id, asin, sku, quantity, removal_type, reason, status, date_requested, date_completed, fee, marketplace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
for (let i = 0; i < 10; i++) {
  const product = randomChoice(productData);
  const reqDate = randomDate(60);
  insertRemoval.run(
    `RO-${randomInt(100000, 999999)}`, product.asin, product.sku,
    randomInt(1, 5), randomChoice(['Return', 'Disposal']),
    randomChoice(['Unfulfillable', 'CustomerReturn', 'Voluntary']),
    randomChoice(['Pending', 'Completed']),
    reqDate, Math.random() > 0.3 ? randomDate(30) : null,
    randomInt(50, 200), 'amazon', now
  );
}

// ─── Seed Inbound Shipments ─────────────────────────────────────────────────
const insertShipment = sqlite.prepare('INSERT INTO inbound_shipments (shipment_id, date_shipped, carrier, tracking, boxes, weight, cost, total_units, status, marketplace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const insertShipItem = sqlite.prepare('INSERT INTO inbound_shipment_items (shipment_id, asin, sku, quantity) VALUES (?, ?, ?, ?)');
const carriers = ['UPS', 'FedEx', 'Amazon Partnered Carrier', 'USPS'];
const shipStatuses = ['Closed', 'Closed', 'Closed', 'Receiving', 'In Transit'];

for (let i = 0; i < 12; i++) {
  const sid = `FBA${randomInt(10000000, 99999999)}`;
  const boxes = randomInt(1, 6);
  const totalUnits = randomInt(10, 50);
  insertShipment.run(
    sid, randomDate(90), randomChoice(carriers),
    `1Z${randomInt(100000000, 999999999)}`, boxes,
    randomInt(10, 80) + Math.random(), randomInt(1500, 8500),
    totalUnits, randomChoice(shipStatuses), 'amazon', now
  );
  // Add 2-4 products per shipment
  const numProducts = randomInt(2, 4);
  for (let j = 0; j < numProducts; j++) {
    const product = randomChoice(productData);
    insertShipItem.run(sid, product.asin, product.sku, randomInt(2, 15));
  }
}

// ─── Seed Expenses ──────────────────────────────────────────────────────────
const insertExpense = sqlite.prepare('INSERT INTO expenses (date, category, amount, description, recurring, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const expenseEntries = [
  { cat: 'Subscriptions', amt: 3999, desc: 'Amazon Professional Seller', rec: 'monthly' },
  { cat: 'Subscriptions', amt: 6900, desc: 'InventoryLab subscription', rec: 'monthly' },
  { cat: 'Subscriptions', amt: 2999, desc: 'Flipalert sourcing tool', rec: 'monthly' },
  { cat: 'Supplies', amt: 2450, desc: 'Shipping tape (12 rolls)', rec: 'one-time' },
  { cat: 'Supplies', amt: 3200, desc: 'Poly bags 100ct', rec: 'one-time' },
  { cat: 'Packaging', amt: 4500, desc: 'Boxes assorted sizes (25ct)', rec: 'one-time' },
  { cat: 'Labels', amt: 1599, desc: 'FNSKU labels (1000ct)', rec: 'one-time' },
  { cat: 'Mileage', amt: 8750, desc: 'Sourcing trips — March', rec: 'one-time' },
  { cat: 'Equipment', amt: 14999, desc: 'Dymo 450 label printer', rec: 'one-time' },
  { cat: 'Insurance', amt: 5000, desc: 'Business liability insurance', rec: 'monthly' },
  { cat: 'Storage', amt: 15000, desc: 'Storage unit rental', rec: 'monthly' },
];
for (const e of expenseEntries) {
  insertExpense.run(randomDate(60), e.cat, e.amt, e.desc, e.rec, now);
}

// ─── Seed Other Income ──────────────────────────────────────────────────────
const insertOtherIncome = sqlite.prepare('INSERT INTO other_income (date, income_type, amount, description, marketplace, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const otherIncomeEntries = [
  { type: 'ShippingCredit', amt: 1250, desc: 'MFN shipping credit' },
  { type: 'ShippingCredit', amt: 890, desc: 'MFN shipping credit' },
  { type: 'PromotionalCredit', amt: 5000, desc: 'Amazon promotional credit' },
  { type: 'Liquidation', amt: 3400, desc: 'Liquidation proceeds — returns pallet' },
  { type: 'FBAInventoryCredit', amt: 7800, desc: 'FBA inventory placement service credit' },
];
for (const inc of otherIncomeEntries) {
  insertOtherIncome.run(randomDate(60), inc.type, inc.amt, inc.desc, 'amazon', now);
}

console.log('✓ Database seeded successfully');
console.log(`  - ${supplierNames.length} suppliers`);
console.log(`  - ${productData.length} products`);
console.log(`  - 350 orders with items, fees, and tax`);
console.log(`  - 25 refunds`);
console.log(`  - 15 reimbursements`);
console.log(`  - 10 removals`);
console.log(`  - 12 inbound shipments`);
console.log(`  - ${expenseEntries.length} expenses`);
console.log(`  - ${otherIncomeEntries.length} other income entries`);
console.log(`  DB at: ${DB_PATH}`);

sqlite.close();
