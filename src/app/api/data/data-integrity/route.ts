import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

/**
 * Data-integrity guardrail (audit F4).
 *
 * Standing health check for the numbers FlipLedger reports. Surfaces the silent
 * failure modes that erode trust once FlipLedger is the system of record (i.e.
 * once InventoryLab is gone and there's no second tool to cross-check against):
 *
 *  - shipped units booked at $0 COGS         → profit OVERSTATED, silently (F2)
 *  - sold SKUs/ASINs with no purchase lot    → root cause of the above
 *  - oversold lots (negative remaining)      → FIFO inconsistency
 *  - multi-SKU ASIN fallback collisions      → FIFO double-consume risk (F3)
 *  - pending orders consuming inventory      → unsettled orders depleting stock
 *
 * Read-only. Cents are returned as integers (the app's money convention).
 */

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

const NOT_CANCELED = "o.status NOT IN ('Canceled','Cancelled')";
const REAL_ASIN = "oi.asin IS NOT NULL AND oi.asin <> '' AND oi.asin <> 'PENDING'";

type Severity = 'ok' | 'warn' | 'error';

interface Check {
  id: string;
  label: string;
  description: string;
  severity: Severity;
  count: number;
  units?: number;
  amountCents?: number;
  sample: Record<string, unknown>[];
  fix?: string;
}

