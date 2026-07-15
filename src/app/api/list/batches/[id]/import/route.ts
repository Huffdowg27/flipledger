// POST /api/list/batches/[id]/import
//
// Bulk "Add Buy List to Batch" — the commit step of the CSV import wizard.
// Re-parses the CSV server-side (client preview is never trusted), validates,
// then writes every row in ONE sqlite transaction (all-or-nothing).
//
// Channel-aware, mirroring how each batch type stores items elsewhere:
//   - MFN batches → one inventory_ledger lot per row, tagged batch_id. These
//     surface in MfnBatchReceiveWorkflow. (Same shape as import-inventorylab.)
//   - FBA batches → one inventory_ledger lot per row (no batch_id) PLUS a
//     listing_batch_items row linked via inventory_ledger_id. (Same shape as
//     the per-item items/route.ts.)
//
// Buy-list semantics: every row is a NEW purchase, so we ALWAYS insert a fresh
// lot (accurate multi-lot FIFO COGS). The per-row replenish/create-new choice
// only sets listing_mode (whether a new Amazon MSKU/listing is created vs an
// existing one reused at send time) — it never suppresses lot creation. This
// intentionally differs from items/route.ts REPLENISH_EXISTING, which links to
// a prior lot because that flow is not recording a purchase.
//
// Body (JSON): { csv, mapping?, decisions?: { [rowIndex]: { mode?, skip? } } }
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { createHash } from 'node:crypto';
import { parseBuyListCsv, type ColumnMapping } from '@/lib/imports/airtable-buylist';
import { recalculateFIFO } from '@/lib/fifo';
import { backfillBatchImages } from '@/lib/sp-api/catalog';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getAmazonCredentials(): SPAPICredentials | null {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;
    if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;
    return {
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      refreshToken: settings.refreshToken,
      marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
    };
  } finally {
    db.close();
  }
}

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

const ALLOWED_MODES = new Set(['CREATE_NEW', 'REPLENISH_EXISTING']);

// inventory_ledger.condition stores a human label (matches import-inventorylab);
// listing_batch_items.condition stores the code (matches items/route.ts).
function codeToLedgerLabel(code: string): string {
  switch (code) {
    case 'UsedLikeNew': return 'Used - Like New';
    case 'UsedVeryGood': return 'Used - Very Good';
    case 'UsedGood': return 'Used - Good';
    case 'UsedAcceptable': return 'Used - Acceptable';
    default: return 'New';
  }
}

