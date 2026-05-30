// POST /api/list/batches/[id]/import/preview
//
// Parse-only preview for a buy-list CSV import into a batch. No writes, no
// SP-API calls. Re-parses the CSV server-side (the client preview is never the
// source of truth) and annotates each row with whether its MSKU/ASIN already
// exists in local inventory or Seller-Central listings, so the resolve step can
// offer "replenish existing MSKU" vs "create new MSKU" per row.
//
// Body (JSON): { csv: string, mapping?: Partial<ColumnMapping> }
// Returns: { headers, columnMapping, totals, globalErrors, rows: [...with exists flags] }
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { parseBuyListCsv, type ColumnMapping } from '@/lib/imports/airtable-buylist';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  let body: { csv?: string; mapping?: Partial<ColumnMapping> };
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json({ error: `Could not read request body: ${err}` }, { status: 400 });
  }

  const csvText = typeof body?.csv === 'string' ? body.csv : '';
  if (!csvText.trim()) {
    return NextResponse.json({ error: 'CSV body is empty' }, { status: 400 });
  }

  const parsed = parseBuyListCsv(csvText, body?.mapping);

  const db = getDb();
  try {
    const batch = db.prepare('SELECT id, name, channel, status FROM listing_batches WHERE id = ?')
      .get(batchId) as { id: number; name: string; channel: string; status: string } | undefined;
    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }

    // Build the set of SKUs/ASINs present in the CSV, then look each up once.
    const skus = Array.from(new Set(parsed.rows.map(r => r.msku).filter(Boolean)));
    const asins = Array.from(new Set(parsed.rows.map(r => r.asin).filter(Boolean)));

    const existingSkus = new Set<string>();
    const existingAsins = new Set<string>();

    if (skus.length > 0) {
      const ph = skus.map(() => '?').join(',');
      for (const row of db.prepare(
        `SELECT DISTINCT sku FROM merchant_listings WHERE sku IN (${ph}) AND sku IS NOT NULL`
      ).all(...skus) as Array<{ sku: string }>) existingSkus.add(row.sku);
      for (const row of db.prepare(
        `SELECT DISTINCT sku FROM inventory_ledger WHERE sku IN (${ph}) AND sku IS NOT NULL`
      ).all(...skus) as Array<{ sku: string }>) existingSkus.add(row.sku);
    }

    if (asins.length > 0) {
      const ph = asins.map(() => '?').join(',');
      for (const row of db.prepare(
        `SELECT DISTINCT asin FROM merchant_listings WHERE asin IN (${ph})`
      ).all(...asins) as Array<{ asin: string }>) existingAsins.add(row.asin);
      for (const row of db.prepare(
        `SELECT DISTINCT asin FROM inventory_ledger WHERE asin IN (${ph})`
      ).all(...asins) as Array<{ asin: string }>) existingAsins.add(row.asin);
    }

    // Within-CSV duplicate MSKU detection (surfaced as a per-row warning so the
    // operator can fix the export; the commit endpoint hard-rejects dupes).
    const skuCounts = new Map<string, number>();
    for (const r of parsed.rows) {
      if (r.msku) skuCounts.set(r.msku, (skuCounts.get(r.msku) ?? 0) + 1);
    }

    const rows = parsed.rows.map(r => {
      const existsBySku = !!r.msku && existingSkus.has(r.msku);
      const existsByAsin = !!r.asin && existingAsins.has(r.asin);
      const duplicateInCsv = !!r.msku && (skuCounts.get(r.msku) ?? 0) > 1;
      return {
        ...r,
        existsBySku,
        existsByAsin,
        duplicateInCsv,
        // Default action: replenish a known MSKU, otherwise create a new one.
        suggestedMode: existsBySku ? 'REPLENISH_EXISTING' : 'CREATE_NEW',
      };
    });

    return NextResponse.json({
      batch: { id: batch.id, name: batch.name, channel: batch.channel, status: batch.status },
      headers: parsed.headers,
      columnMapping: parsed.columnMapping,
      totals: parsed.totals,
      globalErrors: parsed.globalErrors,
      rows,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
