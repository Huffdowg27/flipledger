/**
 * Resolve ASINs for MSKUs in the IL Inventory Valuation CSV that don't appear
 * anywhere in FL's data (never sold, not in live_inventory).
 *
 * Calls the Listings Items API for each unresolved MSKU to get its ASIN, then
 * inserts the item into inventory_ledger (with IL cost) and live_inventory
 * (with IL on_hand + inbound quantities).
 *
 * This is a one-time discovery operation. After running it, regular FBA
 * inventory syncs will keep the quantities up to date.
 */

import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getListing, getSellerId } from '@/lib/sp-api/listingsItems';
import type { SPAPICredentials } from '@/lib/sp-api/types';

const IMPORTS_DIR = path.join(process.cwd(), 'imports');

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cols.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cols.push(current.trim());
  return cols;
}

function parseNum(s: string): number {
  return parseFloat(s.replace(/[,$]/g, '')) || 0;
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

export async function GET() {
  // Dry-run: return count of unresolvable MSKUs without making API calls
  const csvFiles = fs.existsSync(IMPORTS_DIR)
    ? fs.readdirSync(IMPORTS_DIR).filter(f =>
        f.toLowerCase().endsWith('.csv') && f.toLowerCase().includes('inventory valuation')
      )
    : [];
  if (csvFiles.length === 0) {
    return NextResponse.json({ unresolved: 0, message: 'No Inventory Valuation CSV found in imports/' });
  }

  const content = fs.readFileSync(path.join(IMPORTS_DIR, csvFiles[0]), 'utf-8').replace(/^﻿/, '');
  const lines = content.split('\n');
  const headers = parseCSVLine(lines[0]);
  const idxMSKU = headers.findIndex(h => h.replace(/^"|"$/g, '').trim().toLowerCase() === 'msku');

  const db = getDb();
  try {
    let unresolved = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = parseCSVLine(line);
      const msku = cols[idxMSKU]?.trim();
      if (!msku || msku.includes(',')) continue;

      const inLedger = db.prepare('SELECT 1 FROM inventory_ledger WHERE sku = ? LIMIT 1').get(msku);
      const inOrders = db.prepare('SELECT 1 FROM order_items WHERE sku = ? LIMIT 1').get(msku);
      const inLive   = db.prepare('SELECT 1 FROM live_inventory WHERE sku = ? AND marketplace = ? LIMIT 1').get(msku, 'amazon');
      if (!inLedger && !inOrders && !inLive) unresolved++;
    }
    return NextResponse.json({ unresolved, file: csvFiles[0] });
  } finally {
    db.close();
  }
}

