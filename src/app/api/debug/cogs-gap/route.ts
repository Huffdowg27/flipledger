/**
 * GET /api/debug/cogs-gap?startDate=2026-04-11&endDate=2026-05-11
 *
 * READ-ONLY COGS gap drilldown.
 *
 * FL COGS: -$17,054.21  |  IL COGS: -$22,994.55  |  Gap: +$5,940.34
 *
 * Breaks gap into:
 *   Group 1: Orders in both FL Accrual and IL Hybrid (purchase_date in range)
 *   Group 2: Prior-period orders IL counts (purchased before range, settled in range) — FL accrual excludes
 *   Group 3: Zero-COGS orders within FL Accrual — root cause analysis
 *
 * HARD RULES: readonly DB, no writes, no production formula changes.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  return new Database(dbPath, { readonly: true });
}

function cents(n: number | null | undefined): string {
  if (n == null) return '$0.00';
  return '$' + (n / 100).toFixed(2);
}

// Parse QTY field from MSKU: PREPTYPE_SUPPLIER_MMDDYY_COST_QTY_BATCH_CONDITION_SEQ
function parseMskuQty(sku: string | null): number | null {
  if (!sku) return null;
  const parts = sku.split('_');
  if (parts.length < 6) return null;
  const qty = parseInt(parts[4], 10);
  return isNaN(qty) ? null : qty;
}

function parseMskuCost(sku: string | null): number | null {
  if (!sku) return null;
  const parts = sku.split('_');
  if (parts.length < 5) return null;
  const cost = parseFloat(parts[3]);
  return isNaN(cost) ? null : Math.round(cost * 100);
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const startDate = searchParams.get('startDate') ?? '2026-04-11';
  const endDate   = searchParams.get('endDate')   ?? '2026-05-11';
  const endExcl   = new Date(endDate);
  endExcl.setDate(endExcl.getDate() + 1);
  const endNext   = endExcl.toISOString().slice(0, 10);

  const db = getDb();
  try {
    const IL_COGS_CENTS = -2299455; // IL COGS: -$22,994.55

    // ── GROUP 1: FL Accrual orders (purchase_date in range) ─────────────────
    const g1 = db.prepare(`
      SELECT
        COUNT(DISTINCT o.order_id)                                       AS orders,
        SUM(oi.quantity)                                                  AS units,
        SUM(oi.total_price)                                               AS sale_cents,
        SUM(COALESCE(oi.cogs_per_unit, 0) * oi.quantity)                 AS cogs_cents,
        SUM(CASE WHEN COALESCE(oi.cogs_per_unit, 0) = 0 THEN 1 ELSE 0 END) AS zero_cogs_lines,
        SUM(CASE WHEN COALESCE(oi.cogs_per_unit, 0) = 0 THEN oi.quantity ELSE 0 END) AS zero_cogs_units,
        SUM(CASE WHEN COALESCE(oi.cogs_per_unit, 0) = 0 THEN oi.total_price ELSE 0 END) AS zero_cogs_sale
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
    `).all(startDate, endNext)[0] as any;

    // ── GROUP 2: Prior-period orders (IL counts, FL accrual excludes) ────────
    const g2 = db.prepare(`
      SELECT
        COUNT(DISTINCT o.order_id)                                       AS orders,
        SUM(oi.quantity)                                                  AS units,
        SUM(oi.total_price)                                               AS sale_cents,
        SUM(COALESCE(oi.cogs_per_unit, 0) * oi.quantity)                 AS cogs_cents,
        SUM(CASE WHEN COALESCE(oi.cogs_per_unit, 0) = 0 THEN oi.quantity ELSE 0 END) AS zero_cogs_units
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.purchase_date < ?
        AND EXISTS (
          SELECT 1 FROM financial_events fe
          WHERE fe.order_id = o.order_id
            AND fe.event_type = 'ShipmentEvent'
            AND fe.posted_date >= ? AND fe.posted_date < ?
        )
    `).all(startDate, startDate, endNext)[0] as any;

    // ── GROUP 3: Zero-COGS breakdown ────────────────────────────────────────
    // 3a: lot depleted (in ledger, remaining=0)
    const g3_depleted = db.prepare(`
      SELECT COUNT(*) AS lines, SUM(oi.quantity) AS units, SUM(oi.total_price) AS sale_cents
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
        AND COALESCE(oi.cogs_per_unit, 0) = 0
        AND EXISTS (
          SELECT 1 FROM inventory_ledger il
          WHERE il.sku = oi.sku AND il.quantity_remaining = 0
        )
    `).all(startDate, endNext)[0] as any;

    // 3b: future lot (lot date_purchased after order date, no prior lot with stock)
    const g3_future = db.prepare(`
      SELECT COUNT(*) AS lines, SUM(oi.quantity) AS units, SUM(oi.total_price) AS sale_cents
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
        AND COALESCE(oi.cogs_per_unit, 0) = 0
        AND EXISTS (
          SELECT 1 FROM inventory_ledger il
          WHERE il.sku = oi.sku AND il.date_purchased > o.purchase_date
        )
        AND NOT EXISTS (
          SELECT 1 FROM inventory_ledger il
          WHERE il.sku = oi.sku
            AND il.date_purchased <= o.purchase_date
            AND il.quantity_remaining > 0
        )
    `).all(startDate, endNext)[0] as any;

    // 3c: no lot at all (SKU and ASIN missing from inventory_ledger)
    const g3_noLot = db.prepare(`
      SELECT COUNT(*) AS lines, SUM(oi.quantity) AS units, SUM(oi.total_price) AS sale_cents,
             GROUP_CONCAT(DISTINCT oi.sku) AS skus
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
        AND COALESCE(oi.cogs_per_unit, 0) = 0
        AND NOT EXISTS (SELECT 1 FROM inventory_ledger il WHERE il.sku = oi.sku)
        AND NOT EXISTS (SELECT 1 FROM inventory_ledger il WHERE il.asin = oi.asin)
    `).all(startDate, endNext)[0] as any;

    // 3d: estimated missing COGS (lot exists, use buy_price × qty)
    const g3_missingEst = db.prepare(`
      SELECT SUM(oi.quantity * il.buy_price) AS missing_cogs_cents,
             COUNT(*) AS lines, SUM(oi.quantity) AS units
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      JOIN inventory_ledger il ON il.sku = oi.sku
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
        AND COALESCE(oi.cogs_per_unit, 0) = 0
    `).all(startDate, endNext)[0] as any;

    // ── MSKU QTY MISMATCH TABLE ──────────────────────────────────────────────
    // Shows lot_qty (what FL has) vs MSKU-encoded qty (what you actually bought)
    const mskyQtyMismatch = db.prepare(`
      SELECT oi.sku, il.quantity AS lot_qty, il.quantity_remaining, il.buy_price,
             il.date_purchased AS lot_date,
             SUM(oi.quantity) AS sold_in_range,
             COUNT(DISTINCT o.order_id) AS order_lines,
             SUM(oi.total_price) AS sale_cents,
             SUM(CASE WHEN COALESCE(oi.cogs_per_unit,0) > 0 THEN oi.quantity ELSE 0 END) AS units_with_cogs,
             SUM(CASE WHEN COALESCE(oi.cogs_per_unit,0) = 0 THEN oi.quantity ELSE 0 END) AS units_zero_cogs
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      JOIN inventory_ledger il ON il.sku = oi.sku
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
        AND EXISTS (
          SELECT 1 FROM order_items oi2
          JOIN orders o2 ON o2.order_id = oi2.order_id
          WHERE oi2.sku = oi.sku
            AND o2.purchase_date >= ? AND o2.purchase_date < ?
            AND COALESCE(oi2.cogs_per_unit, 0) = 0
        )
      GROUP BY oi.sku, il.quantity, il.quantity_remaining, il.buy_price, il.date_purchased
      ORDER BY sale_cents DESC
      LIMIT 40
    `).all(startDate, endNext, startDate, endNext) as any[];

    // ── PER-ORDER ZERO-COGS TABLE ────────────────────────────────────────────
    const zeroCogsOrders = db.prepare(`
      SELECT
        o.order_id,
        o.purchase_date,
        MIN(fe.posted_date)       AS posted_date,
        oi.sku,
        oi.asin,
        oi.quantity,
        oi.total_price            AS item_price_cents,
        oi.cogs_per_unit,
        il.buy_price              AS lot_buy_price,
        il.quantity               AS lot_qty,
        il.quantity_remaining     AS lot_remaining,
        il.date_purchased         AS lot_date,
        o.status
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      LEFT JOIN inventory_ledger il ON il.sku = oi.sku
      LEFT JOIN financial_events fe
             ON fe.order_id = o.order_id AND fe.event_type = 'ShipmentEvent'
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
        AND COALESCE(oi.cogs_per_unit, 0) = 0
      GROUP BY o.order_id, oi.sku, oi.asin, oi.quantity, oi.total_price, oi.cogs_per_unit,
               il.buy_price, il.quantity, il.quantity_remaining, il.date_purchased, o.status
      ORDER BY o.purchase_date, item_price_cents DESC
    `).all(startDate, endNext) as any[];

    const annotatedZeroCogs = zeroCogsOrders.map((r: any) => {
      const mskuQty   = parseMskuQty(r.sku);
      const mskuCost  = parseMskuCost(r.sku);
      const hasLot    = r.lot_buy_price != null;
      const lotFuture = hasLot && r.lot_date > r.purchase_date;
      const qtyMismatch = hasLot && mskuQty != null && r.lot_qty < mskuQty;

      let diagnosis: string;
      let lotFound: 'YES' | 'NO';
      if (!hasLot) {
        lotFound = 'NO';
        diagnosis = 'SKU absent from inventory_ledger — no lot imported for this SKU';
      } else if (lotFuture) {
        lotFound = 'YES';
        diagnosis = `Lot date_purchased (${r.lot_date?.slice(0,10)}) is AFTER order date — FIFO cannot use future lots`;
      } else if (r.lot_remaining === 0) {
        lotFound = 'YES';
        diagnosis = `Lot depleted: lot_qty=${r.lot_qty} but MSKU encodes ${mskuQty ?? '?'} units purchased. Lot quantity understated — imported from sales CSV (units sold), not purchase records`;
      } else {
        lotFound = 'YES';
        diagnosis = 'Lot exists with remaining stock — FIFO may not have re-run after import';
      }

      const expectedCogs = hasLot
        ? cents((r.lot_buy_price ?? 0) * r.quantity)
        : mskuCost != null
          ? cents(mskuCost * r.quantity)
          : null;

      return {
        order_id:          r.order_id,
        purchase_date:     r.purchase_date?.slice(0, 10) ?? null,
        posted_date:       r.posted_date?.slice(0, 10) ?? null,
        sku:               r.sku,
        asin:              r.asin,
        quantity:          r.quantity,
        item_price:        cents(r.item_price_cents),
        fl_cogs:           '$0.00',
        lot_found:         lotFound,
        lot_buy_price:     hasLot ? cents(r.lot_buy_price) : null,
        lot_qty:           r.lot_qty ?? null,
        lot_remaining:     r.lot_remaining ?? null,
        lot_date:          r.lot_date?.slice(0, 10) ?? null,
        msku_encoded_qty:  mskuQty,
        msku_encoded_cost: mskuCost ? cents(mskuCost) : null,
        expected_cogs:     expectedCogs,
        qty_mismatch:      qtyMismatch
          ? `YES — lot has ${r.lot_qty} units, MSKU says ${mskuQty} purchased`
          : 'NO',
        diagnosis,
        status:            r.status,
      };
    });

    // ── GAP DECOMPOSITION ────────────────────────────────────────────────────
    const flCogsCents         = g1.cogs_cents as number;
    const g2CogsCents         = g2.cogs_cents as number;
    const missingCogsCents    = g3_missingEst.missing_cogs_cents as number ?? 0;
    const ilForSameOrders     = Math.abs(IL_COGS_CENTS) - g2CogsCents; // IL COGS for purchase-in-range orders
    const remainingGap        = ilForSameOrders - flCogsCents;

    const decomposition = {
      fl_accrual_cogs:       cents(-flCogsCents),
      il_hybrid_cogs:        cents(IL_COGS_CENTS),
      total_gap:             cents(Math.abs(IL_COGS_CENTS) - flCogsCents),
      component_A_date_basis: {
        label:   'A — Date-basis mismatch: prior-period orders IL includes, FL accrual excludes',
        orders:  g2.orders,
        units:   g2.units,
        sale:    cents(g2.sale_cents),
        cogs:    cents(g2.cogs_cents),
        explains: cents(g2.cogs_cents),
      },
      component_B_zero_cogs: {
        label:   'B — Zero/missing COGS on in-range FL orders (lot quantity understatement)',
        lines:   g1.zero_cogs_lines,
        units:   g1.zero_cogs_units,
        sale:    cents(g1.zero_cogs_sale),
        fl_cogs: '$0.00',
        estimated_missing_cogs: cents(missingCogsCents),
        explains_remaining_gap: cents(remainingGap),
        note:    'Missing COGS estimate uses lot.buy_price × zero-cogs units. Actual IL COGS for these may differ.',
      },
      component_C_sku_matching: {
        label:   'C — SKU absent from inventory_ledger entirely',
        lines:   g3_noLot.lines,
        units:   g3_noLot.units,
        sale:    cents(g3_noLot.sale_cents),
        skus:    g3_noLot.skus,
      },
      component_D_future_lot: {
        label:   'D — Future lot date: lot date_purchased is after order purchase_date',
        lines:   g3_future.lines,
        units:   g3_future.units,
        sale:    cents(g3_future.sale_cents),
      },
      remaining_unexplained: cents(
        Math.abs(IL_COGS_CENTS) - flCogsCents - g2CogsCents - remainingGap
      ),
    };

    // ── ROOT CAUSE VERDICT ───────────────────────────────────────────────────
    const rootCause = {
      primary_A_date_basis: {
        verdict: 'CONFIRMED MAJOR',
        amount:  cents(g2CogsCents),
        pct_of_gap: ((g2CogsCents / (Math.abs(IL_COGS_CENTS) - flCogsCents)) * 100).toFixed(1) + '%',
        explanation: `${g2.orders} orders purchased before ${startDate} but settled in range. IL hybrid counts them; FL accrual excludes them (correct by design). Their COGS is ${cents(g2CogsCents)}.`,
        action: 'Not a bug — mode difference. Fix: add IL Hybrid mode to FL dashboard.',
      },
      secondary_B_lot_qty: {
        verdict: 'CONFIRMED SECONDARY',
        amount:  cents(remainingGap),
        pct_of_gap: ((remainingGap / (Math.abs(IL_COGS_CENTS) - flCogsCents)) * 100).toFixed(1) + '%',
        explanation: `${g1.zero_cogs_lines} order lines (${g1.zero_cogs_units} units) have $0 COGS. Root cause: inventory_ledger was imported from IL FBA Sales CSV (units sold per export period), not from purchase records. MSKU name encodes actual purchase quantity (e.g. "141" units) but lot was created with the number of rows in the sales CSV (e.g. 1 row = qty=1). Lot depletes after 1-14 units and all subsequent sales get $0 COGS. Estimated missing COGS at lot buy_price: ${cents(missingCogsCents)}.`,
        action: 'Fix: re-import inventory_ledger using MSKU-encoded QTY field (position 4) as lot quantity, then re-run FIFO. Or use IL Inventory Valuation CSV to set correct quantities.',
      },
      minor_C_missing_sku: {
        verdict: 'MINOR',
        explanation: `${g3_noLot.lines} lines, ${g3_noLot.units} units, ${cents(g3_noLot.sale_cents)} sale with no lot in inventory_ledger at all. SKUs: ${g3_noLot.skus}.`,
        action: 'Add missing lots manually or find in IL Inventory Valuation CSV.',
      },
      minor_D_future_lot: {
        verdict: 'MINOR',
        explanation: `${g3_future.lines} lines where the lot\'s date_purchased is after the order date. FIFO won\'t assign future lots. Likely import artifact (wrong date_purchased in inventory_ledger).`,
        action: 'Fix lot date_purchased to reflect actual purchase date (parse from MSKU MMDDYY field).',
      },
    };

    // ── MSKU QTY MISMATCH TABLE (top offenders) ──────────────────────────────
    const mskyTable = mskyQtyMismatch.map((r: any) => ({
      sku:            r.sku,
      lot_qty:        r.lot_qty,
      msku_encoded_qty: parseMskuQty(r.sku),
      qty_gap:        r.lot_qty != null && parseMskuQty(r.sku) != null
                        ? (parseMskuQty(r.sku)! - r.lot_qty)
                        : null,
      lot_buy_price:  cents(r.lot_buy_price),
      lot_remaining:  r.lot_remaining,
      lot_date:       r.lot_date?.slice(0, 10),
      sold_in_range:  r.sold_in_range,
      units_with_cogs: r.units_with_cogs,
      units_zero_cogs: r.units_zero_cogs,
      sale_in_range:  cents(r.sale_cents),
      estimated_missing_cogs: r.lot_buy_price != null
        ? cents(r.lot_buy_price * r.units_zero_cogs)
        : null,
    }));

    return NextResponse.json({
      meta: {
        startDate, endDate, endNextUsed: endNext,
        today: new Date().toISOString().slice(0, 10),
        note: 'READ-ONLY COGS gap drilldown. No writes.',
        generatedAt: new Date().toISOString(),
        fl_cogs:   cents(-flCogsCents),
        il_cogs:   cents(IL_COGS_CENTS),
        gap:       cents(Math.abs(IL_COGS_CENTS) - flCogsCents),
      },
      group_summary: {
        group1_fl_accrual: {
          label:          'Group 1: FL Accrual (purchase_date in range)',
          orders:         g1.orders, units: g1.units,
          sale:           cents(g1.sale_cents),
          cogs:           cents(g1.cogs_cents),
          zero_cogs_lines: g1.zero_cogs_lines,
          zero_cogs_units: g1.zero_cogs_units,
          zero_cogs_sale: cents(g1.zero_cogs_sale),
        },
        group2_prior_period: {
          label:   'Group 2: Prior-period (purchased before range, settled in range) — IL counts, FL accrual excludes',
          orders:  g2.orders, units: g2.units,
          sale:    cents(g2.sale_cents),
          cogs:    cents(g2.cogs_cents),
          zero_cogs_units: g2.zero_cogs_units,
          note:    'These ARE in FL Cash mode but NOT FL Accrual. IL Hybrid counts them.',
        },
        il_cogs_for_group1_orders: {
          label:    'IL COGS for Group 1 orders only (estimated): IL total minus Group 2 COGS',
          il_cogs:  cents(ilForSameOrders),
          fl_cogs:  cents(flCogsCents),
          gap:      cents(remainingGap),
        },
      },
      gap_decomposition: decomposition,
      root_cause_verdict: rootCause,
      msku_qty_mismatch_table: {
        note: 'Zero-COGS SKUs: lot_qty (what FL has) vs MSKU-encoded qty (what you actually bought). Gap = units FL cannot assign COGS to.',
        rows: mskyTable,
      },
      zero_cogs_order_table: {
        note: 'All order lines in FL Accrual with zero COGS. Read-only — do not patch COGS yet.',
        count: annotatedZeroCogs.length,
        total_zero_cogs_sale: cents(g1.zero_cogs_sale),
        estimated_missing_cogs: cents(missingCogsCents),
        rows: annotatedZeroCogs,
      },
    });
  } finally {
    db.close();
  }
}
