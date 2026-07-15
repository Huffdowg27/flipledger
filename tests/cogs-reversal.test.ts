import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  recognizedCogsCents,
  sellableReturnJoin,
  recognizedCogsExpr,
} from '../src/lib/cogs-reversal';

// ── Pure reference implementation ──────────────────────────────────────────
test('recognizedCogsCents: quantity-aware reversal + amzn.gr zeroing', () => {
  assert.equal(recognizedCogsCents(1000, 2, 1, false), 1000); // 2 sold, 1 returned → 1 unit
  assert.equal(recognizedCogsCents(1000, 2, 2, false), 0);    // 2 sold, 2 returned → 0
  assert.equal(recognizedCogsCents(1000, 1, 1, false), 0);    // 1 sold, 1 returned → 0
  assert.equal(recognizedCogsCents(1000, 1, 3, false), 0);    // returned > sold → cap → 0
  assert.equal(recognizedCogsCents(1000, 3, 0, false), 3000); // none returned → full line
  assert.equal(recognizedCogsCents(1000, 2, 1, true), 0);     // amzn.gr → 0 regardless
});

// ── SQL integration: build a minimal in-memory DB and run the REAL fragments ─
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY, order_id TEXT, sku TEXT, asin TEXT,
      quantity INTEGER, cogs_per_unit INTEGER
    );
    CREATE TABLE refunds (
      id INTEGER PRIMARY KEY, order_id TEXT, sku TEXT, asin TEXT,
      quantity INTEGER DEFAULT 1, disposition TEXT, item_returned INTEGER DEFAULT 0,
      marketplace TEXT DEFAULT 'amazon'
    );
  `);
  return db;
}

// recognized COGS per line, exactly as the summary/detail queries compute it.
function recognizedRows(db: Database.Database) {
  return db.prepare(`
    SELECT oi.order_id, oi.sku, ${recognizedCogsExpr('oi')} AS cogs
    FROM order_items oi
    ${sellableReturnJoin('oi')}
    ORDER BY oi.id
  `).all() as { order_id: string; sku: string; cogs: number }[];
}

test('SQL: each scenario recognizes the correct COGS', () => {
  const db = makeDb();
  const oi = db.prepare(`INSERT INTO order_items (id,order_id,sku,asin,quantity,cogs_per_unit) VALUES (?,?,?,?,?,?)`);
  const rf = db.prepare(`INSERT INTO refunds (order_id,sku,asin,quantity,disposition,item_returned,marketplace) VALUES (?,?,?,?,?,?,?)`);

  // O1: 2 sold, 1 sellable-returned → recognize 1×1000 = 1000
  oi.run(1, 'O1', 'SKU-A', 'ASIN-A', 2, 1000);
  rf.run('O1', 'SKU-A', 'ASIN-A', 1, 'SELLABLE', 1, 'amazon');
  // O2: 2 sold, 2 returned → 0
  oi.run(2, 'O2', 'SKU-B', 'ASIN-B', 2, 1000);
  rf.run('O2', 'SKU-B', 'ASIN-B', 2, 'SELLABLE', 1, 'amazon');
  // O3: 1 sold, 1 returned → 0
  oi.run(3, 'O3', 'SKU-C', 'ASIN-C', 1, 1000);
  rf.run('O3', 'SKU-C', 'ASIN-C', 1, 'SELLABLE', 1, 'amazon');
  // O4: 1 sold, 3 returned (impossible over-report) → cap → 0
  oi.run(4, 'O4', 'SKU-D', 'ASIN-D', 1, 1000);
  rf.run('O4', 'SKU-D', 'ASIN-D', 3, 'SELLABLE', 1, 'amazon');
  // O5: 3 sold, TWO qualifying refund rows (1 + 1) → aggregate 2 → recognize 1×1000
  oi.run(5, 'O5', 'SKU-E', 'ASIN-E', 3, 1000);
  rf.run('O5', 'SKU-E', 'ASIN-E', 1, 'SELLABLE', 1, 'amazon');
  rf.run('O5', 'SKU-E', 'ASIN-E', 1, 'SELLABLE', 1, 'amazon');
  // O6: non-qualifying refunds (unconfirmed + non-sellable) → no reversal → full 2×1000
  oi.run(6, 'O6', 'SKU-F', 'ASIN-F', 2, 1000);
  rf.run('O6', 'SKU-F', 'ASIN-F', 1, 'SELLABLE', 0, 'amazon');           // item_returned=0
  rf.run('O6', 'SKU-F', 'ASIN-F', 1, 'CUSTOMER_DAMAGED', 1, 'amazon');   // not sellable
  // O7: amzn.gr resale with a sellable return present → still 0
  oi.run(7, 'O7', 'amzn.gr.SKU-G', 'ASIN-G', 2, 1000);
  rf.run('O7', 'amzn.gr.SKU-G', 'ASIN-G', 1, 'SELLABLE', 1, 'amazon');

  const byOrder = Object.fromEntries(recognizedRows(db).map((r) => [r.order_id, r.cogs]));
  assert.equal(byOrder.O1, 1000, 'O1: 2 sold 1 returned → 1 unit');
  assert.equal(byOrder.O2, 0, 'O2: fully returned → 0');
  assert.equal(byOrder.O3, 0, 'O3: single unit returned → 0');
  assert.equal(byOrder.O4, 0, 'O4: over-report capped → 0');
  assert.equal(byOrder.O5, 1000, 'O5: aggregate two refund rows → recognize 1');
  assert.equal(byOrder.O6, 2000, 'O6: non-qualifying refunds → full line');
  assert.equal(byOrder.O7, 0, 'O7: amzn.gr → 0');
  db.close();
});

test('SQL: summary SUM equals sum of sales-detail rows (they must agree)', () => {
  const db = makeDb();
  const oi = db.prepare(`INSERT INTO order_items (id,order_id,sku,asin,quantity,cogs_per_unit) VALUES (?,?,?,?,?,?)`);
  const rf = db.prepare(`INSERT INTO refunds (order_id,sku,asin,quantity,disposition,item_returned,marketplace) VALUES (?,?,?,?,?,?,?)`);
  oi.run(1, 'O1', 'SKU-A', 'ASIN-A', 2, 1500);
  rf.run('O1', 'SKU-A', 'ASIN-A', 1, 'SELLABLE', 1, 'amazon');
  oi.run(2, 'O2', 'SKU-B', 'ASIN-B', 3, 800);
  oi.run(3, 'O3', 'amzn.gr.X', 'ASIN-C', 1, 999);

  // Summary-style aggregate
  const summary = (db.prepare(`
    SELECT COALESCE(SUM(${recognizedCogsExpr('oi')}),0) AS total
    FROM order_items oi ${sellableReturnJoin('oi')}
  `).get() as any).total;
  // Detail-style per-row, then summed in JS
  const detailSum = recognizedRows(db).reduce((s, r) => s + r.cogs, 0);
  assert.equal(summary, detailSum);
  assert.equal(summary, 1500 * 1 + 800 * 3 + 0); // 1500 + 2400
  db.close();
});
