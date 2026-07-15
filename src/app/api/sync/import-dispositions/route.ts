/**
 * InventoryLab "Disposition Management" CSV → dispositions table importer.
 *
 * Reads every .csv in the imports/ directory, detects the Disposition
 * Management format by its column set, then upserts one row per
 * (ID, MSKU, Type) into the dispositions table.
 *
 * Buy Cost Adj semantics (signed cents), decoded from IL's export:
 *   + value  → MFN Return sellable: unit restocked → reverses COGS
 *   - value  → Removal/Liquidate/Disposal unsellable: inventory write-off (loss)
 *     0      → no inventory value change (sellable removal, unsellable MFN
 *              return, or amzn.gr.* items IL has no buy cost for)
 *
 * Idempotent: re-importing the same export updates the matching row in place
 * (UNIQUE(ref_id, msku, type)) rather than inserting duplicates.
 */

import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const IMPORTS_DIR = path.join(process.cwd(), 'imports');

// "(12.79)" → -1279, "20.45" → 2045, "0.00"/"" → 0
function parseSignedCents(s: string): number {
  if (!s) return 0;
  const raw = s.trim();
  if (!raw) return 0;
  const neg = raw.startsWith('(') || raw.startsWith('-');
  const cleaned = raw.replace(/[(),$]/g, '').replace(/-/g, '').trim();
  const val = parseFloat(cleaned);
  if (isNaN(val)) return 0;
  const cents = Math.round(val * 100);
  return neg ? -cents : cents;
}

