import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

// GET /api/data/merchant-inventory
// Returns all inventory_ledger lots with qty_remaining > 0, joined to product info.
// Sorted: binned items first (alpha by bin), then unbinned (by date desc).
export async function GET() {
  const db = getDb();
  try {
    const items = db.prepare(`
      SELECT
        il.id,
        il.asin,
        il.sku,
        il.quantity,
        il.quantity_remaining,
        il.buy_price,
        il.date_purchased,
        il.bin_location,
        il.condition,
        il.notes,
        s.name AS supplier_name,
        p.name AS product_name,
        p.image_url,
        p.category,
        lbi.fnsku
      FROM inventory_ledger il
      LEFT JOIN suppliers s ON s.id = il.supplier_id
      LEFT JOIN products p ON p.asin = il.asin
      LEFT JOIN (
        SELECT sku, fnsku FROM listing_batch_items
        WHERE fnsku IS NOT NULL
        GROUP BY sku
      ) lbi ON lbi.sku = il.sku
      WHERE il.quantity_remaining > 0
      ORDER BY
        CASE WHEN il.bin_location IS NULL OR il.bin_location = '' THEN 1 ELSE 0 END,
        il.bin_location ASC,
        il.date_purchased DESC
    `).all();

    return NextResponse.json({ items });
  } catch (error) {
    console.error('Merchant inventory error:', error);
    return NextResponse.json({ error: 'Failed to load inventory' }, { status: 500 });
  } finally {
    db.close();
  }
}
