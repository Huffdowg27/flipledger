import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { parseMarketplaceFilter } from '@/lib/request-filters';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const marketplaceResult = parseMarketplaceFilter(searchParams.get('marketplace'));
  if (!marketplaceResult.ok) {
    return NextResponse.json({ error: 'Invalid marketplace' }, { status: 400 });
  }
  const marketplace = marketplaceResult.marketplace;
  const marketplaceClause = marketplace ? 'AND li.marketplace = ?' : '';

  const db = getDb();
  try {
    // FBA comes from live_inventory. MFN comes from merchant_listings only when
    // the SKU is absent from live_inventory, then values the local open lots.
    // This keeps a SKU in exactly one population.
    const rows = db.prepare(`
      WITH
      fba_skus AS (
        SELECT DISTINCT sku
        FROM live_inventory
        WHERE sku IS NOT NULL AND sku != ''
      ),
      open_lots AS (
        SELECT
          sku,
          MAX(asin) as asin,
          SUM(quantity_remaining) as quantityOnHand,
          SUM(quantity_remaining * buy_price) as totalCogsValue,
          CASE
            WHEN SUM(quantity_remaining) > 0
            THEN ROUND(SUM(quantity_remaining * buy_price) * 1.0 / SUM(quantity_remaining))
            ELSE 0
          END as cogsPerUnit
        FROM inventory_ledger
        WHERE sku IS NOT NULL
          AND sku != ''
          AND quantity_remaining > 0
        GROUP BY sku
      )
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
        CASE WHEN li.sku LIKE 'amzn.gr.%' THEN 0
          ELSE COALESCE(il_sku.buy_price, il_asin.buy_price, 0) END as cogsPerUnit,
        CASE WHEN li.sku LIKE 'amzn.gr.%' THEN 0
          ELSE COALESCE(il_sku.buy_price, il_asin.buy_price, 0) * (li.fulfillable_qty + li.inbound_qty)
        END as totalCogsValue,
        'FBA' as channel,
        li.last_updated
      FROM live_inventory li
      LEFT JOIN (
        SELECT sku, buy_price FROM inventory_ledger
        WHERE sku IS NOT NULL AND sku != ''
        GROUP BY sku
      ) il_sku ON il_sku.sku = li.sku
      LEFT JOIN (
        SELECT asin, buy_price FROM inventory_ledger
        WHERE (sku IS NULL OR sku = '')
        GROUP BY asin
      ) il_asin ON il_asin.asin = li.asin AND (li.sku IS NULL OR li.sku = '')
      LEFT JOIN products p ON li.asin = p.asin
      WHERE li.total_qty > 0 ${marketplaceClause}
      UNION ALL
      SELECT
        ml.asin,
        ml.sku,
        ml.marketplace,
        COALESCE(p.name, ml.product_name, ml.asin) as productName,
        COALESCE(p.category, 'Uncategorized') as category,
        ol.quantityOnHand,
        0 as inboundQty,
        0 as reservedQty,
        0 as unfulfillableQty,
        ol.quantityOnHand as totalQty,
        0 as inboundWorking,
        0 as inboundShipped,
        0 as inboundReceiving,
        0 as reservedCustomerOrder,
        0 as reservedFcTransfer,
        0 as reservedFcProcessing,
        COALESCE(ml.list_price_cents, 0) as customListPrice,
        NULL as walmartItemId,
        CASE WHEN ml.sku LIKE 'amzn.gr.%' THEN 0 ELSE ol.cogsPerUnit END as cogsPerUnit,
        CASE WHEN ml.sku LIKE 'amzn.gr.%' THEN 0 ELSE ol.totalCogsValue END as totalCogsValue,
        'MFN' as channel,
        ml.last_synced as last_updated
      FROM merchant_listings ml
      JOIN open_lots ol ON ol.sku = ml.sku
      LEFT JOIN fba_skus fs ON fs.sku = ml.sku
      LEFT JOIN products p ON ml.asin = p.asin
      WHERE ml.marketplace = 'amazon'
        AND fs.sku IS NULL
        AND UPPER(COALESCE(ml.fulfillment_channel, 'DEFAULT')) = 'DEFAULT'
        ${marketplace ? 'AND ml.marketplace = ?' : ''}
      ORDER BY totalCogsValue DESC
    `).all(...(marketplace ? [marketplace, marketplace] : [])) as any[];

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
        channel: row.channel as 'FBA' | 'MFN',
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

    const subtotal = (rows: typeof items) => ({
      totalUnits: rows.reduce((s, i) => s + i.quantityOnHand, 0),
      totalCogsValue: rows.reduce((s, i) => s + i.totalCogsValue, 0),
      totalExpectedRevenue: rows.reduce((s, i) => s + i.expectedRevenue, 0),
      totalExpectedProfit: rows.reduce((s, i) => s + i.expectedProfit, 0),
    });
    const totals = subtotal(items);
    const fba = subtotal(items.filter((i) => i.channel === 'FBA'));
    const mfn = subtotal(items.filter((i) => i.channel === 'MFN'));

    db.close();

    return NextResponse.json({
      items,
      totals: { ...totals, fba, mfn },
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
  db.pragma('busy_timeout = 15000');
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