export async function POST(request: Request) {
  // Optional: pass {"sellerId": "A1XXXXX..."} in the request body to override/seed the cached seller ID.
  let bodySellerIdOverride: string | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.sellerId && typeof body.sellerId === 'string') {
      bodySellerIdOverride = body.sellerId.trim();
    }
  } catch { /* ignore parse errors */ }

  const csvFiles = fs.existsSync(IMPORTS_DIR)
    ? fs.readdirSync(IMPORTS_DIR).filter(f =>
        f.toLowerCase().endsWith('.csv') && f.toLowerCase().includes('inventory valuation')
      )
    : [];
  if (csvFiles.length === 0) {
    return NextResponse.json({ error: 'No Inventory Valuation CSV found in imports/' }, { status: 400 });
  }

  // Load credentials
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;

  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) {
    db.close();
    return NextResponse.json({ error: 'Amazon credentials not configured in settings' }, { status: 400 });
  }

  const credentials: SPAPICredentials = {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    refreshToken: settings.refreshToken,
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };

  let sellerId: string;

  if (bodySellerIdOverride) {
    // Caller supplied the seller ID directly — cache it so future calls work without it
    sellerId = bodySellerIdOverride;
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('amazon_seller_id', ?)`).run(sellerId);
  } else {
    try {
      sellerId = await getSellerId(credentials);
    } catch (err) {
      db.close();
      return NextResponse.json({
        error: `Could not get seller ID: ${err}`,
        hint: 'Pass {"sellerId": "YOUR_MERCHANT_TOKEN"} in the POST body. Find your Merchant Token in Seller Central → Settings → Account Info → Business Information. It will be cached for future calls.',
      }, { status: 500 });
    }
  }

  // Parse IL Inventory Valuation CSV
  const content = fs.readFileSync(path.join(IMPORTS_DIR, csvFiles[0]), 'utf-8').replace(/^﻿/, '');
  const lines = content.split('\n');
  const headers = parseCSVLine(lines[0]);
  const col = (name: string) => headers.findIndex(h => h.replace(/^"|"$/g, '').trim().toLowerCase() === name.toLowerCase());

  const idxMSKU    = col('MSKU');
  const idxOnHand  = col('On Hand');
  const idxInbound = col('Inbound Qty');
  const idxCost    = col('Cost/Unit');

  interface ILRow { msku: string; onHand: number; inbound: number; costCents: number }
  const ilRows: ILRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    const msku = cols[idxMSKU]?.trim();
    if (!msku || msku.includes(',')) continue;
    const onHand  = Math.round(parseNum(cols[idxOnHand]  || '0'));
    const inbound = idxInbound >= 0 ? Math.round(parseNum(cols[idxInbound] || '0')) : 0;
    const costCents = Math.round(parseNum(cols[idxCost] || '0') * 100);
    ilRows.push({ msku, onHand, inbound, costCents });
  }

  // Find MSKUs with no ASIN in any FL source
  const unresolved: ILRow[] = [];
  for (const row of ilRows) {
    const inLedger = db.prepare('SELECT 1 FROM inventory_ledger WHERE sku = ? LIMIT 1').get(row.msku);
    const inOrders = db.prepare('SELECT 1 FROM order_items WHERE sku = ? LIMIT 1').get(row.msku);
    const inLive   = db.prepare('SELECT 1 FROM live_inventory WHERE sku = ? AND marketplace = ? LIMIT 1').get(row.msku, 'amazon');
    if (!inLedger && !inOrders && !inLive) unresolved.push(row);
  }

  const insertLedger = db.prepare(`
    INSERT OR IGNORE INTO inventory_ledger
      (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertLive = db.prepare(`
    INSERT INTO live_inventory
      (asin, sku, marketplace, fulfillable_qty, inbound_qty, reserved_qty, unfulfillable_qty, last_updated)
    VALUES (?, ?, 'amazon', ?, ?, 0, 0, ?)
    ON CONFLICT(asin, sku, marketplace) DO UPDATE SET
      fulfillable_qty = excluded.fulfillable_qty,
      inbound_qty     = excluded.inbound_qty,
      last_updated    = excluded.last_updated
  `);

  const now = new Date().toISOString();
  let resolved = 0;
  let notFound = 0;
  let errors = 0;
  const errorList: string[] = [];

  for (const row of unresolved) {
    try {
      const listing = await getListing(credentials, sellerId, row.msku);
      const asin = listing?.summaries?.[0]?.asin;

      if (!asin) {
        notFound++;
      } else {
        const qty = row.onHand + row.inbound;
        if (row.costCents > 0) {
          insertLedger.run(asin, row.msku, row.costCents, qty, qty, now.slice(0, 10), `il:${row.msku}`, now);
        }
        upsertLive.run(asin, row.msku, row.onHand, row.inbound, now);
        resolved++;
      }
    } catch (err) {
      errors++;
      errorList.push(`${row.msku}: ${err}`);
    }

    // Respect Listings Items API rate limit (~5 req/s, be conservative)
    await sleep(300);
  }

  db.close();

  return NextResponse.json({
    success: true,
    file: csvFiles[0],
    stats: {
      totalUnresolved: unresolved.length,
      resolved,
      notFoundInAmazon: notFound,
      errors,
    },
    errorSample: errorList.slice(0, 5),
  });
}