// "6/17/2026 5:28:44 PM" → "2026-06-17". Parse the leading M/D/YYYY token
// directly (no Date()) so timezone never shifts the calendar day.
function parseDispDate(s: string): string | null {
  if (!s) return null;
  const token = s.trim().split(/\s+/)[0]; // "6/17/2026"
  const m = token.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

// Full timestamp → ISO, for the optional "Edited" column. Best-effort.
function parseEditedAt(s: string): string | null {
  if (!s || !s.trim()) return null;
  const d = new Date(s.trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cols.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cols.push(current);
  return cols;
}

interface DispRow {
  disp_date: string;
  type: string;
  ref_id: string;
  title: string;
  msku: string;
  asin: string;
  az_disposition: string;
  sellable_qty: number;
  unsellable_qty: number;
  buy_cost_adj: number;
  edited_at: string | null;
  source_file: string;
}

function processFile(
  content: string,
  file: string,
  rows: DispRow[],
  stats: { rows: number; skippedBadRow: number; skippedBadDate: number }
): boolean {
  const lines = content.split('\n');
  if (lines.length < 2) return false;

  const headers = parseCSVLine(lines[0]);
  const col = (name: string) =>
    headers.findIndex(h => h.replace(/^"|"$/g, '').trim().toLowerCase() === name.toLowerCase());

  const idxDate    = col('Date');
  const idxType    = col('Type');
  const idxId      = col('ID');
  const idxTitle   = col('Title');
  const idxMsku    = col('MSKU');
  const idxAsin    = col('ASIN');
  const idxAz      = col('AZ Disposition?');
  const idxSell    = col('SellableQty');
  const idxUnsell  = col('UnsellableQty');
  const idxEdited  = col('Edited');
  const idxBuyAdj  = col('Buy Cost Adj');

  // Not a Disposition Management CSV unless the defining columns are present.
  if (idxType === -1 || idxBuyAdj === -1 || idxSell === -1 || idxUnsell === -1) return false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const c = parseCSVLine(line);
    if (c.length <= idxBuyAdj) { stats.skippedBadRow++; continue; }

    const at = (idx: number) => (idx >= 0 ? (c[idx] ?? '').trim() : '');

    const disp_date = parseDispDate(at(idxDate));
    if (!disp_date) { stats.skippedBadDate++; continue; }

    const type = at(idxType);
    if (!type) { stats.skippedBadRow++; continue; }

    rows.push({
      disp_date,
      type,
      ref_id: at(idxId),
      title: at(idxTitle),
      msku: at(idxMsku),
      asin: at(idxAsin),
      az_disposition: at(idxAz),
      sellable_qty: parseInt(at(idxSell) || '0') || 0,
      unsellable_qty: parseInt(at(idxUnsell) || '0') || 0,
      buy_cost_adj: parseSignedCents(at(idxBuyAdj)),
      edited_at: parseEditedAt(at(idxEdited)),
      source_file: file,
    });
    stats.rows++;
  }
  return true;
}

export async function POST() {
  if (!fs.existsSync(IMPORTS_DIR)) {
    return NextResponse.json({ error: `imports/ directory not found at ${IMPORTS_DIR}` }, { status: 404 });
  }

  const csvFiles = fs.readdirSync(IMPORTS_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  if (csvFiles.length === 0) {
    return NextResponse.json({ error: 'No CSV files found in imports/' }, { status: 400 });
  }

  const rows: DispRow[] = [];
  const fileStats: { file: string; matched: boolean; rows: number; skippedBadRow: number; skippedBadDate: number }[] = [];

  for (const file of csvFiles) {
    const content = fs.readFileSync(path.join(IMPORTS_DIR, file), 'utf-8').replace(/^﻿/, '');
    const stats = { rows: 0, skippedBadRow: 0, skippedBadDate: 0 };
    const matched = processFile(content, file, rows, stats);
    fileStats.push({ file, matched, ...stats });
  }

  if (rows.length === 0) {
    return NextResponse.json(
      { error: 'No Disposition Management rows found. Expected columns: Type, SellableQty, UnsellableQty, Buy Cost Adj.', fileStats },
      { status: 400 }
    );
  }

  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'));
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');

  // Ensure the table exists even if initializeDatabase() hasn't run in this process.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispositions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      disp_date TEXT NOT NULL, type TEXT NOT NULL, ref_id TEXT, title TEXT,
      msku TEXT, asin TEXT, az_disposition TEXT,
      sellable_qty INTEGER NOT NULL DEFAULT 0, unsellable_qty INTEGER NOT NULL DEFAULT 0,
      buy_cost_adj INTEGER NOT NULL DEFAULT 0, edited_at TEXT, source_file TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(ref_id, msku, type)
    );
    CREATE INDEX IF NOT EXISTS idx_dispositions_date ON dispositions(disp_date);
    CREATE INDEX IF NOT EXISTS idx_dispositions_msku ON dispositions(msku);
  `);

  const upsert = db.prepare(`
    INSERT INTO dispositions
      (disp_date, type, ref_id, title, msku, asin, az_disposition,
       sellable_qty, unsellable_qty, buy_cost_adj, edited_at, source_file)
    VALUES
      (@disp_date, @type, @ref_id, @title, @msku, @asin, @az_disposition,
       @sellable_qty, @unsellable_qty, @buy_cost_adj, @edited_at, @source_file)
    ON CONFLICT(ref_id, msku, type) DO UPDATE SET
      disp_date      = excluded.disp_date,
      title          = excluded.title,
      asin           = excluded.asin,
      az_disposition = excluded.az_disposition,
      sellable_qty   = excluded.sellable_qty,
      unsellable_qty = excluded.unsellable_qty,
      buy_cost_adj   = excluded.buy_cost_adj,
      edited_at      = excluded.edited_at,
      source_file    = excluded.source_file
  `);

  let before = (db.prepare('SELECT COUNT(*) n FROM dispositions').get() as { n: number }).n;
  const run = db.transaction((items: DispRow[]) => {
    for (const r of items) upsert.run(r);
  });
  run(rows);
  const after = (db.prepare('SELECT COUNT(*) n FROM dispositions').get() as { n: number }).n;

  // Summary by sign — the two P&L levers.
  const restocks = (db.prepare(`SELECT COALESCE(SUM(buy_cost_adj),0) c FROM dispositions WHERE buy_cost_adj > 0`).get() as { c: number }).c;
  const writeoffs = (db.prepare(`SELECT COALESCE(SUM(buy_cost_adj),0) c FROM dispositions WHERE buy_cost_adj < 0`).get() as { c: number }).c;

  db.close();

  return NextResponse.json({
    ok: true,
    parsed: rows.length,
    inserted: after - before,
    updated: rows.length - (after - before),
    totalRows: after,
    restockCogsReversalCents: restocks,   // positive: reverses COGS
    writeoffCents: writeoffs,             // negative: inventory write-off
    fileStats,
  });
}
