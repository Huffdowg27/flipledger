import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const db = getDb();

  const marketplace = searchParams.get('marketplace');
  const MF = marketplace ? `AND li.marketplace = '${marketplace}'` : '';

  try {
    // Use live_inventory (from API sync) joined to inventory_ledger (for COGS)
    const rows = db.prepare(`
      SELECT
        li.asin,
        li.sku,
        li.marketplace,
        COALESCE(p.name, li.product_name, li.asin) as productName,
        COALESCE(p.category, 'Uncategorized') as category,
        li.fulfillable_qty as quantityOnHand,
        li.inbound_qty as inboundQty,
        li.reserved_qty as reservedQty,
        li.unfulfillable_qty as unfulfillableQty,
        li.total_qty as totalQty,
        COALESCE(li.inbound_working, 0) as inboundWorking,
        COALESCE(li.inbound_shipped, 0) as inboundShipped,
        COALESCE(li.inbound_receiving, 0) as inboundReceiving,
        COALESCE(li.reserved_customer_order, 0) as reservedCustomerOrder,
        COALESCE(li.reserved_fc_transfer, 0) as reservedFcTransfer,
        COALESCE(li.reserved_fc_processing, 0) as reservedFcProcessing,
        COALESCE(li.list_price, 0) as customListPrice,
        li.walmart_item_id as walmartItemId,
        COALESCE(il.buy_price, 0) as cogsPerUnit,
        COALESCE(il.buy_price * li.total_qty, 0) as totalCogsValue,
        li.last_updated
      FROM live_inventory li
      LEFT JOIN inventory_ledger il ON (li.sku = il.sku OR li.asin = il.asin)
      LEFT JOIN products p ON li.asin = p.asin
      WHERE li.total_qty > 0 ${MF}
      GROUP BY li.asin, li.sku, li.marketplace
      ORDER BY totalCogsValue DESC
    `).all() as any[];

    // Get average sale price AND fee rate per ASIN
    // For single-item orders: use order-level fees directly
    // For multi-item orders: allocate proportionally by revenue
    const avgData = db.prepare(`
      SELECT oi.asin,
        AVG(oi.price_per_unit) as avgPrice,
        CASE WHEN SUM(oi.total_price) > 0
          THEN SUM(
            CASE WHEN item_count.cnt = 1
              THEN COALESCE(order_fees.total_fee, 0)
              ELSE COALESCE(order_fees.total_fee * oi.total_price * 1.0 / NULLIF(order_totals.order_revenue, 0), 0)
            END
          ) * 1.0 / SUM(oi.total_price)
          ELSE 0.15
        END as feeRate
      FROM order_items oi
      LEFT JOIN (
        SELECT order_id, SUM(ABS(amount)) as total_fee
        FROM fee_details WHERE order_id IS NOT NULL AND order_id != ''
          AND amount < 0
        GROUP BY order_id
      ) order_fees ON oi.order_id = order_fees.order_id
      LEFT JOIN (
        SELECT order_id, SUM(total_price) as order_revenue
        FROM order_items GROUP BY order_id
      ) order_totals ON oi.order_id = order_totals.order_id
      LEFT JOIN (
        SELECT order_id, COUNT(*) as cnt FROM order_items GROUP BY order_id
      ) item_count ON oi.order_id = item_count.order_id
      GROUP BY oi.asin
    `).all() as any[];
    const priceMap: Record<string, number> = {};
    const feeRateMap: Record<string, number> = {};
    for (const row of avgData) {
      priceMap[row.asin] = row.avgPrice;
      feeRateMap[row.asin] = row.feeRate;
    }

    // Sales rank: latest + 7d-ago + 30d-ago per ASIN. One query, indexed on asin.
    const rankRows = db.prepare(`
      SELECT asin, rank, category, captured_date
      FROM sales_rank_history
      WHERE marketplace = 'amazon'
      ORDER BY asin, captured_date DESC
    `).all() as Array<{ asin: string; rank: number | null; category: string | null; captured_date: string }>;
    const rankMap: Record<string, { current: number | null; category: string | null; capturedDate: string | null; rank7d: number | null; rank30d: number | null }> = {};
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    for (const r of rankRows) {
      if (!rankMap[r.asin]) {
        rankMap[r.asin] = { current: r.rank, category: r.category, capturedDate: r.captured_date, rank7d: null, rank30d: null };
      }
      const m = rankMap[r.asin];
      if (m.rank7d === null && r.captured_date <= sevenDaysAgo) m.rank7d = r.rank;
      if (m.rank30d === null && r.captured_date <= thirtyDaysAgo) m.rank30d = r.rank;
    }

    const items = rows.map((row) => {
      const listPrice = row.customListPrice || priceMap[row.asin] || priceMap[row.sku] || 0;
      const feeRate = feeRateMap[row.asin] || feeRateMap[row.sku] || 0.15; // default 15%
      const hasSalesHistory = listPrice > 0;
      const expectedRevenue = hasSalesHistory ? listPrice * row.totalQty : 0;
      const estimatedFees = hasSalesHistory ? Math.round(expectedRevenue * feeRate) : 0;
      const expectedProfit = hasSalesHistory ? expectedRevenue - row.totalCogsValue - estimatedFees : 0;
      const expectedRoi = (hasSalesHistory && row.totalCogsValue > 0) ? (expectedProfit / row.totalCogsValue) * 100 : 0;
      const rankInfo = rankMap[row.asin] || { current: null, category: null, capturedDate: null, rank7d: null, rank30d: null };
      const rankDelta7d = (rankInfo.current !== null && rankInfo.rank7d !== null) ? rankInfo.current - rankInfo.rank7d : null;
      const rankDelta30d = (rankInfo.current !== null && rankInfo.rank30d !== null) ? rankInfo.current - rankInfo.rank30d : null;
      return {
        asin: row.asin,
        sku: row.sku,
        marketplace: row.marketplace,
        productName: row.productName,
        category: row.category,
        salesRank: rankInfo.current,
        salesRankCategory: rankInfo.category,
        salesRankCapturedDate: rankInfo.capturedDate,
        rankDelta7d,
        rankDelta30d,
        quantityOnHand: row.quantityOnHand,
        inboundQty: row.inboundQty,
        reservedQty: row.reservedQty,
        unfulfillableQty: row.unfulfillableQty,
        totalQty: row.totalQty,
        inboundWorking: row.inboundWorking,
        inboundShipped: row.inboundShipped,
        inboundReceiving: row.inboundReceiving,
        reservedCustomerOrder: row.reservedCustomerOrder,
        reservedFcTransfer: row.reservedFcTransfer,
        reservedFcProcessing: row.reservedFcProcessing,
        cogsPerUnit: row.cogsPerUnit,
        totalCogsValue: row.totalCogsValue,
        listPrice,
        feeRate: Math.round(feeRate * 1000) / 10, // as percentage
        estimatedFees,
        walmartItemId: row.walmartItemId || null,
        hasSalesHistory,
        expectedRevenue,
        expectedProfit,
        expectedRoi,
      };
    });

    const totalUnits = items.reduce((s, i) => s + i.quantityOnHand, 0);
    const totalCogsValue = items.reduce((s, i) => s + i.totalCogsValue, 0);
    const totalExpectedRevenue = items.reduce((s, i) => s + i.expectedRevenue, 0);
    const totalExpectedProfit = items.reduce((s, i) => s + i.expectedProfit, 0);

    db.close();

    return NextResponse.json({
      items,
      totals: {
        totalUnits,
        totalCogsValue,
        totalExpectedRevenue,
        totalExpectedProfit,
      },
    });
  } catch (error) {
    db.close();
    console.error('Inventory Valuation API error:', error);
    return NextResponse.json({ error: 'Failed to load inventory valuation data' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { sku, asin, listPrice } = body;

  if (!sku && !asin) {
    return NextResponse.json({ error: 'SKU or ASIN required' }, { status: 400 });
  }

  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  try {
    if (listPrice !== undefined) {
      const priceCents = Math.round((listPrice || 0) * 100);
      db.prepare('UPDATE live_inventory SET list_price = ? WHERE sku = ? OR asin = ?')
        .run(priceCents, sku || '', asin || '');
    }

    // Allow manually setting MFN inventory quantity
    if (body.quantity !== undefined) {
      const qty = parseInt(body.quantity) || 0;
      const existing = db.prepare("SELECT id FROM live_inventory WHERE sku = ? AND marketplace = ?")
        .get(sku || '', body.marketplace || 'amazon') as any;

      if (existing) {
        db.prepare('UPDATE live_inventory SET fulfillable_qty = ?, last_updated = ? WHERE id = ?')
          .run(qty, new Date().toISOString(), existing.id);
      } else {
        db.prepare(`
          INSERT INTO live_inventory (asin, sku, marketplace, fulfillable_qty, inbound_qty, reserved_qty, unfulfillable_qty, product_name, last_updated)
          VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)
        `).run(asin || sku, sku, body.marketplace || 'amazon', qty, body.productName || '', new Date().toISOString());
      }
    }

    db.close();
    return NextResponse.json({ success: true });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
