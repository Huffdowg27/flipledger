import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { isCogsEncodedSku, isAmazonGradedSku } from '../src/lib/sku-cogs';

// ── Writer guard (orders.ts / backfill use this exact predicate) ────────────
test('lot-creation predicate: encoded SKU yes, amzn.gr-wrapped encoded SKU no', () => {
  const create = (sku: string) => isCogsEncodedSku(sku) && !isAmazonGradedSku(sku);
  assert.equal(create('LV_01FAFLIP_030226_22.5_52_3_P_212'), true);   // ordinary encoded → lot
  assert.equal(create('ZTPC_01KOH_012326_5.6_23_5_B_979'), true);     // ordinary encoded → lot
  assert.equal(create('amzn.gr.LV_01AFLIP_112025_17.9-JcSyVV-LN'), false); // graded → NO lot
  assert.equal(create('amzn.gr.ZTPC_01KOH_012326_5.6_23_5_B_979'), false); // graded → NO lot
  assert.equal(isAmazonGradedSku('amzn.grading.LV_X_Y_1'), false, 'prefix requires the dot boundary');
});

// ── Real FIFO engine against a fixture DB in a temp cwd ─────────────────────
function makeFixture(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fifo-fix-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const dbPath = path.join(dir, 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY, sku TEXT, asin TEXT, buy_price INTEGER,
      quantity INTEGER, quantity_remaining INTEGER, date_purchased TEXT, notes TEXT
    );
    CREATE TABLE orders (order_id TEXT PRIMARY KEY, purchase_date TEXT, status TEXT);
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY, order_id TEXT, sku TEXT, asin TEXT,
      quantity INTEGER, cogs_per_unit INTEGER
    );
    CREATE TABLE refunds (
      id INTEGER PRIMARY KEY, order_id TEXT, refund_date TEXT, sku TEXT, asin TEXT,
      quantity INTEGER, disposition TEXT, item_returned INTEGER,
      inventory_restored_quantity INTEGER NOT NULL DEFAULT 0,
      inventory_restore_error TEXT,
      inventory_restore_checked_at TEXT,
      marketplace TEXT
    );
  `);
  // One real lot under SKU-N / ASIN-1.
  db.prepare(`INSERT INTO inventory_ledger (id,sku,asin,buy_price,quantity,quantity_remaining,date_purchased,notes)
              VALUES (1,'SKU-N','ASIN-1',1000,5,5,'2026-01-01','sku:auto')`).run();
  // A ghost amzn.gr lot (must never be processed or refilled).
  db.prepare(`INSERT INTO inventory_ledger (id,sku,asin,buy_price,quantity,quantity_remaining,date_purchased,notes)
              VALUES (2,'amzn.gr.SKU-N','ASIN-1',7000,3,1,'2026-01-02','sku:auto')`).run();

  const ord = db.prepare(`INSERT INTO orders (order_id,purchase_date,status) VALUES (?,?, 'Shipped')`);
  const oi = db.prepare(`INSERT INTO order_items (id,order_id,sku,asin,quantity,cogs_per_unit) VALUES (?,?,?,?,?,?)`);
  ord.run('O1', '2026-02-01'); oi.run(1, 'O1', 'SKU-N', 'ASIN-1', 1, 0);                 // normal sale
  ord.run('O2', '2026-02-02'); oi.run(2, 'O2', 'amzn.gr.SKU-N', 'ASIN-1', 1, 999);       // graded resale, pre-set cogs
  ord.run('O3', '2026-02-03'); oi.run(3, 'O3', 'SKU-ORPHAN', 'ASIN-1', 1, 0);            // orphan → ASIN fallback
  db.close();
  return { dir, dbPath };
}

function readState(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  const cogsRows = db.prepare('SELECT id, cogs_per_unit FROM order_items').all() as
    { id: number; cogs_per_unit: number }[];
  const lotRows = db.prepare('SELECT id, quantity_remaining FROM inventory_ledger').all() as
    { id: number; quantity_remaining: number }[];
  const cogs = Object.fromEntries(cogsRows.map((r) => [r.id, r.cogs_per_unit]));
  const rem = Object.fromEntries(lotRows.map((r) => [r.id, r.quantity_remaining]));
  db.close();
  return { cogs, rem };
}

async function runRecalc(
  dir: string,
  options: { sku?: string; asin?: string; recalcAll?: boolean } = { recalcAll: true },
) {
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const { recalculateFIFO } = await import('../src/lib/fifo');
    return recalculateFIFO(options);
  } finally {
    process.chdir(cwd);
  }
}

test('FIFO: only the normal sale consumes a lot; amzn.gr resets to 0; ghost lot untouched', async () => {
  const { dir, dbPath } = makeFixture();
  try {
    await runRecalc(dir);
    const { cogs, rem } = readState(dbPath);
    assert.equal(cogs[1], 1000, 'normal sale gets real COGS');
    assert.equal(cogs[2], 0, 'amzn.gr resale resets to 0');
    assert.equal(cogs[3], 1000, 'orphan sale consumes lot via ASIN fallback (deterministic)');
    // Real lot #1: started at 5, consumed by O1 (1) + O3 orphan (1) = 3 remaining.
    assert.equal(rem[1], 3, 'real lot depleted only by the two non-graded sales');
    // Ghost amzn.gr lot #2: NEVER processed → quantity_remaining untouched (still 1, not refilled to 3).
    assert.equal(rem[2], 1, 'ghost amzn.gr lot not refilled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: replay twice produces identical output', async () => {
  const { dir, dbPath } = makeFixture();
  try {
    await runRecalc(dir);
    const first = readState(dbPath);
    await runRecalc(dir);
    const second = readState(dbPath);
    assert.deepEqual(first, second);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: a confirmed SELLABLE return restores its original finite lot', async () => {
  const { dir, dbPath } = makeFixture();
  const db = new Database(dbPath);
  db.prepare('DELETE FROM orders WHERE order_id != ?').run('O1');
  db.prepare('DELETE FROM order_items WHERE order_id != ?').run('O1');
  db.prepare('UPDATE inventory_ledger SET quantity = 1, quantity_remaining = 0 WHERE id = 1').run();
  db.prepare(`
    INSERT INTO refunds (
      id, order_id, refund_date, sku, asin, quantity, disposition, item_returned, marketplace
    ) VALUES (1, 'O1', '2026-02-02', 'SKU-N', 'ASIN-1', 1, 'SELLABLE', 1, 'amazon')
  `).run();
  db.close();

  try {
    const result = await runRecalc(dir);
    const state = readState(dbPath);
    const checkDb = new Database(dbPath, { readonly: true });
    const check = checkDb.prepare(`
      SELECT inventory_restored_quantity restored, inventory_restore_error error
      FROM refunds WHERE id = 1
    `).get() as { restored: number; error: string | null };
    checkDb.close();

    assert.deepEqual(result.errors, []);
    assert.equal(state.rem[1], 1, 'the returned unit is available for a future resale');
    assert.deepEqual(check, { restored: 1, error: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: a multi-unit return restores every finite lot consumed by the sale', async () => {
  const { dir, dbPath } = makeFixture();
  const db = new Database(dbPath);
  db.prepare('DELETE FROM orders').run();
  db.prepare('DELETE FROM order_items').run();
  db.prepare('DELETE FROM inventory_ledger').run();
  db.prepare(`
    INSERT INTO inventory_ledger
      (id,sku,asin,buy_price,quantity,quantity_remaining,date_purchased,notes)
    VALUES
      (10,'SKU-M','ASIN-M',1000,1,0,'2026-01-01','sku:auto'),
      (11,'SKU-M','ASIN-M',2000,1,0,'2026-01-02','sku:auto')
  `).run();
  db.prepare(`INSERT INTO orders (order_id,purchase_date,status) VALUES ('OM','2026-02-01','Shipped')`).run();
  db.prepare(`
    INSERT INTO order_items (id,order_id,sku,asin,quantity,cogs_per_unit)
    VALUES (10,'OM','SKU-M','ASIN-M',2,0)
  `).run();
  db.prepare(`
    INSERT INTO refunds (
      id, order_id, refund_date, sku, asin, quantity, disposition, item_returned, marketplace
    ) VALUES (10,'OM','2026-02-02','SKU-M','ASIN-M',2,'SELLABLE',1,'amazon')
  `).run();
  db.close();

  try {
    await runRecalc(dir);
    const checkDb = new Database(dbPath, { readonly: true });
    const lots = checkDb.prepare(`
      SELECT id, quantity_remaining remaining FROM inventory_ledger ORDER BY id
    `).all();
    const refund = checkDb.prepare(`
      SELECT inventory_restored_quantity restored, inventory_restore_error error
      FROM refunds WHERE id = 10
    `).get();
    checkDb.close();

    assert.deepEqual(lots, [{ id: 10, remaining: 1 }, { id: 11, remaining: 1 }]);
    assert.deepEqual(refund, { restored: 2, error: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: a partial return reverses the newest allocation from a multi-lot sale', async () => {
  const { dir, dbPath } = makeFixture();
  const db = new Database(dbPath);
  db.prepare('DELETE FROM orders').run();
  db.prepare('DELETE FROM order_items').run();
  db.prepare('DELETE FROM inventory_ledger').run();
  db.prepare(`
    INSERT INTO inventory_ledger
      (id,sku,asin,buy_price,quantity,quantity_remaining,date_purchased,notes)
    VALUES
      (20,'SKU-P','ASIN-P',1000,1,0,'2026-01-01','sku:auto'),
      (21,'SKU-P','ASIN-P',2000,1,0,'2026-01-02','sku:auto')
  `).run();
  db.prepare(`INSERT INTO orders (order_id,purchase_date,status) VALUES ('OP','2026-02-01','Shipped')`).run();
  db.prepare(`
    INSERT INTO order_items (id,order_id,sku,asin,quantity,cogs_per_unit)
    VALUES (20,'OP','SKU-P','ASIN-P',2,0)
  `).run();
  db.prepare(`
    INSERT INTO refunds (
      id, order_id, refund_date, sku, asin, quantity, disposition, item_returned, marketplace
    ) VALUES (20,'OP','2026-02-02','SKU-P','ASIN-P',1,'SELLABLE',1,'amazon')
  `).run();
  db.close();

  try {
    await runRecalc(dir);
    const checkDb = new Database(dbPath, { readonly: true });
    const lots = checkDb.prepare(`
      SELECT id, quantity_remaining remaining FROM inventory_ledger ORDER BY id
    `).all();
    checkDb.close();

    assert.deepEqual(lots, [
      { id: 20, remaining: 0 },
      { id: 21, remaining: 1 },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: an overflow return records the unrestored quantity as an integrity error', async () => {
  const { dir, dbPath } = makeFixture();
  const db = new Database(dbPath);
  db.prepare('DELETE FROM orders').run();
  db.prepare('DELETE FROM order_items').run();
  db.prepare('DELETE FROM inventory_ledger').run();
  db.prepare(`
    INSERT INTO inventory_ledger
      (id,sku,asin,buy_price,quantity,quantity_remaining,date_purchased,notes)
    VALUES (30,'SKU-X','ASIN-X',1000,1,0,'2026-01-01','sku:auto')
  `).run();
  db.prepare(`INSERT INTO orders (order_id,purchase_date,status) VALUES ('OX','2026-02-01','Shipped')`).run();
  db.prepare(`
    INSERT INTO order_items (id,order_id,sku,asin,quantity,cogs_per_unit)
    VALUES (30,'OX','SKU-X','ASIN-X',2,0)
  `).run();
  db.prepare(`
    INSERT INTO refunds (
      id, order_id, refund_date, sku, asin, quantity, disposition, item_returned, marketplace
    ) VALUES (30,'OX','2026-02-02','SKU-X','ASIN-X',2,'SELLABLE',1,'amazon')
  `).run();
  db.close();

  try {
    const result = await runRecalc(dir);
    const checkDb = new Database(dbPath, { readonly: true });
    const refund = checkDb.prepare(`
      SELECT inventory_restored_quantity restored, inventory_restore_error error
      FROM refunds WHERE id = 30
    `).get() as { restored: number; error: string | null };
    checkDb.close();

    assert.equal(refund.restored, 1);
    assert.match(refund.error || '', /1 of 2 confirmed unit.*could not be restored/);
    assert.equal(result.returnRestoreMismatches, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: a confirmed amzn.gr return is accounted without refilling a real or ghost lot', async () => {
  const { dir, dbPath } = makeFixture();
  const db = new Database(dbPath);
  db.prepare(`
    INSERT INTO refunds (
      id, order_id, refund_date, sku, asin, quantity, disposition, item_returned, marketplace
    ) VALUES (
      40, 'O2', '2026-02-04', 'amzn.gr.SKU-N', 'ASIN-1', 1, 'SELLABLE', 1, 'amazon'
    )
  `).run();
  db.close();

  try {
    const before = readState(dbPath);
    const result = await runRecalc(dir);
    const after = readState(dbPath);
    const checkDb = new Database(dbPath, { readonly: true });
    const refund = checkDb.prepare(`
      SELECT inventory_restored_quantity restored, inventory_restore_error error
      FROM refunds WHERE id = 40
    `).get();
    checkDb.close();

    assert.deepEqual(refund, { restored: 1, error: null });
    assert.equal(result.returnRestoreMismatches, 0);
    assert.equal(after.rem[2], before.rem[2], 'graded ghost lot remains untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: a dirty SKU mapped to two ASINs still processes its return only once', async () => {
  const { dir, dbPath } = makeFixture();
  const db = new Database(dbPath);
  db.prepare(`
    INSERT INTO inventory_ledger
      (id,sku,asin,buy_price,quantity,quantity_remaining,date_purchased,notes)
    VALUES (3,'SKU-N','ASIN-2',1000,1,1,'2026-01-03','sku:auto')
  `).run();
  db.prepare(`
    INSERT INTO refunds (
      id, order_id, refund_date, sku, asin, quantity, disposition, item_returned, marketplace
    ) VALUES (50,'O1','2026-02-04','SKU-N','ASIN-1',1,'SELLABLE',1,'amazon')
  `).run();
  db.close();

  try {
    const result = await runRecalc(dir);
    assert.equal(result.returnsConfirmed, 1);
    assert.equal(result.returnsRestored, 1);
    assert.equal(result.returnRestoreMismatches, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: NULL and blank SKUs remain eligible for ordinary ASIN fallback', async () => {
  const { dir, dbPath } = makeFixture();
  const db = new Database(dbPath);
  const ord = db.prepare(`INSERT INTO orders (order_id,purchase_date,status) VALUES (?,?, 'Shipped')`);
  const oi = db.prepare(`INSERT INTO order_items (id,order_id,sku,asin,quantity,cogs_per_unit) VALUES (?,?,?,?,?,?)`);
  ord.run('O4', '2026-02-04'); oi.run(4, 'O4', null, 'ASIN-1', 1, 0);
  ord.run('O5', '2026-02-05'); oi.run(5, 'O5', '', 'ASIN-1', 1, 0);
  db.close();

  try {
    const result = await runRecalc(dir);
    const { cogs, rem } = readState(dbPath);
    assert.deepEqual(result.errors, []);
    assert.equal(cogs[4], 1000, 'NULL-SKU sale consumes via ASIN fallback');
    assert.equal(cogs[5], 1000, 'blank-SKU sale consumes via ASIN fallback');
    assert.equal(rem[1], 1, 'all four ordinary sales consume the real lot');
    assert.equal(rem[2], 1, 'graded ghost lot remains untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: scoped graded-SKU recalc clears COGS even when no ledger lot exists', async () => {
  const { dir, dbPath } = makeFixture();
  const db = new Database(dbPath);
  db.prepare('DELETE FROM inventory_ledger WHERE sku = ?').run('amzn.gr.SKU-N');
  db.close();

  try {
    const result = await runRecalc(dir, { sku: 'amzn.gr.SKU-N' });
    const { cogs } = readState(dbPath);
    assert.deepEqual(result.errors, []);
    assert.equal(cogs[2], 0);
    assert.equal(result.itemsUpdated, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: scoped ASIN recalc clears graded COGS when only graded rows and ghost lots exist', async () => {
  const { dir, dbPath } = makeFixture();
  const db = new Database(dbPath);
  db.prepare('DELETE FROM order_items WHERE sku NOT LIKE ?').run('amzn.gr.%');
  db.prepare('DELETE FROM inventory_ledger WHERE sku NOT LIKE ?').run('amzn.gr.%');
  db.close();

  try {
    const result = await runRecalc(dir, { asin: 'ASIN-1' });
    const { cogs, rem } = readState(dbPath);
    assert.deepEqual(result.errors, []);
    assert.equal(cogs[2], 0);
    assert.equal(result.itemsUpdated, 1);
    assert.equal(rem[2], 1, 'ghost lot is not refilled by the scoped reset');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: similar-looking non-graded SKU is not zeroed by the graded reset', async () => {
  const { dir, dbPath } = makeFixture();
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO orders (order_id,purchase_date,status) VALUES (?,?, 'Shipped')`)
    .run('O4', '2026-02-04');
  db.prepare(`INSERT INTO order_items (id,order_id,sku,asin,quantity,cogs_per_unit) VALUES (?,?,?,?,?,?)`)
    .run(4, 'O4', 'amzn.grading.SKU-X', 'ASIN-2', 1, 777);
  db.close();

  try {
    await runRecalc(dir);
    const { cogs } = readState(dbPath);
    assert.equal(cogs[4], 777);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FIFO: unknown ordinary scoped targets still report missing-ledger errors', async () => {
  const { dir } = makeFixture();
  try {
    const bySku = await runRecalc(dir, { sku: 'SKU-DOES-NOT-EXIST' });
    const byAsin = await runRecalc(dir, { asin: 'ASIN-DOES-NOT-EXIST' });
    assert.deepEqual(bySku.errors, ['No inventory_ledger entry for SKU: SKU-DOES-NOT-EXIST']);
    assert.deepEqual(byAsin.errors, ['No inventory_ledger entries for ASIN: ASIN-DOES-NOT-EXIST']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
