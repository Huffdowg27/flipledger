/**
 * InventoryLab Inventory Valuation CSV → live_inventory importer.
 *
 * Reads the Inventory Valuation CSV from imports/ and upserts live_inventory
 * with IL's On Hand + Inbound Qty per MSKU. ASIN is resolved from inventory_ledger.
 *
 * This corrects FL's live_inventory when Amazon's FBA Inventory API doesn't
 * return all MSKUs (stranded, in-transit, non-active states).
 */

import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const IMPORTS_DIR = path.join(process.cwd(), 'imports');

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

export async function POST() {
  if (!fs.existsSync(IMPORTS_DIR)) {
    return NextResponse.json({ error: `imports/ directory not found at ${IMPORTS_DIR}` }, { status: 404 });
  }

  // Find an inventory valuation CSV (case-insensitive match)
  const csvFiles = fs.readdirSync(IMPORTS_DIR).filter(f =>
    f.toLowerCase().endsWith('.csv') && f.toLowerCase().includes('inventory valuation')
  );
  if (csvFiles.length === 0) {
    return NextResponse.json({
      error: 'No Inventory Valuation CSV found in imports/. Expected filename containing "Inventory Valuation".'
    }, { status: 400 });
  }

  const filePath = path.join(IMPORTS_DIR, csvFiles[0]);
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, '');
  const lines = content.split('\n');
  if (lines.length < 2) {
    return NextResponse.json({ error: 'CSV is empty or has no data rows' }, { status: 400 });
  }

  const headers = parseCSVLine(lines[0]);
  const col = (name: string) => headers.findIndex(
    h => h.replace(/^"|"$/g, '').trim().toLowerCase() === name.toLowerCase()
  );

  const idxMSKU     = col('MSKU');
  const idxOnHand   = col('On Hand');
  const idxInbound  = col('Inbound Qty');

  if (idxMSKU === -1 || idxOnHand === -1) {
    return NextResponse.json({
      error: 'CSV missing required columns (MSKU, On Hand)'
    }, { status: 400 });
  }

  const idxCostPerUnit = col('Cost/Unit');

  interface Row { msku: string; onHand: number; inbound: number; costCents: number | null }
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    const msku = cols[idxMSKU]?.trim();
    if (!msku) continue;
    const onHand = Math.round(parseNum(cols[idxOnHand] || '0'));
    const inbound = idxInbound >= 0 ? Math.round(parseNum(cols[idxInbound] || '0')) : 0;
    const rawCost = idxCostPerUnit >= 0 ? cols[idxCostPerUnit]?.trim() : '';
    const costCents = rawCost ? Math.round(parseNum(rawCost) * 100) || null : null;
    rows.push({ msku, onHand, inbound, costCents });
  }

  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const now = new Date().toISOString();
  let updated = 0;
  let inserted = 0;
  let ledgerInserted = 0;
  let noAsin = 0;

  // ASIN resolution priority: inventory_ledger → order_items → live_inventory (any qty)
  const lookupAsinFromLedger = db.prepare(`SELECT asin FROM inventory_ledger WHERE sku = ? LIMIT 1`);
  const lookupAsinFromOrders = db.prepare(`SELECT asin FROM order_items WHERE sku = ? AND asin IS NOT NULL AND asin != '' LIMIT 1`);
  const lookupAsinFromLive   = db.prepare(`SELECT asin FROM live_inventory WHERE sku = ? AND marketplace = 'amazon' AND asin IS NOT NULL LIMIT 1`);
  const lookupLive = db.prepare(`SELECT id FROM live_inventory WHERE sku = ? AND marketplace = 'amazon' LIMIT 1`);

  const insertLedger = db.prepare(`
    INSERT OR IGNORE INTO inventory_ledger
      (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsert = db.prepare(`
    INSERT INTO live_inventory
      (asin, sku, marketplace, fulfillable_qty, inbound_qty, reserved_qty, unfulfillable_qty, last_updated)
    VALUES (?, ?, 'amazon', ?, ?, 0, 0, ?)
    ON CONFLICT(asin, sku, marketplace) DO UPDATE SET
      fulfillable_qty = excluded.fulfillable_qty,
      inbound_qty     = excluded.inbound_qty,
      last_updated    = excluded.last_updated
  `);

  const importAll = db.transaction(() => {
    for (const row of rows) {
      // Resolve ASIN from multiple sources
      let asin: string | null = null;
      const fromLedger = lookupAsinFromLedger.get(row.msku) as { asin: string } | undefined;
      if (fromLedger) {
        asin = fromLedger.asin;
      } else {
        const fromOrders = lookupAsinFromOrders.get(row.msku) as { asin: string } | undefined;
        if (fromOrders) {
          asin = fromOrders.asin;
          // Create inventory_ledger entry so future imports resolve via ledger
          if (asin && row.costCents) {
            const r = insertLedger.run(asin, row.msku, row.costCents,
              row.onHand + row.inbound, row.onHand + row.inbound,
              now.slice(0, 10), `il:${row.msku}`, now);
            if (r.changes > 0) ledgerInserted++;
          }
        } else {
          const fromLive = lookupAsinFromLive.get(row.msku) as { asin: string } | undefined;
          if (fromLive) asin = fromLive.asin;
        }
      }

      if (!asin) { noAsin++; continue; }

      const existingLive = lookupLive.get(row.msku) as { id: number } | undefined;
      const result = upsert.run(asin, row.msku, row.onHand, row.inbound, now);
      if (existingLive) {
        updated++;
      } else {
        if (result.changes > 0) inserted++;
      }
    }
  });

  try {
    importAll();
    db.close();
    return NextResponse.json({
      success: true,
      file: csvFiles[0],
      stats: {
        totalRows: rows.length,
        inserted,
        updated,
        ledgerEntriesCreated: ledgerInserted,
        noAsinFound: noAsin,
        note: noAsin > 0 ? `${noAsin} MSKUs have no ASIN in any FL data source — these are items purchased but never sold. They will appear after a full FBA inventory sync.` : undefined,
      },
    });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    description: 'InventoryLab Inventory Valuation CSV → live_inventory importer',
    usage: 'POST /api/sync/import-inventory-valuation — reads *Inventory Valuation*.csv from imports/',
    notes: [
      'Requires MSKU and On Hand columns',
      'ASIN resolved from inventory_ledger.sku',
      'MSKUs not found in inventory_ledger are skipped',
    ],
  });
}
