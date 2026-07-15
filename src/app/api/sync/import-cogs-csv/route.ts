/**
 * InventoryLab FBA Sales / MFN Sales CSV → inventory_ledger importer.
 *
 * Reads every .csv in the imports/ directory, detects InventoryLab format
 * by checking for required columns, then groups rows by MSKU so each unique
 * purchase lot becomes one inventory_ledger row.
 *
 * Date priority:
 *   1. Decode MMDDYY from structured MSKU (e.g. ZTPC_01WOOT_020426_6.35_...)
 *   2. Earliest "Order Placed" date seen for that MSKU
 *   Never falls back to today — uses 2020-01-01 only if both above fail.
 *
 * Dedup: notes field stores "il:<msku>" — re-running skips existing lots.
 */

import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { recalculateFIFO } from '@/lib/fifo';
import { isAmazonGradedSku } from '@/lib/sku-cogs';

const IMPORTS_DIR = path.join(process.cwd(), 'imports');
const FALLBACK_DATE = '2020-01-01';

// Parse Buy Cost: "(6.35)" → 635 cents, "6.35" → 635, "" → null
function parseBuyCost(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[()]/g, '').trim();
  const val = parseFloat(cleaned);
  if (isNaN(val) || val === 0) return null;
  return Math.round(Math.abs(val) * 100);
}

// Parse "M/D/YYYY H:MM:SS AM/PM" → "YYYY-MM-DD"
function parseOrderPlacedDate(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().substring(0, 10);
}

// Try to decode MMDDYY from a structured InventoryLab MSKU.
// Scans underscore-separated segments for a 6-digit number that's a valid date.
function decodeMskuDate(msku: string): string | null {
  const segments = msku.split('_');
  for (const seg of segments) {
    if (!/^\d{6}$/.test(seg)) continue;
    const mm = parseInt(seg.substring(0, 2));
    const dd = parseInt(seg.substring(2, 4));
    const yy = parseInt(seg.substring(4, 6));
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
    const year = yy + (yy >= 90 ? 1900 : 2000); // 90-99 → 1990s, else 2000s
    const dateStr = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const check = new Date(dateStr);
    if (isNaN(check.getTime())) continue;
    return dateStr;
  }
  return null;
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

interface LotAccumulator {
  asin: string;
  msku: string;
  buyCostCents: number;
  mskuDate: string | null;       // decoded from MSKU structure
  earliestOrderDate: string | null; // earliest Order Placed seen
  totalQty: number;
}

function processFile(
  content: string,
  lots: Map<string, LotAccumulator>,
  stats: { rows: number; skippedNoCost: number; skippedBadRow: number; skippedGraded: number }
) {
  const lines = content.split('\n');
  if (lines.length < 2) return;

  const headers = parseCSVLine(lines[0]);
  const col = (name: string) => headers.findIndex(
    h => h.replace(/^"|"$/g, '').trim().toLowerCase() === name.toLowerCase()
  );

  const idxOrderPlaced = col('Order Placed');
  const idxASIN       = col('ASIN');
  const idxMSKU       = col('MSKU');
  const idxQty        = col('Quantity Shipped');
  const idxBuyCost    = col('Buy Cost');

  // Not an InventoryLab Sales CSV if missing required columns
  if (idxASIN === -1 || idxMSKU === -1 || idxBuyCost === -1) return;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    if (cols.length < 5) { stats.skippedBadRow++; continue; }

    const asin     = cols[idxASIN]?.trim();
    const msku     = cols[idxMSKU]?.trim();
    const rawCost  = cols[idxBuyCost]?.trim();
    const rawDate  = idxOrderPlaced >= 0 ? cols[idxOrderPlaced]?.trim() : '';
    const qty      = parseInt(cols[idxQty]?.trim() || '1') || 1;

    if (!asin || !msku) { stats.skippedBadRow++; continue; }
    if (isAmazonGradedSku(msku)) { stats.skippedGraded++; continue; }

    const buyCostTotal = parseBuyCost(rawCost);
    if (buyCostTotal === null) { stats.skippedNoCost++; continue; }

    // IL's "Buy Cost" column is the total cost for the row (qty × unit price).
    // Divide by qty to get the per-unit cost stored in inventory_ledger.buy_price.
    const buyCostPerUnit = Math.round(buyCostTotal / qty);
    if (buyCostPerUnit === 0) { stats.skippedNoCost++; continue; }

    stats.rows++;

    const orderDate = parseOrderPlacedDate(rawDate);
    const key = msku; // one lot per unique MSKU

    const existing = lots.get(key);
    if (existing) {
      existing.totalQty += qty;
      // Keep the earliest order date
      if (orderDate && (!existing.earliestOrderDate || orderDate < existing.earliestOrderDate)) {
        existing.earliestOrderDate = orderDate;
      }
    } else {
      lots.set(key, {
        asin,
        msku,
        buyCostCents: buyCostPerUnit,
        mskuDate: decodeMskuDate(msku),
        earliestOrderDate: orderDate,
        totalQty: qty,
      });
    }
  }
}

