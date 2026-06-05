import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { parseSupplier } from '@/lib/supplier';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
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

  const db = getDb();

  let startDate = searchParams.get('startDate');
  let endDate = searchParams.get('endDate');
  if (!startDate) {
    const days = parseInt(searchParams.get('days') || '30');
    startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  }
  if (!endDate) {
    endDate = new Date().toISOString().split('T')[0];
  }
  const cutoff = startDate + 'T00:00:00Z';
  const marketplace = searchParams.get('marketplace');
  const MF = marketplace ? `AND o.marketplace = '${marketplace}'` : '';
  const MF_R = marketplace ? `AND marketplace = '${marketplace}'` : '';

  const endDateNext = new Date(new Date(endDate).getTime() + 86400000).toISOString().split('T')[0];
  const cutoffEnd = endDateNext + 'T00:00:00Z';

  try {
    let groupCol: string;
    let selectCols: string;
    let joinClause: string;
    let groupByClause: string;

    switch (groupBy) {
      case 'sku':
        groupCol = 'oi.sku';
        selectCols = `oi.sku as groupKey, p.name as productName, oi.asin, p.category, s.name as supplierName`;
        joinClause = `LEFT JOIN products p ON oi.asin = p.asin
          LEFT JOIN inventory_ledger il_s ON oi.sku = il_s.sku
          LEFT JOIN suppliers s ON il_s.supplier_id = s.id`;
        groupByClause = 'oi.sku';
        break;
      case 'category':
        groupCol = 'p.category';
        selectCols = `COALESCE(p.category, 'Uncategorized') as groupKey, '' as productName, '' as asin, '' as supplierName`;
        joinClause = `LEFT JOIN products p ON oi.asin = p.asin`;
        groupByClause = 'p.category';
        break;
      case 'supplier':
        // Supplier is encoded in the SKU; derive it with the supplier_code() helper.
        groupCol = 'supplier_code(oi.sku)';
        selectCols = `supplier_code(oi.sku) as groupKey, '' as productName, '' as asin, '' as category`;
        joinClause = ``;
        groupByClause = 'supplier_code(oi.sku)';
        break;
      default: // asin
        groupCol = 'oi.asin';
        selectCols = `oi.asin as groupKey, p.name as productName, oi.asin, p.category, s.name as supplierName`;
        joinClause = `LEFT JOIN products p ON oi.asin = p.asin
          LEFT JOIN (SELECT asin, MIN(supplier_id) as supplier_id FROM inventory_ledger GROUP BY asin) il_a ON oi.asin = il_a.asin
          LEFT JOIN suppliers s ON il_a.supplier_id = s.id`;
        groupByClause = 'oi.asin';
        break;
    }

    const rows = db.prepare(`
      SELECT
        ${selectCols},
        COUNT(DISTINCT o.order_id) as orders,
        SUM(oi.quantity) as unitsSold,
        SUM(oi.total_price) as revenue,
        COALESCE(SUM(oi.shipping_charged), 0) as shippingCharged,
        COALESCE(SUM(oi.shipping_cost), 0) as shippingCost
      FROM order_items oi
      JOIN (SELECT order_id, MIN(posted_date) as posted_date FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id) fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      ${joinClause}
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
      GROUP BY ${groupByClause}
      ORDER BY SUM(oi.total_price) DESC
    `).all(cutoff, cutoffEnd) as any[];

    // Get fees per order first, then distribute to SKUs/ASINs
    // This avoids cross-product multiplication from joining fee_details to order_items
    const feeGroupKey = groupBy === 'sku' ? 'oi.sku' : groupBy === 'category' ? 'p.category' : groupBy === 'supplier' ? 'supplier_code(oi.sku)' : 'oi.asin';
    const feesByGroup = db.prepare(`
      SELECT
        ${feeGroupKey} as groupKey,
        COALESCE(SUM(order_fees.total_fee * oi.total_price * 1.0 / order_totals.order_revenue), 0) as totalFees
      FROM order_items oi
      JOIN (SELECT order_id, MIN(posted_date) as posted_date FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id) fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      JOIN (
        SELECT order_id, SUM(ABS(amount)) as total_fee
        FROM fee_details WHERE order_id IS NOT NULL AND order_id != ''
        GROUP BY order_id
      ) order_fees ON oi.order_id = order_fees.order_id
      JOIN (
        SELECT order_id, SUM(total_price) as order_revenue
        FROM order_items GROUP BY order_id
      ) order_totals ON oi.order_id = order_totals.order_id AND order_totals.order_revenue > 0
      ${groupBy === 'category' ? 'LEFT JOIN products p ON oi.asin = p.asin' : ''}
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
      GROUP BY ${feeGroupKey}
    `).all(cutoff, cutoffEnd) as any[];

    const feesMap = new Map(feesByGroup.map((f: any) => [f.groupKey, f.totalFees]));

    // Add per-ASIN storage fees directly from the storage fee report
    // Each ASIN's monthly_fee represents what Amazon charges for storing that specific product
    const hasStorageFees = db.prepare('SELECT COUNT(*) as cnt FROM storage_fees_per_asin').get() as any;
    if (hasStorageFees?.cnt > 0) {
      for (const row of rows) {
        const groupKey = row.groupKey || 'Unknown';
        const currentFees = feesMap.get(groupKey) || 0;
        // Look up storage fee by ASIN
        const storageFee = db.prepare(
          'SELECT monthly_fee FROM storage_fees_per_asin WHERE asin = ?'
        ).get(row.asin || groupKey) as any;
        if (storageFee?.monthly_fee) {
          // Add the monthly storage fee (this is per-ASIN total, not per-unit)
          feesMap.set(groupKey, currentFees + storageFee.monthly_fee);
        }
      }
    }

    // Get COGS per group — uses FIFO pre-calculated cogs_per_unit
    const cogsGroupKey = groupBy === 'sku' ? 'oi.sku' : groupBy === 'category' ? 'p.category' : groupBy === 'supplier' ? 'supplier_code(oi.sku)' : 'oi.asin';
    const cogsByGroup = db.prepare(`
      SELECT
        ${cogsGroupKey} as groupKey,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as totalCogs
      FROM order_items oi
      JOIN (SELECT order_id, MIN(posted_date) as posted_date FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id) fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      ${groupBy === 'category' ? 'LEFT JOIN products p ON oi.asin = p.asin' : ''}
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
      GROUP BY ${cogsGroupKey}
    `).all(cutoff, cutoffEnd) as any[];

    const cogsMap = new Map(cogsByGroup.map((c: any) => [c.groupKey, c.totalCogs]));

    // Get refund counts per group
    const refundsByGroup = db.prepare(`
      SELECT ${groupBy === 'category' ? 'p.category' : groupBy === 'supplier' ? 'supplier_code(r.sku)' : 'r.asin'} as groupKey,
        COUNT(*) as refundCount,
        SUM(r.quantity) as refundUnits
      FROM refunds r
      ${groupBy === 'category' ? 'LEFT JOIN products p ON r.asin = p.asin' : ''}
      WHERE r.refund_date >= ? AND r.refund_date < ?
      GROUP BY ${groupBy === 'category' ? 'p.category' : groupBy === 'supplier' ? 'supplier_code(r.sku)' : 'r.asin'}
    `).all(cutoff, cutoffEnd) as any[];

    const refundsMap = new Map(refundsByGroup.map((r: any) => [r.groupKey, { count: r.refundCount, units: r.refundUnits }]));

    // Get on-hand inventory per group
    // On-hand = ACTUAL current stock from live_inventory (FBA), valued at lot cost.
    // NOT inventory_ledger.quantity_remaining — that's a COGS cost-reference that
    // includes non-depleting il:* infinite lots and massively overstates stock
    // (matches the dedicated Inventory Valuation report's approach).
    const onHandGroupKey = groupBy === 'sku' ? 'li.sku' : groupBy === 'category' ? 'p.category' : groupBy === 'supplier' ? 'supplier_code(li.sku)' : 'li.asin';
    const onHandByGroup = db.prepare(`
      SELECT
        ${onHandGroupKey} as groupKey,
        SUM(li.fulfillable_qty + li.inbound_qty) as onHand,
        SUM(li.fulfillable_qty) as warehouse,
        SUM(li.inbound_qty) as inbound,
        SUM((li.fulfillable_qty + li.inbound_qty) * COALESCE(il_sku.buy_price, il_asin.buy_price, 0)) as onHandValue
      FROM live_inventory li
      LEFT JOIN (SELECT sku, MIN(buy_price) as buy_price FROM inventory_ledger WHERE sku IS NOT NULL AND buy_price > 0 GROUP BY sku) il_sku ON il_sku.sku = li.sku
      LEFT JOIN (SELECT asin, MIN(buy_price) as buy_price FROM inventory_ledger WHERE buy_price > 0 GROUP BY asin) il_asin ON il_asin.asin = li.asin
      ${groupBy === 'category' ? 'LEFT JOIN products p ON li.asin = p.asin' : ''}
      WHERE (li.fulfillable_qty + li.inbound_qty) > 0
      GROUP BY ${onHandGroupKey}
    `).all() as any[];

    const onHandMap = new Map(onHandByGroup.map((h: any) => [h.groupKey, { onHand: h.onHand, warehouse: h.warehouse, inbound: h.inbound, valueCents: h.onHandValue }]));

    // Build result rows
    const result = rows.map((row: any) => {
      const fees = feesMap.get(row.groupKey) || 0;
      const cogs = cogsMap.get(row.groupKey) || 0;
      const refunds = refundsMap.get(row.groupKey) || { count: 0, units: 0 };
      const onHand = onHandMap.get(row.groupKey) || { onHand: 0, warehouse: 0, inbound: 0, valueCents: 0 };
      const shippingCost = row.shippingCost || 0;
      const shippingCharged = row.shippingCharged || 0;
      const profit = row.revenue + shippingCharged - cogs - fees - shippingCost;
      const roi = cogs > 0 ? (profit / cogs) * 100 : 0;
      const margin = row.revenue > 0 ? (profit / row.revenue) * 100 : 0;

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

    // Totals
    const totals = result.reduce((acc: any, r: any) => {
      acc.orders += r.orders;
      acc.unitsSold += r.unitsSold;
      acc.revenue += r.revenue;
      acc.fees += r.fees;
      acc.cogs += r.cogs;
      acc.shippingCost += r.shippingCost;
      acc.profit += r.profit;
      acc.refunds += r.refunds;
      acc.onHand += r.onHand;
      acc.warehouse += r.warehouse;
      acc.inbound += r.inbound;
      acc.onHandValueCents += r.onHandValueCents;
      return acc;
    }, { orders: 0, unitsSold: 0, revenue: 0, fees: 0, cogs: 0, shippingCost: 0, profit: 0, refunds: 0, onHand: 0, warehouse: 0, inbound: 0, onHandValueCents: 0 });

    totals.roi = totals.cogs > 0 ? (totals.profit / totals.cogs) * 100 : 0;
    totals.margin = totals.revenue > 0 ? (totals.profit / totals.revenue) * 100 : 0;
    totals.costPerUnit = totals.unitsSold > 0 ? totals.cogs / totals.unitsSold : 0;

    // On-hand summary cards reflect TOTAL current inventory (independent of the
    // selected grouping / sales period) so they're consistent across every tab.
    const inv = db.prepare(`
      SELECT
        COALESCE(SUM(li.fulfillable_qty + li.inbound_qty), 0) as onHand,
        COALESCE(SUM(li.fulfillable_qty), 0) as warehouse,
        COALESCE(SUM(li.inbound_qty), 0) as inbound,
        COALESCE(SUM((li.fulfillable_qty + li.inbound_qty) * COALESCE(il_sku.buy_price, il_asin.buy_price, 0)), 0) as valueCents
      FROM live_inventory li
      LEFT JOIN (SELECT sku, MIN(buy_price) as buy_price FROM inventory_ledger WHERE sku IS NOT NULL AND buy_price > 0 GROUP BY sku) il_sku ON il_sku.sku = li.sku
      LEFT JOIN (SELECT asin, MIN(buy_price) as buy_price FROM inventory_ledger WHERE buy_price > 0 GROUP BY asin) il_asin ON il_asin.asin = li.asin
      WHERE (li.fulfillable_qty + li.inbound_qty) > 0
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