export async function GET() {
  const db = getDb();
  try {
    const checks: Check[] = [];

    // --- A: shipped units booked at $0 COGS (profit overstatement exposure) ---
    const zeroCogs = db.prepare(`
      SELECT COUNT(*) items, COALESCE(SUM(oi.quantity),0) units,
             COALESCE(SUM(oi.total_price),0) revenueCents,
             COUNT(DISTINCT oi.asin) asins
      FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
      WHERE (oi.cogs_per_unit IS NULL OR oi.cogs_per_unit = 0)
        AND ${NOT_CANCELED} AND ${REAL_ASIN}
    `).get() as any;
    const zeroCogsSample = db.prepare(`
      SELECT oi.asin, oi.sku,
             COALESCE(p.name, oi.asin) as productName,
             COUNT(*) items, SUM(oi.quantity) units, SUM(oi.total_price) revenueCents,
             MAX(o.purchase_date) lastSold
      FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN products p ON p.asin = oi.asin
      WHERE (oi.cogs_per_unit IS NULL OR oi.cogs_per_unit = 0)
        AND ${NOT_CANCELED} AND ${REAL_ASIN}
      GROUP BY oi.asin ORDER BY revenueCents DESC LIMIT 50
    `).all();
    checks.push({
      id: 'zero_cogs_sales',
      label: 'Shipped units booked at $0 COGS',
      description: 'Sold units with no cost recorded. Profit is overstated by their true cost until a buy lot is added and FIFO re-runs.',
      severity: zeroCogs.items > 0 ? 'warn' : 'ok',
      count: zeroCogs.items,
      units: zeroCogs.units,
      amountCents: zeroCogs.revenueCents,
      sample: zeroCogsSample as any[],
      fix: 'Add a purchase lot (Products & COGS) for each ASIN below, then COGS backfills on the next FIFO run / sync.',
    });

    // --- B: sold SKUs/ASINs with no purchase lot at all (root cause of A) ---
    const noLot = db.prepare(`
      SELECT COUNT(*) asins FROM (
        SELECT DISTINCT oi.asin
        FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
        WHERE ${NOT_CANCELED} AND ${REAL_ASIN}
          AND NOT EXISTS (
            SELECT 1 FROM inventory_ledger il
            WHERE il.buy_price > 0
              AND (il.sku = oi.sku OR il.asin = oi.asin)
          )
      )
    `).get() as any;
    checks.push({
      id: 'sold_without_lot',
      label: 'Sold ASINs with no purchase lot',
      description: 'ASINs that have sold but have zero inventory_ledger lots (neither by SKU nor ASIN). This is the root cause of $0-COGS sales.',
      severity: noLot.asins > 0 ? 'warn' : 'ok',
      count: noLot.asins,
      sample: [],
      fix: 'Same ASINs as the $0-COGS list above — adding a lot resolves both.',
    });

    // --- C: oversold lots (negative remaining) — FIFO inconsistency ---
    const oversold = db.prepare(`
      SELECT COUNT(*) lots, COALESCE(SUM(quantity_remaining),0) negUnits
      FROM inventory_ledger WHERE quantity_remaining < 0
    `).get() as any;
    const oversoldSample = db.prepare(`
      SELECT sku, asin, quantity, quantity_remaining as quantityRemaining, date_purchased as datePurchased
      FROM inventory_ledger WHERE quantity_remaining < 0
      ORDER BY quantity_remaining ASC LIMIT 50
    `).all();
    checks.push({
      id: 'oversold_lots',
      label: 'Oversold lots (negative remaining)',
      description: 'Lots whose remaining quantity went negative — more units sold than purchased. Indicates a missing/short buy lot.',
      severity: oversold.lots > 0 ? 'error' : 'ok',
      count: oversold.lots,
      units: oversold.negUnits,
      sample: oversoldSample as any[],
      fix: 'Add the missing buy lot for the SKU, then re-run FIFO.',
    });

    // --- D: multi-SKU ASIN fallback collision risk (F3) ---
    // Sales whose own SKU carries no lot but whose ASIN has lots under >1 SKU.
    // In recalcAll these get consumed by EVERY same-ASIN SKU pass (double-consume).
    const collision = db.prepare(`
      WITH multi AS (
        SELECT asin FROM inventory_ledger WHERE buy_price > 0
        GROUP BY asin HAVING COUNT(DISTINCT sku) > 1
      )
      SELECT COUNT(*) saleItems, COUNT(DISTINCT oi.asin) asins
      FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
      WHERE ${NOT_CANCELED} AND ${REAL_ASIN}
        AND oi.asin IN (SELECT asin FROM multi)
        AND (oi.sku IS NULL OR oi.sku = ''
             OR oi.sku NOT IN (SELECT sku FROM inventory_ledger WHERE buy_price > 0))
    `).get() as any;
    checks.push({
      id: 'fifo_fallback_collision',
      label: 'FIFO multi-SKU ASIN collision risk',
      description: 'Sales whose SKU has no lot, on an ASIN whose lots span multiple SKUs. FIFO recalcAll can double-consume these across every same-ASIN SKU.',
      severity: collision.saleItems > 0 ? 'warn' : 'ok',
      count: collision.saleItems,
      sample: [],
      fix: 'Resolved by the F3 fix (each orphan sale claimed by exactly one SKU). Until then, give the selling SKU its own lot.',
    });

    // --- E: pending orders consuming inventory (unsettled depletion) ---
    const pendingFifo = db.prepare(`
      SELECT COUNT(DISTINCT o.order_id) orders, COALESCE(SUM(oi.quantity),0) units
      FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
      WHERE o.status = 'Pending' AND ${REAL_ASIN}
    `).get() as any;
    checks.push({
      id: 'pending_consumes_fifo',
      label: 'Pending orders consuming inventory',
      description: 'Pending orders with a real (non-placeholder) line item are consumed by FIFO before they settle. Usually fine, but inflates COGS/depletes stock for orders that may cancel.',
      severity: 'ok',
      count: pendingFifo.orders,
      units: pendingFifo.units,
      sample: [],
    });

    // --- Headline: COGS coverage % over all shipped, non-canceled real units ---
    const coverage = db.prepare(`
      SELECT
        COALESCE(SUM(oi.quantity),0) totalUnits,
        COALESCE(SUM(CASE WHEN oi.cogs_per_unit > 0 THEN oi.quantity ELSE 0 END),0) coveredUnits
      FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
      WHERE ${NOT_CANCELED} AND ${REAL_ASIN}
    `).get() as any;
    const cogsCoveragePct = coverage.totalUnits > 0
      ? (coverage.coveredUnits / coverage.totalUnits) * 100
      : 100;

    const worst: Severity = checks.some(c => c.severity === 'error')
      ? 'error'
      : checks.some(c => c.severity === 'warn') ? 'warn' : 'ok';

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      overall: worst,
      summary: {
        cogsCoveragePct,
        totalUnits: coverage.totalUnits,
        coveredUnits: coverage.coveredUnits,
        zeroCogsUnits: zeroCogs.units,
        zeroCogsRevenueCents: zeroCogs.revenueCents,
      },
      checks,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
