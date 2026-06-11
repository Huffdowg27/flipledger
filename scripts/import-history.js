#!/usr/bin/env node
/**
 * Load historical Amazon Date Range Transaction Reports and InventoryLab
 * sales exports into dedicated history tables.
 *
 * - historical_transactions: one row per report line (2017→2025 CSVs).
 *   Settlement-truth revenue/fees for the pre-API era. The P&L will read
 *   these ONLY for dates before the sync-coverage cutover (2024-07-01);
 *   rows after that exist purely for verification queries.
 * - historical_cogs: one row per IL sales line (back to 2014) — the buy
 *   costs. Joins to historical_transactions by order_id for per-order
 *   profit. NEVER feeds inventory_ledger/FIFO (sold inventory would
 *   become phantom on-hand lots).
 *
 * Idempotent: each file's rows are DELETEd (by source_file) and reloaded.
 * Money stored as integer cents. Dates stored as 'YYYY-MM-DD' in the
 * report's own timezone (Pacific) — matches Amazon/IL/tax-period bucketing.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'flipledger.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS historical_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_date TEXT NOT NULL,            -- YYYY-MM-DD (Pacific, as reported)
  type TEXT NOT NULL,                -- Order, Refund, Service Fee, ...
  order_id TEXT,
  sku TEXT,
  description TEXT,
  quantity INTEGER,
  fulfillment TEXT,
  product_sales INTEGER NOT NULL DEFAULT 0,
  shipping_credits INTEGER NOT NULL DEFAULT 0,
  gift_wrap_credits INTEGER NOT NULL DEFAULT 0,
  promotional_rebates INTEGER NOT NULL DEFAULT 0,
  marketplace_withheld_tax INTEGER NOT NULL DEFAULT 0,
  selling_fees INTEGER NOT NULL DEFAULT 0,
  fba_fees INTEGER NOT NULL DEFAULT 0,
  other_transaction_fees INTEGER NOT NULL DEFAULT 0,
  other INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  source_file TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_txn_date ON historical_transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_hist_txn_order ON historical_transactions(order_id);
CREATE TABLE IF NOT EXISTS historical_cogs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_posted TEXT NOT NULL,         -- YYYY-MM-DD
  order_id TEXT,
  msku TEXT,
  asin TEXT,
  quantity INTEGER,
  buy_cost INTEGER NOT NULL DEFAULT 0,  -- cents, TOTAL for the row (IL semantics)
  supplier TEXT,
  channel TEXT NOT NULL,             -- 'FBA' | 'MFN'
  source_file TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_cogs_date ON historical_cogs(date_posted);
CREATE INDEX IF NOT EXISTS idx_hist_cogs_order ON historical_cogs(order_id);
`);

// ---------- shared parsing ----------
function money(s) {
  if (!s) return 0;
  s = s.replace(/[",$]/g, '').trim();
  if (!s) return 0;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1); }
  const v = parseFloat(s);
  if (isNaN(v)) return 0;
  return Math.round((neg ? -v : v) * 100);
}

// minimal CSV parser (quoted fields, embedded commas/quotes)
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
function reportDate(s) { // "Jan 1, 2024 12:15:31 AM PST" -> 2024-01-01
  const p = s.replace(',', '').split(/\s+/);
  const m = MONTHS[p[0]]; if (!m) return null;
  return `${p[2]}-${m}-${String(p[1]).padStart(2, '0')}`;
}
function ilDate(s) { // "6/6/2026 11:21:36 PM" -> 2026-06-06
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// ---------- transaction reports ----------
const txnDir = path.join(__dirname, '..', 'imports', 'transaction-reports');
const insTxn = db.prepare(`INSERT INTO historical_transactions
  (txn_date, type, order_id, sku, description, quantity, fulfillment,
   product_sales, shipping_credits, gift_wrap_credits, promotional_rebates,
   marketplace_withheld_tax, selling_fees, fba_fees, other_transaction_fees,
   other, total, source_file)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

for (const file of fs.readdirSync(txnDir).filter(f => f.endsWith('.csv')).sort()) {
  const lines = fs.readFileSync(path.join(txnDir, file), 'utf8').replace(/^﻿/, '').split('\n');
  const hi = lines.findIndex(l => l.startsWith('"date/time"') || l.startsWith('date/time'));
  if (hi < 0) { console.error(`SKIP ${file}: no header`); continue; }
  const hdr = parseCsvLine(lines[hi]);
  const ix = {}; hdr.forEach((h, i) => { ix[h] = i; });
  const need = c => ix[c] !== undefined ? ix[c] : -1;
  const rows = [];
  for (let i = hi + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = parseCsvLine(lines[i]);
    if (c.length !== hdr.length) continue;
    const d = reportDate(c[ix['date/time']]);
    if (!d) continue;
    rows.push([
      d, c[ix['type']] || '?', c[ix['order id']] || null, c[ix['sku']] || null,
      (c[ix['description']] || '').slice(0, 200), parseInt(c[ix['quantity']]) || null,
      c[need('fulfillment')] >= 0 ? c[ix['fulfillment']] || null : null,
      money(c[ix['product sales']]), money(c[ix['shipping credits']]),
      money(c[ix['gift wrap credits']]), money(c[ix['promotional rebates']]),
      money(c[ix['marketplace withheld tax']]), money(c[ix['selling fees']]),
      money(c[ix['fba fees']]), money(c[ix['other transaction fees']]),
      money(c[ix['other']]), money(c[ix['total']]), file,
    ]);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM historical_transactions WHERE source_file = ?').run(file);
    for (const r of rows) insTxn.run(...r);
  })();
  console.log(`txn ${file}: ${rows.length} rows`);
}

// ---------- IL sales (COGS) ----------
const ilDir = path.join(__dirname, '..', 'imports', 'il-history');
const insCogs = db.prepare(`INSERT INTO historical_cogs
  (date_posted, order_id, msku, asin, quantity, buy_cost, supplier, channel, source_file)
  VALUES (?,?,?,?,?,?,?,?,?)`);

for (const file of fs.readdirSync(ilDir).filter(f => f.endsWith('.csv')).sort()) {
  const channel = /MFN/i.test(file) ? 'MFN' : 'FBA';
  const lines = fs.readFileSync(path.join(ilDir, file), 'utf8').replace(/^﻿/, '').split('\n');
  const hdr = parseCsvLine(lines[0]);
  const ix = {}; hdr.forEach((h, i) => { ix[h.trim()] = i; });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = parseCsvLine(lines[i]);
    if (c.length !== hdr.length) continue;
    const d = ilDate(c[ix['Date Posted']] || '');
    if (!d) continue;
    // IL Buy Cost is the row TOTAL and shows as "(19.75)" — a cost. Store positive cents.
    rows.push([
      d, c[ix['Order ID']] || null, c[ix['MSKU']] || null, c[ix['ASIN']] || null,
      parseInt(c[ix['Quantity Shipped']]) || null, Math.abs(money(c[ix['Buy Cost']])),
      c[ix['Supplier']] || null, channel, file,
    ]);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM historical_cogs WHERE source_file = ?').run(file);
    for (const r of rows) insCogs.run(...r);
  })();
  console.log(`cogs ${file}: ${rows.length} rows`);
}

// ---------- IL disposition ledger (return restocks + write-offs) ----------
// buy_cost_adj sign (IL's): positive = unit restocked to inventory (COGS
// reversal), negative = unit written off (cost into COGS). FBA-return
// reversals do NOT appear here — IL applies those silently from Amazon's
// disposition; the P&L derives them from Refund rows × per-unit cost.
db.exec(`
CREATE TABLE IF NOT EXISTS historical_dispositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  disp_date TEXT NOT NULL,           -- YYYY-MM-DD
  type TEXT NOT NULL,                -- Removal | MFN Return | Liquidate | Disposal
  ref_id TEXT,
  msku TEXT,
  asin TEXT,
  sellable_qty INTEGER,
  unsellable_qty INTEGER,
  buy_cost_adj INTEGER NOT NULL DEFAULT 0,  -- cents, signed (see above)
  source_file TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_disp_date ON historical_dispositions(disp_date);
`);
const insDisp = db.prepare(`INSERT INTO historical_dispositions
  (disp_date, type, ref_id, msku, asin, sellable_qty, unsellable_qty, buy_cost_adj, source_file)
  VALUES (?,?,?,?,?,?,?,?,?)`);
for (const file of fs.readdirSync(ilDir).filter(f => /^Dispositions .*\.csv$/.test(f)).sort()) {
  const lines = fs.readFileSync(path.join(ilDir, file), 'utf8').replace(/^﻿/, '').split('\n');
  const hdr = parseCsvLine(lines[0]);
  const ix = {}; hdr.forEach((h, i) => { ix[h.trim()] = i; });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = parseCsvLine(lines[i]);
    if (c.length !== hdr.length) continue;
    const d = ilDate(c[ix['Date']] || '');
    if (!d) continue;
    rows.push([
      d, c[ix['Type']] || '?', c[ix['ID']] || null, c[ix['MSKU']] || null, c[ix['ASIN']] || null,
      parseInt(c[ix['SellableQty']]) || 0, parseInt(c[ix['UnsellableQty']]) || 0,
      money(c[ix['Buy Cost Adj']]), file,
    ]);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM historical_dispositions WHERE source_file = ?').run(file);
    for (const r of rows) insDisp.run(...r);
  })();
  console.log(`disp ${file}: ${rows.length} rows`);
}

// ---------- verification ----------
console.log('\n=== historical_transactions: Order product_sales by year ===');
for (const r of db.prepare(`
  SELECT substr(txn_date,1,4) y, COUNT(*) n, SUM(product_sales)/100.0 sales
  FROM historical_transactions WHERE type='Order' GROUP BY y ORDER BY y`).all()) {
  console.log(`  ${r.y}: n=${r.n}  $${r.sales.toFixed(2)}`);
}
console.log('=== historical_cogs by year ===');
for (const r of db.prepare(`
  SELECT substr(date_posted,1,4) y, COUNT(*) n, SUM(buy_cost)/100.0 cogs
  FROM historical_cogs GROUP BY y ORDER BY y`).all()) {
  console.log(`  ${r.y}: n=${r.n}  $${r.cogs.toFixed(2)}`);
}
db.close();