export async function POST() {
  if (!fs.existsSync(IMPORTS_DIR)) {
    return NextResponse.json({ error: `imports/ directory not found at ${IMPORTS_DIR}` }, { status: 404 });
  }

  const csvFiles = fs.readdirSync(IMPORTS_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  if (csvFiles.length === 0) {
    return NextResponse.json({ error: 'No CSV files found in imports/' }, { status: 400 });
  }

  const lots = new Map<string, LotAccumulator>();
  const fileStats: {
    file: string;
    rows: number;
    skippedNoCost: number;
    skippedBadRow: number;
    skippedGraded: number;
  }[] = [];

  for (const file of csvFiles) {
    const filePath = path.join(IMPORTS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, '');
    const stats = { rows: 0, skippedNoCost: 0, skippedBadRow: 0, skippedGraded: 0 };
    processFile(content, lots, stats);
    fileStats.push({ file, ...stats });
  }

  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');

  const now = new Date().toISOString();
  let inserted = 0;
  let skippedDuplicate = 0;
  let usedFallbackDate = 0;
  let usedMskuDate = 0;
  let usedOrderDate = 0;

  const insertLot = db.prepare(`
    INSERT OR IGNORE INTO inventory_ledger
      (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const checkDup = db.prepare(`
    SELECT id FROM inventory_ledger WHERE notes = ? LIMIT 1
  `);

  const importAll = db.transaction(() => {
    for (const [, lot] of lots) {
      const dedupNote = `il:${lot.msku}`;

      // Skip if already imported
      if (checkDup.get(dedupNote)) { skippedDuplicate++; continue; }

      // Date priority: MSKU-decoded → earliest order date → 2020-01-01
      let datePurchased: string;
      if (lot.mskuDate) {
        datePurchased = lot.mskuDate;
        usedMskuDate++;
      } else if (lot.earliestOrderDate) {
        datePurchased = lot.earliestOrderDate;
        usedOrderDate++;
      } else {
        datePurchased = FALLBACK_DATE;
        usedFallbackDate++;
      }

      const result = insertLot.run(
        lot.asin,
        lot.msku,
        lot.buyCostCents,
        lot.totalQty,
        lot.totalQty, // quantity_remaining = quantity; FIFO recalc will deplete
        datePurchased,
        dedupNote,
        now
      );

      if (result.changes > 0) inserted++;
    }
  });

  try {
    importAll();

    // Recalculate FIFO for all affected ASINs
    const fifoResult = recalculateFIFO({ recalcAll: true });

    db.close();

    return NextResponse.json({
      success: true,
      files: fileStats,
      lots: {
        uniqueLots: lots.size,
        inserted,
        skippedDuplicate,
      },
      dateSource: {
        fromMsku: usedMskuDate,
        fromOrderPlaced: usedOrderDate,
        fallback2020: usedFallbackDate,
      },
      fifo: {
        itemsUpdated: fifoResult.itemsUpdated,
        skusProcessed: fifoResult.skusProcessed,
      },
    });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    description: 'InventoryLab FBA/MFN Sales CSV → inventory_ledger importer',
    usage: 'POST /api/sync/import-cogs-csv — reads all .csv files from imports/',
    notes: [
      'Groups by MSKU — one lot per unique MSKU',
      'Date: decoded from MSKU structure first, then Order Placed, never today',
      'Dedup: notes field stores il:<msku> — safe to re-run',
    ],
  });
}
