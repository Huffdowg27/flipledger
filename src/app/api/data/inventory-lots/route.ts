/**
 * Multi-lot inventory management.
 *
 * Each row in `inventory_ledger` is one purchase lot — quantity bought, price
 * paid, date, supplier. Multiple lots per SKU is supported by the schema; this
 * endpoint is the entry point for adding NEW lots without overwriting existing
 * cost data (the older POST /api/data/products handler upserts in place, which
 * destroys multi-buy cost history).
 *
 * After inserting a lot, FIFO is recomputed for the SKU so existing sales pull
 * COGS in date order (oldest lot first → newest lot last).
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

// GET /api/data/inventory-lots?sku=X  →  list lots for a SKU (most recent first)
// GET /api/data/inventory-lots?asin=X →  list lots for an ASIN
export async function GET(request: NextRequest) {
  const sku = request.nextUrl.searchParams.get('sku');
  const asin = request.nextUrl.searchParams.get('asin');
  if (!sku && !asin) {
    return NextResponse.json({ error: 'sku or asin required' }, { status: 400 });
  }

  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT
        il.id,
        il.sku,
        il.asin,
        il.quantity,
        il.quantity_remaining,
        il.buy_price,
        il.date_purchased,
        il.notes,
        il.created_at,
        s.name AS supplier_name,
        (il.quantity - il.quantity_remaining) AS units_consumed
      FROM inventory_ledger il
      LEFT JOIN suppliers s ON s.id = il.supplier_id
      WHERE ${sku ? 'il.sku = ?' : 'il.asin = ?'}
      ORDER BY il.date_purchased ASC, il.id ASC
    `).all(sku || asin) as Array<{
      id: number; sku: string | null; asin: string | null;
      quantity: number; quantity_remaining: number; buy_price: number;
      date_purchased: string; notes: string | null; created_at: string;
      supplier_name: string | null; units_consumed: number;
    }>;

    const totalUnitsBought = rows.reduce((s, r) => s + r.quantity, 0);
    const totalUnitsRemaining = rows.reduce((s, r) => s + r.quantity_remaining, 0);
    const totalUnitsSold = totalUnitsBought - totalUnitsRemaining;
    const totalCogsConsumed = rows.reduce((s, r) => s + r.buy_price * (r.quantity - r.quantity_remaining), 0);
    const avgCogsPerUnitSold = totalUnitsSold > 0 ? Math.round(totalCogsConsumed / totalUnitsSold) : 0;

    return NextResponse.json({
      lots: rows,
      summary: {
        lotCount: rows.length,
        totalUnitsBought,
        totalUnitsRemaining,
        totalUnitsSold,
        totalCogsConsumedCents: totalCogsConsumed,
        avgCogsPerUnitSoldCents: avgCogsPerUnitSold,
      },
    });
  } finally {
    db.close();
  }
}

// POST /api/data/inventory-lots
// Body: { sku, asin?, quantity, buyPrice (dollars), supplier?, datePurchased?, notes? }
// Inserts a NEW lot row (does NOT overwrite existing).
export async function POST(request: NextRequest) {
  const body = await request.json();
  const sku: string | undefined = body.sku;
  const asin: string | undefined = body.asin;
  const quantity = Number(body.quantity);
  const buyPrice = Number(body.buyPrice);
  const supplier: string | undefined = body.supplier;
  const datePurchased: string | undefined = body.datePurchased;
  const notes: string | undefined = body.notes;

  if (!sku && !asin) {
    return NextResponse.json({ error: 'sku or asin required' }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: 'quantity must be a positive number' }, { status: 400 });
  }
  if (!Number.isFinite(buyPrice) || buyPrice < 0) {
    return NextResponse.json({ error: 'buyPrice must be a non-negative number' }, { status: 400 });
  }

  const db = getDb();
  try {
    const now = new Date().toISOString();
    const buyPriceCents = Math.round(buyPrice * 100);
    const dateP = datePurchased || now;

    let supplierId: number | null = null;
    if (supplier && supplier.trim()) {
      db.prepare('INSERT OR IGNORE INTO suppliers (name, created_at) VALUES (?, ?)').run(supplier.trim(), now);
      const row = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(supplier.trim()) as { id?: number } | undefined;
      supplierId = row?.id ?? null;
    }

    const result = db.prepare(`
      INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, supplier_id, date_purchased, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(asin || sku, sku || null, buyPriceCents, quantity, quantity, supplierId, dateP, notes || null, now);

    const newLotId = Number(result.lastInsertRowid);
    db.close();

    // Recalculate FIFO for the affected SKU/ASIN. This re-allocates COGS
    // across all lots in date order, so adding a new lot can shift cost
    // attribution on past sales (e.g. older lot ran out, new lot kicks in).
    const fifoResult = recalculateFIFO({ sku: sku || undefined, asin: asin || undefined });

    return NextResponse.json({ success: true, lotId: newLotId, fifo: fifoResult });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// PATCH /api/data/inventory-lots
// Body: { id, quantity?, buyPrice?, supplier?, datePurchased?, notes? }
// Edits an existing lot (e.g. to correct a typo). Re-runs FIFO afterward.
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  const db = getDb();
  try {
    const existing = db.prepare('SELECT sku, asin FROM inventory_ledger WHERE id = ?').get(id) as { sku: string | null; asin: string | null } | undefined;
    if (!existing) {
      db.close();
      return NextResponse.json({ error: 'lot not found' }, { status: 404 });
    }

    const fields: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.quantity !== undefined) {
      const q = Number(body.quantity);
      if (!Number.isFinite(q) || q <= 0) {
        db.close();
        return NextResponse.json({ error: 'quantity must be positive' }, { status: 400 });
      }
      fields.push('quantity = ?');
      params.push(q);
    }
    if (body.buyPrice !== undefined) {
      const bp = Number(body.buyPrice);
      if (!Number.isFinite(bp) || bp < 0) {
        db.close();
        return NextResponse.json({ error: 'buyPrice invalid' }, { status: 400 });
      }
      fields.push('buy_price = ?');
      params.push(Math.round(bp * 100));
    }
    if (body.datePurchased !== undefined) {
      fields.push('date_purchased = ?');
      params.push(body.datePurchased);
    }
    if (body.notes !== undefined) {
      fields.push('notes = ?');
      params.push(body.notes || null);
    }
    if (body.supplier !== undefined) {
      const now = new Date().toISOString();
      let supplierId: number | null = null;
      if (body.supplier && body.supplier.trim()) {
        db.prepare('INSERT OR IGNORE INTO suppliers (name, created_at) VALUES (?, ?)').run(body.supplier.trim(), now);
        const r = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(body.supplier.trim()) as { id?: number } | undefined;
        supplierId = r?.id ?? null;
      }
      fields.push('supplier_id = ?');
      params.push(supplierId);
    }

    if (fields.length === 0) {
      db.close();
      return NextResponse.json({ error: 'no fields to update' }, { status: 400 });
    }

    params.push(id);
    db.prepare(`UPDATE inventory_ledger SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    db.close();

    const fifoResult = recalculateFIFO({ sku: existing.sku || undefined, asin: existing.asin || undefined });
    return NextResponse.json({ success: true, fifo: fifoResult });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE /api/data/inventory-lots?id=X
// Deletes a lot (e.g. duplicate entry). Re-runs FIFO afterward.
export async function DELETE(request: NextRequest) {
  const id = Number(request.nextUrl.searchParams.get('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  const db = getDb();
  try {
    const existing = db.prepare('SELECT sku, asin FROM inventory_ledger WHERE id = ?').get(id) as { sku: string | null; asin: string | null } | undefined;
    if (!existing) {
      db.close();
      return NextResponse.json({ error: 'lot not found' }, { status: 404 });
    }

    db.prepare('DELETE FROM inventory_ledger WHERE id = ?').run(id);
    db.close();

    const fifoResult = recalculateFIFO({ sku: existing.sku || undefined, asin: existing.asin || undefined });
    return NextResponse.json({ success: true, fifo: fifoResult });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
