// POST /api/mfn/import-inventorylab
//
// Server-side confirm-import for an InventoryLab FBM buy-list CSV. Run 2:
// safe DB writes only — no SP-API calls, no listing activation, no
// received/inspected stamps. Everything happens inside ONE sqlite
// transaction; the only way a partial state lands is a process crash mid-
// transaction (better-sqlite3 + WAL rolls that back on next open).
//
// Re-parses CSV server-side via the shared parser. Client-side preview is
// never trusted as source of truth.
//
// Flow:
//   1. Re-parse CSV with parseFbmCsv()
//   2. Reject if any row has validation errors
//   3. Reject if any SKU repeats within the import
//   4. Reject if any SKU already exists in inventory_ledger with
//      quantity_remaining > 0 OR batch_id IS NOT NULL
//   5. Inside a single transaction:
//        - Insert listing_batches row (channel=MFN, status=draft)
//        - Upsert suppliers (UNIQUE on name)
//        - Upsert products (manual select-then-insert/update; no UNIQUE on asin)
//        - Insert one inventory_ledger lot per row
//   6. Return { success, batchId, rowsImported, totalUnits, totalCostCents,
//      totalListValueCents }
//
// Critical: no INSERT OR IGNORE without a matching UNIQUE index. No floats.
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { parseFbmCsv } from '@/lib/imports/inventorylab-fbm';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function formatBatchName(now: Date): string {
  // Local-time, human-readable. Example: "InventoryLab FBM Import · May 25, 2026 3:42 PM"
  const date = now.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return `InventoryLab FBM Import · ${date}`;
}

