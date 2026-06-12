/**
 * Batch items API.
 *
 * POST /api/list/batches/[id]/items
 *   - Adds an item to a batch and links it to an inventory_ledger row.
 *
 * Behavior depends on listingMode:
 *   - CREATE_NEW         → always INSERTs a fresh inventory_ledger lot. Never
 *                          merges into or mutates a prior lot for the same SKU.
 *                          FIFO is recalculated after the insert.
 *   - REPLENISH_EXISTING → links the batch item to the newest existing lot
 *                          with quantity_remaining > 0 for that SKU. Does NOT
 *                          mutate that lot (no buy_price overwrite, no
 *                          date_purchased overwrite, no quantity change), so
 *                          FIFO is NOT recalculated. If NO open lot exists
 *                          (restock: prior lots sold through), a fresh lot is
 *                          INSERTed at the entered buy price/date — same as
 *                          CREATE_NEW but keeping the live Amazon MSKU — and
 *                          FIFO IS recalculated.
 *
 * The link is stored on listing_batch_items.inventory_ledger_id and is what
 * DELETE uses to roll back correctly without guessing by SKU.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { recalculateFIFO } from '@/lib/fifo';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

const ALLOWED_LISTING_MODES = new Set(['CREATE_NEW', 'REPLENISH_EXISTING']);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  const body = await request.json();
  const {
    asin,
    sku,
    msku,
    productName,
    imageUrl,
    condition = 'NewItem',
    quantity = 1,
    listPrice,           // dollars
    buyPrice,            // dollars
    supplier,
    purchaseDate,
    estimatedFeeCents,   // already in cents (optional)
    estimatedShipCents,  // already in cents (optional) — MFN seller shipping estimate
    listingMode = 'CREATE_NEW',  // 'CREATE_NEW' | 'REPLENISH_EXISTING'
    fnsku,               // known FNSKU for replenishment items
    fulfillmentChannel,  // 'FBA' | 'MFN'
    listingSource,       // 'AMAZON_INVENTORY' | 'LOCAL_DB' | 'CATALOG'
    amazonInventoryStatus, // e.g. 'DISCOVERABLE', 'ACTIVE', etc.
  } = body;

  if (!asin) return NextResponse.json({ error: 'asin is required' }, { status: 400 });
  if (!sku) return NextResponse.json({ error: 'sku is required' }, { status: 400 });
  if (!Number.isFinite(quantity) || quantity < 1) {
    return NextResponse.json({ error: 'quantity must be >= 1' }, { status: 400 });
  }
  if (!ALLOWED_LISTING_MODES.has(listingMode)) {
    return NextResponse.json(
      { error: `listingMode must be one of: ${[...ALLOWED_LISTING_MODES].join(', ')}` },
      { status: 400 }
    );
  }

  const listPriceCents = Math.round((Number(listPrice) || 0) * 100);
  const buyPriceCents = Math.round((Number(buyPrice) || 0) * 100);

  const db = getDb();
  try {
    const batch = db.prepare('SELECT status FROM listing_batches WHERE id = ?').get(batchId) as { status?: string } | undefined;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.status !== 'draft') {
      return NextResponse.json({ error: `Cannot add items to batch in status: ${batch.status}` }, { status: 400 });
    }

    // A SKU can appear only once per batch — the send flow PUTs one listing
    // per SKU and the inbound plan carries one entry per MSKU, so a duplicate
    // row would double-create inventory lots (CREATE_NEW) and double-count
    // plan quantities.
    const dup = db.prepare(
      'SELECT id, quantity FROM listing_batch_items WHERE batch_id = ? AND sku = ?'
    ).get(batchId, sku) as { id: number; quantity: number } | undefined;
    if (dup) {
      return NextResponse.json({
        error: `SKU ${sku} is already in this batch (qty ${dup.quantity}). Edit that row's quantity instead of adding it again.`,
      }, { status: 409 });
    }

    const now = new Date().toISOString();

    let didCreateLot = false;

    const addItem = db.transaction(() => {
      // Ensure supplier exists first so we can reuse the id for a fresh lot.
      let supplierId: number | null = null;
      if (supplier) {
        db.prepare('INSERT OR IGNORE INTO suppliers (name, created_at) VALUES (?, ?)').run(supplier, now);
        const sRow = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(supplier) as { id?: number } | undefined;
        supplierId = sRow?.id ?? null;
      }

      // Resolve inventory_ledger_id per listingMode.
      let inventoryLedgerId: number;

      if (listingMode === 'REPLENISH_EXISTING') {
        // Reuse the newest non-empty lot. Do NOT touch any column on it.
        const existing = db.prepare(`
          SELECT id FROM inventory_ledger
          WHERE sku = ? AND quantity_remaining > 0
          ORDER BY date_purchased DESC, id DESC
          LIMIT 1
        `).get(sku) as { id?: number } | undefined;
        if (existing?.id) {
          inventoryLedgerId = existing.id;
        } else {
          // No open local lot — this is a restock: a fresh purchase going to
          // an existing Amazon listing whose prior lots sold through. Record
          // the buy as a NEW lot at its own price/date (multi-lot FIFO rule),
          // keeping the Amazon MSKU so the send flow still skips the listing
          // PUT and reuses the live FNSKU.
          const lotResult = db.prepare(`
            INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, supplier_id, date_purchased, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(asin, sku, buyPriceCents, quantity, quantity, supplierId, purchaseDate || now, now);
          inventoryLedgerId = Number(lotResult.lastInsertRowid);
          didCreateLot = true;
        }
      } else {
        // CREATE_NEW: always insert a fresh lot. Never merge with prior lots.
        const lotResult = db.prepare(`
          INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, supplier_id, date_purchased, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(asin, sku, buyPriceCents, quantity, quantity, supplierId, purchaseDate || now, now);
        inventoryLedgerId = Number(lotResult.lastInsertRowid);
        didCreateLot = true;
      }

      // Insert listing_batch_items with the resolved ledger link.
      const result = db.prepare(`
        INSERT INTO listing_batch_items (
          batch_id, asin, sku, msku, product_name, image_url, condition,
          quantity, list_price_cents, buy_price_cents, supplier, purchase_date,
          estimated_fee_cents, estimated_ship_cents, listing_mode, fnsku,
          fulfillment_channel, listing_source, amazon_inventory_status,
          inventory_ledger_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        asin,
        sku,
        msku || null,
        productName || null,
        imageUrl || null,
        condition,
        quantity,
        listPriceCents,
        buyPriceCents,
        supplier || null,
        purchaseDate || null,
        estimatedFeeCents || 0,
        estimatedShipCents || 0,
        listingMode,
        fnsku || null,
        fulfillmentChannel || null,
        listingSource || null,
        amazonInventoryStatus || null,
        inventoryLedgerId,
        now
      );

      db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(now, batchId);

      return { itemId: result.lastInsertRowid, inventoryLedgerId };
    });

    let txResult: { itemId: number | bigint; inventoryLedgerId: number };
    try {
      txResult = addItem();
    } catch (txErr) {
      db.close();
      const msg = txErr instanceof Error ? txErr.message : String(txErr);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    // Product cache is helpful for future lookups, but it must never decide
    // whether the batch item itself saved. Keep it outside the transaction so a
    // products-table schema/cache issue cannot roll back listing_batch_items.
    if (productName) {
      try {
        const updated = db.prepare(`
          UPDATE products SET
            sku = COALESCE(?, sku),
            name = COALESCE(?, name),
            image_url = COALESCE(?, image_url),
            updated_at = ?
          WHERE asin = ?
        `).run(sku, productName, imageUrl || null, now, asin);

        if (updated.changes === 0) {
          db.prepare(`
            INSERT INTO products (asin, sku, name, image_url, marketplace, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'amazon', ?, ?)
          `).run(asin, sku, productName, imageUrl || null, now, now);
        }
      } catch (cacheErr) {
        console.warn('[batch items] product cache update skipped:', cacheErr);
      }
    }

    db.close();

    // FIFO only matters when a lot was created. Replenish links to an
    // unchanged lot → nothing to re-allocate.
    const fifo = didCreateLot ? recalculateFIFO({ sku }) : null;

    return NextResponse.json({
      id: txResult.itemId,
      inventoryLedgerId: txResult.inventoryLedgerId,
      success: true,
      fifo,
    });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
