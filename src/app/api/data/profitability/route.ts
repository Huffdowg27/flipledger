import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { calculateProfit, calculateROI, calculateMargin } from '@/lib/calculations';
import { parseSupplier } from '@/lib/supplier';
import { isIsoCalendarDate, parseMarketplaceFilter } from '@/lib/request-filters';
import { recognizedCogsExpr, sellableReturnJoin } from '@/lib/cogs-reversal';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  // Derive the sourcing supplier from a SKU in SQL (the suppliers table is unused;
  // supplier is encoded in the SKU). Lets groupBy=supplier reuse all the existing math.
  db.function('supplier_code', { deterministic: true }, (sku: unknown) =>
    parseSupplier(typeof sku === 'string' ? sku : null) ?? 'Unknown');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const groupBy = searchParams.get('groupBy') || 'asin';
  if (!['asin', 'sku', 'supplier', 'category'].includes(groupBy)) {
    return NextResponse.json({ error: 'Invalid group' }, { status: 400 });
  }

  const rawStartDate = searchParams.get('startDate');
  const rawEndDate = searchParams.get('endDate');
  if (
    (rawStartDate !== null && !isIsoCalendarDate(rawStartDate))
    || (rawEndDate !== null && !isIsoCalendarDate(rawEndDate))
    || (rawStartDate !== null && rawEndDate !== null && rawStartDate > rawEndDate)
  ) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  }

  let startDate: string;
  if (rawStartDate) {
    startDate = rawStartDate;
  } else {
    const rawDays = searchParams.get('days') || '30';
    if (!/^\d+$/.test(rawDays)) {
      return NextResponse.json({ error: 'Invalid days' }, { status: 400 });
    }
    const days = Number(rawDays);
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
      return NextResponse.json({ error: 'Invalid days' }, { status: 400 });
    }
    startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  }
  const endDate = rawEndDate || new Date().toISOString().split('T')[0];

  const marketplaceResult = parseMarketplaceFilter(searchParams.get('marketplace'));
  if (!marketplaceResult.ok) {
    return NextResponse.json({ error: 'Invalid marketplace' }, { status: 400 });
  }
  const marketplace = marketplaceResult.marketplace;
  const MF_ORDER = marketplace ? 'AND o.marketplace = ?' : '';
  const MF_REFUND = marketplace ? 'AND r.marketplace = ?' : '';
  const withMarketplace = (...values: string[]): string[] => (
    marketplace ? [...values, marketplace] : values
  );

  const cutoff = startDate + 'T00:00:00Z';

  const endDateNext = new Date(new Date(endDate).getTime() + 86400000).toISOString().split('T')[0];
  const cutoffEnd = endDateNext + 'T00:00:00Z';
  const db = getDb();

  try {
    let itemGroupExpr: string;
    let refundGroupExpr: string;
    let inventoryGroupExpr: string;
    let itemProductNameExpr: string;
    let itemAsinExpr: string;
    let itemCategoryExpr: string;
    let itemSupplierExpr: string;
    let dispositionGroupExpr: string;

    switch (groupBy) {
      case 'sku':
        itemGroupExpr = `COALESCE(NULLIF(oi.sku, ''), 'Unknown')`;
        refundGroupExpr = `COALESCE(NULLIF(rr.resolved_sku, ''), 'Unknown')`;
        inventoryGroupExpr = `COALESCE(NULLIF(li.sku, ''), 'Unknown')`;
        itemProductNameExpr = `COALESCE(p.name, '')`;
        itemAsinExpr = `COALESCE(NULLIF(oi.asin, ''), '')`;
        itemCategoryExpr = `COALESCE(p.category, '')`;
        itemSupplierExpr = `supplier_code(oi.sku)`;
        dispositionGroupExpr = `COALESCE(NULLIF(d.msku, ''), 'Unknown')`;
        break;
      case 'category':
        itemGroupExpr = `COALESCE(NULLIF(p.category, ''), 'Uncategorized')`;
        refundGroupExpr = `COALESCE(NULLIF(rp.category, ''), 'Uncategorized')`;
        inventoryGroupExpr = `COALESCE(NULLIF(p.category, ''), 'Uncategorized')`;
        itemProductNameExpr = `''`;
        itemAsinExpr = `''`;
        itemCategoryExpr = `COALESCE(NULLIF(p.category, ''), 'Uncategorized')`;
        itemSupplierExpr = `''`;
        dispositionGroupExpr = `COALESCE(NULLIF(p.category, ''), 'Uncategorized')`;
        break;
      case 'supplier':
        itemGroupExpr = `supplier_code(oi.sku)`;
        refundGroupExpr = `supplier_code(rr.resolved_sku)`;
        inventoryGroupExpr = `supplier_code(li.sku)`;
        itemProductNameExpr = `''`;
        itemAsinExpr = `''`;
        itemCategoryExpr = `''`;
        itemSupplierExpr = `supplier_code(oi.sku)`;
        dispositionGroupExpr = `supplier_code(d.msku)`;
        break;
      default: // asin
        itemGroupExpr = `COALESCE(NULLIF(oi.asin, ''), 'Unknown')`;
        refundGroupExpr = `COALESCE(NULLIF(rr.resolved_asin, ''), 'Unknown')`;
        inventoryGroupExpr = `COALESCE(NULLIF(li.asin, ''), 'Unknown')`;
        itemProductNameExpr = `COALESCE(p.name, '')`;
        itemAsinExpr = `COALESCE(NULLIF(oi.asin, ''), '')`;
        itemCategoryExpr = `COALESCE(p.category, '')`;
        itemSupplierExpr = `supplier_code(oi.sku)`;
        dispositionGroupExpr = `COALESCE(NULLIF(d.asin, ''), 'Unknown')`;
        break;
    }

    // A single item-level relation feeds revenue, recognized COGS, shipping,
    // and allocated order fees. Grouping only changes the dimension expression,
    // so every grouping must reconcile to the same control totals.
    const rows = db.prepare(`
      WITH product_dim AS (
        SELECT asin, MAX(name) as name, MAX(category) as category
        FROM products
        GROUP BY asin
      ),
      order_dates AS (
        SELECT order_id, MIN(posted_date) as posted_date
        FROM financial_events
        WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL
        GROUP BY order_id
      ),
      eligible_items AS (
        SELECT
          oi.id,
          oi.order_id,
          oi.asin,
          oi.sku,
          oi.quantity,
          oi.total_price,
          oi.shipping_charged,
          oi.shipping_cost,
          oi.cogs_per_unit,
          ${itemGroupExpr} as groupKey,
          ${itemProductNameExpr} as productName,
          ${itemAsinExpr} as displayAsin,
          ${itemCategoryExpr} as category,
          ${itemSupplierExpr} as supplierName
        FROM order_items oi
        JOIN order_dates fe ON oi.order_id = fe.order_id
        JOIN orders o ON oi.order_id = o.order_id
        LEFT JOIN product_dim p ON oi.asin = p.asin
        WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER}
      ),
      order_rollup AS (
        SELECT order_id, SUM(total_price) as orderRevenue, COUNT(*) as itemCount
        FROM eligible_items
        GROUP BY order_id
      ),
      order_fees AS (
        SELECT fd.order_id, COALESCE(-SUM(fd.amount), 0) as totalFee
        FROM fee_details fd
        LEFT JOIN financial_events src ON fd.financial_event_id = src.id
        WHERE fd.order_id IS NOT NULL AND fd.order_id != ''
          AND NOT (src.event_type = 'RefundEvent' AND fd.amount > 0)
        GROUP BY fd.order_id
      )
      SELECT
        ei.groupKey,
        MAX(ei.productName) as productName,
        MAX(ei.displayAsin) as asin,
        MAX(ei.category) as category,
        MAX(ei.supplierName) as supplierName,
        COUNT(DISTINCT ei.order_id) as orders,
        SUM(ei.quantity) as unitsSold,
        SUM(ei.total_price) as revenue,
        COALESCE(SUM(ei.shipping_charged), 0) as shippingCharged,
        COALESCE(SUM(ei.shipping_cost), 0) as shippingCost,
        COALESCE(SUM(${recognizedCogsExpr('ei')}), 0) as totalCogs,
        COALESCE(SUM(
          CASE
            WHEN roll.orderRevenue != 0
              THEN COALESCE(fees.totalFee, 0) * ei.total_price * 1.0 / roll.orderRevenue
            ELSE COALESCE(fees.totalFee, 0) * 1.0 / roll.itemCount
          END
        ), 0) as totalFees
      FROM eligible_items ei
      JOIN order_rollup roll ON roll.order_id = ei.order_id
      LEFT JOIN order_fees fees ON fees.order_id = ei.order_id
      ${sellableReturnJoin('ei')}
      GROUP BY ei.groupKey
      ORDER BY revenue DESC
    `).all(...withMarketplace(cutoff, cutoffEnd)) as any[];

    // Get refund counts per group
    const refundsByGroup = db.prepare(`
      WITH product_dim AS (
        SELECT asin, MAX(category) as category
        FROM products
        GROUP BY asin
      ),
      refund_rows AS (
        SELECT
          r.id,
          r.quantity,
          COALESCE(NULLIF(r.asin, ''), oi.asin) as resolved_asin,
          COALESCE(NULLIF(r.sku, ''), oi.sku) as resolved_sku
        FROM refunds r
        LEFT JOIN order_items oi ON oi.id = (
          SELECT MIN(match.id)
          FROM order_items match
          WHERE match.order_id = r.order_id
            AND (
              (NULLIF(r.sku, '') IS NOT NULL AND match.sku = r.sku)
              OR (NULLIF(r.asin, '') IS NOT NULL AND match.asin = r.asin)
            )
        )
        WHERE r.refund_date >= ? AND r.refund_date < ? ${MF_REFUND}
          AND (
            r.marketplace != 'walmart'
            OR EXISTS (
              SELECT 1 FROM financial_events fe
              WHERE fe.event_type = 'WalmartRefundEvent'
                AND fe.order_id = r.order_id
                AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
            )
          )
      )
      SELECT ${refundGroupExpr} as groupKey,
        COUNT(*) as refundCount,
        SUM(rr.quantity) as refundUnits
      FROM refund_rows rr
      LEFT JOIN product_dim rp ON rr.resolved_asin = rp.asin
      GROUP BY ${refundGroupExpr}
    `).all(...withMarketplace(cutoff, cutoffEnd)) as any[];

    const refundsMap = new Map(refundsByGroup.map((r: any) => [r.groupKey, { count: r.refundCount, units: r.refundUnits }]));

    // Get on-hand inventory per group
    // On-hand = ACTUAL current stock from live_inventory (FBA), valued at lot cost.
    // NOT inventory_ledger.quantity_remaining — that's a COGS cost-reference that
    // includes non-depleting il:* infinite lots and massively overstates stock
    // (matches the dedicated Inventory Valuation report's approach).
    const onHandByGroup = db.prepare(`
      SELECT
        ${inventoryGroupExpr} as groupKey,
        SUM(li.fulfillable_qty + li.inbound_qty) as onHand,
        SUM(li.fulfillable_qty) as warehouse,
        SUM(li.inbound_qty) as inbound,
        SUM(
          CASE WHEN li.sku LIKE 'amzn.gr.%' THEN 0
            ELSE (li.fulfillable_qty + li.inbound_qty) * COALESCE(il_sku.buy_price, il_asin.buy_price, 0)
          END
        ) as onHandValue
      FROM live_inventory li
      LEFT JOIN (SELECT sku, MIN(buy_price) as buy_price FROM inventory_ledger WHERE sku IS NOT NULL AND buy_price > 0 GROUP BY sku) il_sku ON il_sku.sku = li.sku
      LEFT JOIN (SELECT asin, MIN(buy_price) as buy_price FROM inventory_ledger WHERE buy_price > 0 GROUP BY asin) il_asin ON il_asin.asin = li.asin
      LEFT JOIN (
        SELECT asin, MAX(category) as category
        FROM products
        GROUP BY asin
      ) p ON li.asin = p.asin
      WHERE (li.fulfillable_qty + li.inbound_qty) > 0
      GROUP BY ${inventoryGroupExpr}
    `).all() as any[];

    const onHandMap = new Map(onHandByGroup.map((h: any) => [h.groupKey, { onHand: h.onHand, warehouse: h.warehouse, inbound: h.inbound, valueCents: h.onHandValue }]));

    // P&L reduces recognized COGS when a disposition row confirms that an MFN
    // return was restored to sellable inventory. Attribute the same reversal
    // to the selected profitability dimension so every grouping reconciles to
    // the posted-basis P&L COGS control.
    const dispositionReversals = (!marketplace || marketplace === 'amazon')
      ? db.prepare(`
          WITH product_dim AS (
            SELECT asin, MAX(category) AS category
            FROM products
            GROUP BY asin
          )
          SELECT
            ${dispositionGroupExpr} AS groupKey,
            SUM(d.buy_cost_adj) AS cogsReversal
          FROM dispositions d
          LEFT JOIN product_dim p ON p.asin = d.asin
          WHERE d.buy_cost_adj > 0
            AND d.disp_date >= ? AND d.disp_date < ?
          GROUP BY ${dispositionGroupExpr}
        `).all(startDate, endDateNext) as Array<{
          groupKey: string;
          cogsReversal: number;
        }>
      : [];
    const dispositionReversalMap = new Map(
      dispositionReversals.map((row) => [row.groupKey, row.cogsReversal]),
    );
    const consumedDispositionGroups = new Set<string>();

    // Build result rows
    const result = rows.map((row: any) => {
      const fees = row.totalFees || 0;
      const cogsReversal = dispositionReversalMap.get(row.groupKey) || 0;
      consumedDispositionGroups.add(row.groupKey);
      const cogs = (row.totalCogs || 0) - cogsReversal;
      const refunds = refundsMap.get(row.groupKey) || { count: 0, units: 0 };
      const onHand = onHandMap.get(row.groupKey) || { onHand: 0, warehouse: 0, inbound: 0, valueCents: 0 };
      const shippingCost = row.shippingCost || 0;
      const shippingCharged = row.shippingCharged || 0;
      const profit = calculateProfit(row.revenue + shippingCharged, cogs, fees, shippingCost);
      const roi = calculateROI(profit, cogs);
      const margin = calculateMargin(profit, row.revenue + shippingCharged);

      return {
        groupKey: row.groupKey || 'Unknown',
        productName: row.productName || '',
        asin: row.asin || '',
        category: row.category || '',
        supplierName: row.supplierName || '',
        orders: row.orders,
        unitsSold: row.unitsSold,
        unitsPerOrder: row.orders > 0 ? row.unitsSold / row.orders : 0,
        refunds: refunds.count,
        unitsPerRefund: refunds.count > 0 ? refunds.units / refunds.count : 0,
        revenue: row.revenue,
        fees,
        cogs,
        shippingCost,
        costPerUnit: row.unitsSold > 0 ? cogs / row.unitsSold : 0,
        profit,
        roi,
        margin,
        onHand: onHand.onHand,
        warehouse: onHand.warehouse || 0,
        inbound: onHand.inbound || 0,
        onHandValueCents: onHand.valueCents || 0,
        shippingCharged: row.shippingCharged,
      };
    });

    // A returned/restocked SKU may have no sale inside the selected window.
    // Preserve its reversal as an adjustment-only row instead of silently
    // dropping it from the total.
    for (const row of dispositionReversals) {
      if (consumedDispositionGroups.has(row.groupKey)) continue;
      result.push({
        groupKey: row.groupKey,
        productName: '',
        asin: '',
        category: '',
        supplierName: '',
        orders: 0,
        unitsSold: 0,
        unitsPerOrder: 0,
        refunds: 0,
        unitsPerRefund: 0,
        revenue: 0,
        fees: 0,
        cogs: -row.cogsReversal,
        shippingCost: 0,
        costPerUnit: 0,
        profit: row.cogsReversal,
        roi: 0,
        margin: 0,
        onHand: 0,
        warehouse: 0,
        inbound: 0,
        onHandValueCents: 0,
        shippingCharged: 0,
      });
    }

    // Totals
    const totals = result.reduce((acc: any, r: any) => {
      acc.unitsSold += r.unitsSold;
      acc.revenue += r.revenue;
      acc.fees += r.fees;
      acc.cogs += r.cogs;
      acc.shippingCost += r.shippingCost;
      acc.shippingCharged += r.shippingCharged;
      acc.profit += r.profit;
      acc.refunds += r.refunds;
      acc.onHand += r.onHand;
      acc.warehouse += r.warehouse;
      acc.inbound += r.inbound;
      acc.onHandValueCents += r.onHandValueCents;
      return acc;
    }, { orders: 0, unitsSold: 0, revenue: 0, fees: 0, cogs: 0, shippingCost: 0, shippingCharged: 0, profit: 0, refunds: 0, onHand: 0, warehouse: 0, inbound: 0, onHandValueCents: 0 });

    // An order can contain multiple groups, so summing row-level distinct-order
    // counts overstates the total. Calculate the period control independently.
    totals.orders = (db.prepare(`
      SELECT COUNT(DISTINCT oi.order_id) as orders
      FROM order_items oi
      JOIN (
        SELECT order_id, MIN(posted_date) as posted_date
        FROM financial_events
        WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL
        GROUP BY order_id
      ) fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF_ORDER}
    `).get(...withMarketplace(cutoff, cutoffEnd)) as any).orders;
    totals.refunds = (db.prepare(`
      SELECT COUNT(*) as refunds
      FROM refunds r
      WHERE r.refund_date >= ? AND r.refund_date < ? ${MF_REFUND}
        AND (
          r.marketplace != 'walmart'
          OR EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.event_type = 'WalmartRefundEvent'
              AND fe.order_id = r.order_id
              AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
          )
        )
    `).get(...withMarketplace(cutoff, cutoffEnd)) as any).refunds;

    totals.roi = totals.cogs > 0 ? (totals.profit / totals.cogs) * 100 : 0;
    const contributionRevenue = totals.revenue + totals.shippingCharged;
    totals.margin = contributionRevenue > 0 ? (totals.profit / contributionRevenue) * 100 : 0;
    totals.costPerUnit = totals.unitsSold > 0 ? totals.cogs / totals.unitsSold : 0;

    // On-hand summary cards reflect TOTAL current inventory (independent of the
    // selected grouping / sales period) so they're consistent across every tab.
    // Includes BOTH FBA stock (live_inventory) AND merchant-fulfilled stock
    // (merchant_listings) — the latter isn't in live_inventory, so no double-count.
    const inv = db.prepare(`
      SELECT
        COALESCE(SUM(onHand), 0) as onHand,
        COALESCE(SUM(warehouse), 0) as warehouse,
        COALESCE(SUM(inbound), 0) as inbound,
        COALESCE(SUM(valueCents), 0) as valueCents
      FROM (
        SELECT
          (li.fulfillable_qty + li.inbound_qty) as onHand,
          li.fulfillable_qty as warehouse,
          li.inbound_qty as inbound,
          CASE WHEN li.sku LIKE 'amzn.gr.%' THEN 0
            ELSE (li.fulfillable_qty + li.inbound_qty) * COALESCE(il_sku.buy_price, il_asin.buy_price, 0)
          END as valueCents
        FROM live_inventory li
        LEFT JOIN (SELECT sku, MIN(buy_price) as buy_price FROM inventory_ledger WHERE sku IS NOT NULL AND buy_price > 0 GROUP BY sku) il_sku ON il_sku.sku = li.sku
        LEFT JOIN (SELECT asin, MIN(buy_price) as buy_price FROM inventory_ledger WHERE buy_price > 0 GROUP BY asin) il_asin ON il_asin.asin = li.asin
        WHERE (li.fulfillable_qty + li.inbound_qty) > 0
        UNION ALL
        SELECT
          ml.quantity as onHand,
          ml.quantity as warehouse,
          0 as inbound,
          CASE WHEN ml.sku LIKE 'amzn.gr.%' THEN 0
            ELSE ml.quantity * COALESCE(il_sku.buy_price, il_asin.buy_price, 0)
          END as valueCents
        FROM merchant_listings ml
        LEFT JOIN (SELECT sku, MIN(buy_price) as buy_price FROM inventory_ledger WHERE sku IS NOT NULL AND buy_price > 0 GROUP BY sku) il_sku ON il_sku.sku = ml.sku
        LEFT JOIN (SELECT asin, MIN(buy_price) as buy_price FROM inventory_ledger WHERE buy_price > 0 GROUP BY asin) il_asin ON il_asin.asin = ml.asin
        WHERE ml.fulfillment_channel = 'DEFAULT' AND ml.quantity > 0
      )
    `).get() as any;
    totals.onHand = inv.onHand;
    totals.warehouse = inv.warehouse;
    totals.inbound = inv.inbound;
    totals.onHandValueCents = inv.valueCents;

    db.close();

    return NextResponse.json({ rows: result, totals });
  } catch (error) {
    db.close();
    console.error('Profitability API error:', error);
    return NextResponse.json({ error: 'Failed to load profitability data' }, { status: 500 });
  }
}