interface Decision { mode?: string; skip?: boolean }

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  let body: { csv?: string; mapping?: Partial<ColumnMapping>; decisions?: Record<string, Decision> };
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json({ error: `Could not read request body: ${err}` }, { status: 400 });
  }

  const csvText = typeof body?.csv === 'string' ? body.csv : '';
  if (!csvText.trim()) {
    return NextResponse.json({ error: 'CSV body is empty' }, { status: 400 });
  }
  const decisions = body?.decisions ?? {};

  const parsed = parseBuyListCsv(csvText, body?.mapping);
  if (parsed.globalErrors.length > 0) {
    return NextResponse.json(
      { error: 'CSV has structural problems', globalErrors: parsed.globalErrors },
      { status: 400 },
    );
  }

  // Drop skipped rows, keep the rest.
  const rows = parsed.rows.filter(r => !decisions[String(r.rowIndex)]?.skip);
  if (rows.length === 0) {
    return NextResponse.json({ error: 'No rows selected to import' }, { status: 400 });
  }

  // Row-level validation failures → 400, no writes.
  const rowErrors = rows
    .filter(r => r.errors.length > 0)
    .map(r => ({ rowIndex: r.rowIndex, msku: r.msku, errors: r.errors }));
  if (rowErrors.length > 0) {
    return NextResponse.json(
      { error: `${rowErrors.length} row(s) have validation errors`, rowErrors },
      { status: 400 },
    );
  }

  // Within-import duplicate MSKU check (server-side).
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.msku)) dupes.add(r.msku);
    else seen.add(r.msku);
  }
  if (dupes.size > 0) {
    return NextResponse.json(
      { error: 'CSV contains duplicate MSKUs', duplicateSkus: Array.from(dupes) },
      { status: 400 },
    );
  }

  // Validate any provided modes.
  for (const r of rows) {
    const mode = decisions[String(r.rowIndex)]?.mode;
    if (mode && !ALLOWED_MODES.has(mode)) {
      return NextResponse.json({ error: `Invalid mode for row ${r.rowIndex}: ${mode}` }, { status: 400 });
    }
  }

  const normalizedRows = rows
    .map(row => ({
      asin: row.asin,
      msku: row.msku,
      productName: row.productName,
      quantity: row.quantity,
      costCents: row.costCents,
      listPriceCents: row.listPriceCents,
      supplier: row.supplier,
      purchaseDate: row.purchaseDate,
      condition: row.condition,
      shippingTemplate: row.shippingTemplate,
      mode: decisions[String(row.rowIndex)]?.mode || 'CREATE_NEW',
    }))
    .sort((a, b) => a.msku.localeCompare(b.msku));
  const rowsImported = rows.length;
  const totalUnits = rows.reduce((sum, row) => sum + row.quantity, 0);
  const totalCostCents = rows.reduce((sum, row) => sum + row.costCents * row.quantity, 0);
  const totalListValueCents = rows.reduce((sum, row) => sum + row.listPriceCents * row.quantity, 0);

  const db = getDb();
  try {
    const batch = db.prepare('SELECT id, channel, status FROM listing_batches WHERE id = ?')
      .get(batchId) as { id: number; channel: string; status: string } | undefined;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    const isMfn = batch.channel === 'MFN';
    const contentHash = createHash('sha256')
      .update(JSON.stringify(normalizedRows.map(row => (
        isMfn ? { ...row, mode: undefined } : row
      ))))
      .digest('hex');

    // A completed request remains replayable even if the batch transitioned
    // after the client lost the original response.
    const completedImport = db.prepare(`
      SELECT response_json
      FROM listing_batch_imports
      WHERE batch_id = ? AND content_hash = ?
    `).get(batchId, contentHash) as { response_json: string } | undefined;
    if (completedImport) {
      return NextResponse.json({
        ...JSON.parse(completedImport.response_json),
        replayed: true,
      });
    }
    if (batch.status !== 'draft') {
      return NextResponse.json({ error: `Cannot import into batch in status: ${batch.status}` }, { status: 400 });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);

    const upsertSupplier = db.prepare('INSERT OR IGNORE INTO suppliers (name, created_at) VALUES (?, ?)');
    const selectSupplier = db.prepare('SELECT id FROM suppliers WHERE name = ?');

    const insertLotMfn = db.prepare(`
      INSERT INTO inventory_ledger (
        asin, sku, buy_price, quantity, quantity_remaining,
        supplier_id, date_purchased, bin_location, condition, list_price_cents,
        merchant_shipping_group_name, received_at, inspected_at, quantity_received,
        batch_id, listing_batch_import_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
    `);
    const insertLotFba = db.prepare(`
      INSERT INTO inventory_ledger (
        asin, sku, buy_price, quantity, quantity_remaining,
        supplier_id, date_purchased, condition, list_price_cents,
        listing_batch_import_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBatchItem = db.prepare(`
      INSERT INTO listing_batch_items (
        batch_id, asin, sku, msku, product_name, image_url, condition,
        quantity, list_price_cents, buy_price_cents, supplier, purchase_date,
        estimated_fee_cents, estimated_ship_cents, listing_mode, fnsku,
        fulfillment_channel, listing_source, amazon_inventory_status,
        inventory_ledger_id, listing_batch_import_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, 'CSV_IMPORT', NULL, ?, ?, ?)
    `);

    const selectProduct = db.prepare('SELECT id FROM products WHERE asin = ? LIMIT 1');
    const updateProduct = db.prepare(`
      UPDATE products SET name = COALESCE(NULLIF(?, ''), name), sku = COALESCE(NULLIF(?, ''), sku), updated_at = ? WHERE id = ?
    `);
    const insertProduct = db.prepare(`
      INSERT INTO products (asin, sku, name, marketplace, created_at, updated_at) VALUES (?, ?, ?, 'amazon', ?, ?)
    `);

    const response = {
      success: true,
      batchId,
      channel: batch.channel,
      rowsImported,
      totalUnits,
      totalCostCents,
      totalListValueCents,
      replayed: false,
    };

    const tx = db.transaction(() => {
      const prior = db.prepare(`
        SELECT response_json
        FROM listing_batch_imports
        WHERE batch_id = ? AND content_hash = ?
      `).get(batchId, contentHash) as { response_json: string } | undefined;
      if (prior) {
        return {
          response: { ...JSON.parse(prior.response_json), replayed: true },
          affectedSkus: [] as string[],
          replayed: true,
        };
      }

      const importResult = db.prepare(`
        INSERT INTO listing_batch_imports (
          batch_id, content_hash, rows_imported, total_units, total_cost_cents,
          total_list_value_cents, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        contentHash,
        rowsImported,
        totalUnits,
        totalCostCents,
        totalListValueCents,
        JSON.stringify(response),
        nowIso,
      );
      const listingBatchImportId = Number(importResult.lastInsertRowid);
      const supplierIdByName = new Map<string, number>();
      const affectedSkus = new Set<string>();

      for (const row of rows) {
        // ── Supplier ──────────────────────────────────────────────────────
        let supplierId: number | null = null;
        const supplierName = row.supplier?.trim() || '';
        if (supplierName) {
          const cached = supplierIdByName.get(supplierName);
          if (cached != null) supplierId = cached;
          else {
            upsertSupplier.run(supplierName, nowIso);
            const sRow = selectSupplier.get(supplierName) as { id?: number } | undefined;
            supplierId = sRow?.id ?? null;
            if (supplierId != null) supplierIdByName.set(supplierName, supplierId);
          }
        }

        const datePurchased = row.purchaseDate || today;

        // ── inventory_ledger lot (always created — buy-list = new purchase) ─
        let lotId: number;
        if (isMfn) {
          const res = insertLotMfn.run(
            row.asin, row.msku, row.costCents, row.quantity, row.quantity,
            supplierId, datePurchased, codeToLedgerLabel(row.condition), row.listPriceCents,
            row.shippingTemplate || null, batchId, listingBatchImportId, nowIso,
          );
          lotId = Number(res.lastInsertRowid);
        } else {
          const res = insertLotFba.run(
            row.asin, row.msku, row.costCents, row.quantity, row.quantity,
            supplierId, datePurchased, codeToLedgerLabel(row.condition), row.listPriceCents,
            listingBatchImportId, nowIso,
          );
          lotId = Number(res.lastInsertRowid);

          // FBA batches track items via listing_batch_items; MFN does not.
          const mode = decisions[String(row.rowIndex)]?.mode || 'CREATE_NEW';
          insertBatchItem.run(
            batchId, row.asin, row.msku, row.msku, row.productName || null, null,
            row.condition, row.quantity, row.listPriceCents, row.costCents,
            row.supplier || null, datePurchased, 0, mode, 'FBA', lotId,
            listingBatchImportId, nowIso,
          );
        }
        affectedSkus.add(row.msku);

        // ── Product cache (inside tx; cheap, keyed by asin, no UNIQUE) ──────
        const existing = selectProduct.get(row.asin) as { id?: number } | undefined;
        if (existing?.id) updateProduct.run(row.productName || '', row.msku || '', nowIso, existing.id);
        else insertProduct.run(row.asin, row.msku || null, row.productName || null, nowIso, nowIso);

      }

      db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(nowIso, batchId);
      return {
        response,
        affectedSkus: [...affectedSkus],
        replayed: false,
      };
    });

    const outcome = tx.immediate();
    db.close();

    if (outcome.replayed) {
      return NextResponse.json(outcome.response);
    }

    // FIFO recalculation per affected SKU (lots changed).
    for (const sku of outcome.affectedSkus) {
      try { recalculateFIFO({ sku }); } catch (e) { console.warn('[buylist import] FIFO recalc skipped for', sku, e); }
    }

    // Auto-fetch product photos for the imported ASINs (MFN lots are tagged
    // with batch_id, so this is a no-op for FBA). SP-API self-throttles catalog
    // calls to ~1.8/sec, so a typical 15-20 item import adds ~10s. Best-effort:
    // never fail the import over a missing image.
    if (isMfn) {
      const creds = getAmazonCredentials();
      if (creds) {
        try { await backfillBatchImages(creds, batchId, rowsImported || 100); }
        catch (e) { console.warn('[buylist import] image backfill skipped', e); }
      }
    }

    return NextResponse.json(outcome.response);
  } catch (err) {
    try { db.close(); } catch { /* already closed */ }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
