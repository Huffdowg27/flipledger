/**
 * Backfill COGS from SKU-encoded costs.
 *
 * Many MFN listings use SKUs that encode the buy cost directly in the SKU
 * string (e.g. LV_01FAFLIP_030226_22.5_... → $22.50). This endpoint finds
 * all order_items with zero COGS and a recognizable SKU format, creates the
 * missing inventory_ledger entries, and runs FIFO so cogs_per_unit is set.
 *
 * GET  — preview: how many order_items would be affected
 * POST — run the backfill, then recalculate FIFO
 *
 * Idempotent: ledger entries are keyed on (sku, date_purchased, 'sku:auto')
 * so re-running the endpoint is safe.
 */

import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { extractCogsFromSku, isCogsEncodedSku, isAmazonGradedSku } from '@/lib/sku-cogs';
import { recalculateFIFO } from '@/lib/fifo';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

interface AffectedRow {
  sku: string;
  asin: string;
  date_purchased: string;
  qty: number;
  order_count: number;
  cogs_cents: number;
}

function getAffectedRows(db: ReturnType<typeof getDb>): AffectedRow[] {
  // Find order_items with COGS-encoded SKUs and zero cogs_per_unit,
  // grouped by (sku, date) so we create one ledger lot per buy date.
  // Exclude any SKU that already has a ledger entry (user entered it manually
  // or a previous backfill created it) — FIFO will handle those correctly.
  const rows = db.prepare(`
    SELECT
      oi.sku,
      oi.asin,
      DATE(o.purchase_date) as date_purchased,
      SUM(oi.quantity) as qty,
      COUNT(DISTINCT oi.order_id) as order_count
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.order_id
    WHERE oi.cogs_per_unit = 0
      AND oi.sku IS NOT NULL AND oi.sku != '' AND oi.sku != 'PENDING'
      AND oi.sku NOT LIKE 'amzn.gr.%'  -- graded resales never get a cost lot
      AND NOT EXISTS (
        SELECT 1 FROM inventory_ledger il WHERE il.sku = oi.sku
      )
    GROUP BY oi.sku, oi.asin, DATE(o.purchase_date)
    ORDER BY oi.sku, date_purchased
  `).all() as Omit<AffectedRow, 'cogs_cents'>[];

  return rows
    .filter(r => isCogsEncodedSku(r.sku) && !isAmazonGradedSku(r.sku))
    .map(r => ({
      ...r,
      cogs_cents: extractCogsFromSku(r.sku),
    }))
    .filter(r => r.cogs_cents > 0);
}

export async function GET() {
  const db = getDb();
  try {
    const affected = getAffectedRows(db);
    const uniqueSkus = new Set(affected.map(r => r.sku)).size;
    const totalOrders = affected.reduce((s, r) => s + r.order_count, 0);
    const totalUnits = affected.reduce((s, r) => s + r.qty, 0);

    return NextResponse.json({
      preview: true,
      uniqueSkus,
      totalOrders,
      totalUnits,
      lotGroups: affected.length,
      sample: affected.slice(0, 10).map(r => ({
        sku: r.sku,
        date: r.date_purchased,
        qty: r.qty,
        orders: r.order_count,
        cogsCents: r.cogs_cents,
        cogsDollars: (r.cogs_cents / 100).toFixed(2),
      })),
    });
  } finally {
    db.close();
  }
}

export async function POST() {
  const db = getDb();
  let lotsCreated = 0;
  const skusAffected = new Set<string>();

  try {
    const affected = getAffectedRows(db);

    if (affected.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No order_items with zero COGS and a COGS-encoded SKU found.',
        lotsCreated: 0,
        fifo: null,
      });
    }

    const now = new Date().toISOString();
    const insertLot = db.prepare(`
      INSERT INTO inventory_ledger
        (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'sku:auto', ?)
    `);

    // Check before inserting — skip if a lot with notes='sku:auto' for this
    // sku+date already exists (re-run safety).
    const existsCheck = db.prepare(`
      SELECT 1 FROM inventory_ledger
      WHERE sku = ? AND date_purchased = ? AND notes = 'sku:auto'
      LIMIT 1
    `);

    const tx = db.transaction(() => {
      for (const row of affected) {
        const alreadyExists = existsCheck.get(row.sku, row.date_purchased);
        if (alreadyExists) continue;

        insertLot.run(
          row.asin,
          row.sku,
          row.cogs_cents,
          row.qty,
          row.qty,            // quantity_remaining = qty; FIFO will deplete it
          row.date_purchased,
          now
        );
        lotsCreated++;
        skusAffected.add(row.sku);
      }
    });

    tx();
    db.close();

    // FIFO recalc for all affected SKUs (or full recalc if many)
    let fifoResult;
    if (skusAffected.size === 0) {
      fifoResult = { itemsUpdated: 0, skusProcessed: 0, batchesUpdated: 0, errors: [] };
    } else {
      fifoResult = recalculateFIFO({ recalcAll: true });
    }

    return NextResponse.json({
      success: true,
      lotsCreated,
      uniqueSkus: skusAffected.size,
      fifo: {
        itemsUpdated: fifoResult.itemsUpdated,
        skusProcessed: fifoResult.skusProcessed,
        errors: fifoResult.errors,
      },
    });
  } catch (err) {
    db.close();
    console.error('[backfill-sku-cogs] Error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