export async function POST(request: NextRequest) {
  let csvText: string | null = null;
  const contentType = request.headers.get('content-type') || '';

  try {
    if (contentType.includes('application/json')) {
      const body = await request.json();
      if (typeof body?.csv === 'string') csvText = body.csv;
    } else if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      const file = form.get('file');
      if (file instanceof File) {
        csvText = await file.text();
      } else if (typeof form.get('csv') === 'string') {
        csvText = form.get('csv') as string;
      }
    } else {
      csvText = await request.text();
    }
  } catch (err) {
    return NextResponse.json({ error: `Could not read request body: ${err}` }, { status: 400 });
  }

  if (!csvText || !csvText.trim()) {
    return NextResponse.json({ error: 'CSV body is empty' }, { status: 400 });
  }

  const parsed = parseFbmCsv(csvText);

  if (parsed.globalErrors.length > 0) {
    return NextResponse.json(
      { error: 'CSV has structural problems', globalErrors: parsed.globalErrors },
      { status: 400 },
    );
  }
  if (parsed.rows.length === 0) {
    return NextResponse.json({ error: 'CSV has no parseable rows' }, { status: 400 });
  }

  // Row-level validation failures → 400, no writes.
  const rowErrors = parsed.rows
    .filter(r => r.errors.length > 0)
    .map(r => ({ rowIndex: r.rowIndex, sku: r.rawSku, errors: r.errors }));
  if (rowErrors.length > 0) {
    return NextResponse.json(
      { error: `${rowErrors.length} row(s) have validation errors`, rowErrors },
      { status: 400 },
    );
  }

  // Within-CSV duplicate SKU check (server-side, not trust-client).
  const seen = new Map<string, number>();
  const csvDupes: string[] = [];
  for (const r of parsed.rows) {
    const k = r.rawSku;
    const prev = seen.get(k);
    if (prev != null) csvDupes.push(k);
    else seen.set(k, r.rowIndex);
  }
  if (csvDupes.length > 0) {
    return NextResponse.json(
      { error: 'CSV contains duplicate Seller Skus', duplicateSkus: Array.from(new Set(csvDupes)) },
      { status: 400 },
    );
  }

  const db = getDb();
  try {
    // Block if any imported SKU already exists in inventory_ledger with
    // quantity_remaining > 0 OR batch_id IS NOT NULL. Both conditions matter:
    //   - quantity_remaining > 0  → SKU is still live somewhere (FIFO)
    //   - batch_id IS NOT NULL    → SKU already belongs to a batch (even if sold out)
    const skus = parsed.rows.map(r => r.rawSku);
    const placeholders = skus.map(() => '?').join(',');
    const existing = db.prepare(
      `SELECT DISTINCT sku FROM inventory_ledger
       WHERE sku IN (${placeholders})
         AND (quantity_remaining > 0 OR batch_id IS NOT NULL)`
    ).all(...skus) as Array<{ sku: string }>;

    if (existing.length > 0) {
      return NextResponse.json(
        {
          error: `${existing.length} SKU(s) already exist in inventory and can't be re-imported`,
          duplicateSkus: existing.map(e => e.sku),
        },
        { status: 409 },
      );
    }

    // ─── Transaction: batch + suppliers + products + lots ─────────────────
    const now = new Date();
    const nowIso = now.toISOString();
    const batchName = formatBatchName(now);

    const insertBatch = db.prepare(`
      INSERT INTO listing_batches (name, status, channel, marketplace, created_at, updated_at)
      VALUES (?, 'draft', 'MFN', 'amazon', ?, ?)
    `);

    // suppliers.name has a real UNIQUE constraint → ON CONFLICT(name) is safe.
    const upsertSupplier = db.prepare(`
      INSERT INTO suppliers (name, created_at) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET name = excluded.name
      RETURNING id
    `);

    // products has only a non-unique idx_products_asin index, so ON CONFLICT
    // is unsafe. Use manual select-then-insert/update keyed by asin.
    const selectProduct = db.prepare(`SELECT id, name, sku, marketplace FROM products WHERE asin = ? LIMIT 1`);
    const insertProduct = db.prepare(`
      INSERT INTO products (asin, sku, name, marketplace, created_at, updated_at)
      VALUES (?, ?, ?, 'amazon', ?, ?)
    `);
    const updateProduct = db.prepare(`
      UPDATE products
         SET name = COALESCE(NULLIF(?, ''), name),
             sku  = COALESCE(NULLIF(?, ''), sku),
             updated_at = ?
       WHERE id = ?
    `);

    const insertLot = db.prepare(`
      INSERT INTO inventory_ledger (
        asin, sku, buy_price, quantity, quantity_remaining,
        supplier_id, date_purchased,
        bin_location, condition, list_price_cents,
        merchant_shipping_group_name, received_at, inspected_at,
        quantity_received, batch_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `);

    let batchId = 0;
    let rowsImported = 0;
    let totalUnits = 0;
    let totalCostCents = 0;
    let totalListValueCents = 0;

    const tx = db.transaction(() => {
      const res = insertBatch.run(batchName, nowIso, nowIso);
      batchId = Number(res.lastInsertRowid);

      // Cache supplier_id per name within this transaction to avoid repeat upserts.
      const supplierIdByName = new Map<string, number>();

      for (const row of parsed.rows) {
        // ── Supplier upsert ───────────────────────────────────────────────
        // Prefer the Supplier *column*; fall back to the SKU-encoded supplier.
        const supplierName = (row.supplier?.trim() || row.skuParsed?.supplier || '').trim();
        let supplierId: number | null = null;
        if (supplierName) {
          const cached = supplierIdByName.get(supplierName);
          if (cached != null) {
            supplierId = cached;
          } else {
            const sRow = upsertSupplier.get(supplierName, nowIso) as { id: number } | undefined;
            if (sRow?.id != null) {
              supplierId = sRow.id;
              supplierIdByName.set(supplierName, supplierId);
            }
          }
        }

        // ── Product upsert (manual; no UNIQUE on asin) ────────────────────
        const existingProduct = selectProduct.get(row.asin) as
          | { id: number; name: string | null; sku: string | null; marketplace: string | null }
          | undefined;
        if (existingProduct) {
          updateProduct.run(row.productName ?? '', row.rawSku ?? '', nowIso, existingProduct.id);
        } else {
          insertProduct.run(row.asin, row.rawSku || null, row.productName || null, nowIso, nowIso);
        }

        // ── inventory_ledger lot ──────────────────────────────────────────
        // Money fields are guaranteed integer cents (parser computes via
        // Math.round). Quantity comes from the SKU. received_at, inspected_at,
        // quantity_received intentionally left NULL — operator marks them on
        // physical receive later.
        const datePurchased = row.purchaseDate || nowIso.slice(0, 10);
        insertLot.run(
          row.asin,
          row.rawSku,
          row.costCents,
          row.quantity,
          row.quantity,          // quantity_remaining = quantity for a fresh lot
          supplierId,
          datePurchased,
          'New',                 // condition — app-compatible default
          row.listPriceCents,
          row.shippingTemplate || null,
          batchId,
          nowIso,
        );

        rowsImported += 1;
        totalUnits += row.quantity;
        totalCostCents += row.costCents * row.quantity;
        totalListValueCents += row.listPriceCents * row.quantity;
      }
    });

    tx();

    return NextResponse.json({
      success: true,
      batchId,
      batchName,
      rowsImported,
      totalUnits,
      totalCostCents,
      totalListValueCents,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
