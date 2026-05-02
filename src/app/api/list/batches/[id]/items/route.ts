/**
 * Batch items API.
 *
 * POST /api/list/batches/[id]/items
 *   - Adds an item to a batch. Also writes to inventory_ledger (for COGS/FIFO).
 *   - Auto-triggers FIFO recalculation for the affected SKU/ASIN.
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
  } = body;

  if (!asin) return NextResponse.json({ error: 'asin is required' }, { status: 400 });
  if (!sku) return NextResponse.json({ error: 'sku is required' }, { status: 400 });
  if (!Number.isFinite(quantity) || quantity < 1) {
    return NextResponse.json({ error: 'quantity must be >= 1' }, { status: 400 });
  }

  const listPriceCents = Math.round((Number(listPrice) || 0) * 100);
  const buyPriceCents = Math.round((Number(buyPrice) || 0) * 100);

  const db = getDb();
  try {
    // Make sure the batch exists and is editable
    const batch = db.prepare('SELECT status FROM listing_batches WHERE id = ?').get(batchId) as any;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.status !== 'draft') {
      return NextResponse.json({ error: `Cannot add items to batch in status: ${batch.status}` }, { status: 400 });
    }

    const now = new Date().toISOString();

    const addItem = db.transaction(() => {
      // 1. Insert into listing_batch_items
      const result = db.prepare(`
        INSERT INTO listing_batch_items (
          batch_id, asin, sku, msku, product_name, image_url, condition,
          quantity, list_price_cents, buy_price_cents, supplier, purchase_date,
          estimated_fee_cents, estimated_ship_cents, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        now
      );

      // 2. Ensure supplier exists in suppliers table
      let supplierId: number | null = null;
      if (supplier) {
        db.prepare('INSERT OR IGNORE INTO suppliers (name, created_at) VALUES (?, ?)').run(supplier, now);
        const sRow = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(supplier) as any;
        supplierId = sRow?.id ?? null;
      }

      // 3. Write to inventory_ledger so FIFO can assign COGS to future sales.
      //    If an entry for this SKU already exists, update buy_price and add to quantity.
      //    If not, insert a new entry.
      const existing = db.prepare('SELECT id, quantity, quantity_remaining FROM inventory_ledger WHERE sku = ?').get(sku) as any;
      if (existing) {
        db.prepare(`
          UPDATE inventory_ledger SET
            buy_price = ?,
            quantity = quantity + ?,
            quantity_remaining = quantity_remaining + ?,
            supplier_id = COALESCE(?, supplier_id),
            date_purchased = COALESCE(?, date_purchased)
          WHERE id = ?
        `).run(buyPriceCents, quantity, quantity, supplierId, purchaseDate || now, existing.id);
      } else {
        db.prepare(`
          INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, supplier_id, date_purchased, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(asin, sku, buyPriceCents, quantity, quantity, supplierId, purchaseDate || now, now);
      }

      // 4. Upsert into products so the name/image get reused next time
      if (productName) {
        db.prepare(`
          INSERT INTO products (asin, sku, name, image_url, marketplace, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'amazon', ?, ?)
          ON CONFLICT(asin) DO UPDATE SET
            name = COALESCE(excluded.name, name),
            image_url = COALESCE(excluded.image_url, image_url),
            updated_at = excluded.updated_at
        `).run(asin, sku, productName, imageUrl || null, now, now);
      }

      // 5. Bump the batch's updated_at
      db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(now, batchId);

      return result.lastInsertRowid;
    });

    const itemId = addItem();
    db.close();

    // 6. Auto-recalculate FIFO for this SKU (matches Products page behavior)
    const fifo = recalculateFIFO({ sku });

    return NextResponse.json({ id: itemId, success: true, fifo });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
