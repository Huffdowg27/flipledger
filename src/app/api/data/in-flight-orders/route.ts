import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

const DDP_DAYS = 10;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const db = getDb();
  const marketplace = searchParams.get('marketplace') || 'amazon';

  try {
    const recentCutoff = new Date(Date.now() - 14 * 86400000).toISOString();

    // Shipped, awaiting settlement (last 14 days, no ShipmentEvent yet).
    // Defense-in-depth: if cogs_per_unit is 0 (FIFO lot depleted), fall back to
    // the latest inventory_ledger.buy_price for this SKU. Doesn't change historical P&L
    // — this only affects the projection shown on the dashboard drill.
    const rows = db.prepare(`
      SELECT
        o.order_id,
        o.purchase_date,
        o.shipped_at,
        o.fulfillment_channel,
        oi.asin,
        oi.sku,
        oi.quantity,
        oi.price_per_unit,
        oi.shipping_charged,
        oi.shipping_cost,
        oi.cogs_per_unit,
        (oi.price_per_unit * oi.quantity + COALESCE(oi.shipping_charged, 0)) AS revenue,
        (oi.cogs_per_unit * oi.quantity) AS cogs,
        (SELECT buy_price FROM inventory_ledger il WHERE il.sku = oi.sku ORDER BY il.id DESC LIMIT 1) AS fallback_buy_price,
        COALESCE(p.name, li.product_name, oi.sku) AS product_name
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      LEFT JOIN (
        SELECT order_id FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id
      ) fe ON fe.order_id = o.order_id
      LEFT JOIN products p ON p.asin = oi.asin
      LEFT JOIN live_inventory li ON li.sku = oi.sku
      WHERE o.status IN ('Shipped', 'PartiallyShipped')
        AND fe.order_id IS NULL
        AND o.purchase_date >= ?
        AND o.marketplace = ?
      ORDER BY COALESCE(o.shipped_at, o.purchase_date) ASC, o.order_id
    `).all(recentCutoff, marketplace) as any[];

    const items = rows.map(r => {
      const shipBase = r.shipped_at || r.purchase_date;
      const expectedRelease = new Date(new Date(shipBase).getTime() + DDP_DAYS * 86400000).toISOString();
      // COGS fallback: if FIFO returned 0 and we know the last buy_price for this SKU, use it.
      let cogs = r.cogs;
      let cogsSource: 'fifo' | 'fallback' | 'missing' = 'fifo';
      if (cogs === 0 && r.fallback_buy_price > 0) {
        cogs = r.fallback_buy_price * r.quantity;
        cogsSource = 'fallback';
      } else if (cogs === 0) {
        cogsSource = 'missing';
      }
      // MFN orders: subtract out-of-pocket shipping if known
      const mfnShipping = r.shipping_cost || 0;
      // Estimate fees at 13% of revenue (slightly above 12.6% historical for conservatism)
      const estimatedFees = Math.round(r.revenue * 0.13);
      const projectedProfit = r.revenue - cogs - estimatedFees - mfnShipping;
      const daysHeld = Math.floor((Date.now() - new Date(shipBase).getTime()) / 86400000);
      const daysUntilRelease = Math.max(0, DDP_DAYS - daysHeld);
      return {
        orderId: r.order_id,
        productName: r.product_name,
        asin: r.asin,
        sku: r.sku,
        quantity: r.quantity,
        fulfillment: r.fulfillment_channel,
        purchaseDate: r.purchase_date,
        shippedAt: r.shipped_at,
        expectedRelease,
        daysHeld,
        daysUntilRelease,
        revenue: r.revenue,
        cogs,
        cogsSource,
        estimatedFees,
        mfnShipping,
        projectedProfit,
      };
    });

    db.close();

    return NextResponse.json({
      items,
      summary: {
        orders: items.length,
        revenue: items.reduce((s, i) => s + i.revenue, 0),
        cogs: items.reduce((s, i) => s + i.cogs, 0),
        estimatedFees: items.reduce((s, i) => s + i.estimatedFees, 0),
        mfnShipping: items.reduce((s, i) => s + i.mfnShipping, 0),
        projectedProfit: items.reduce((s, i) => s + i.projectedProfit, 0),
        itemsMissingCogs: items.filter(i => i.cogsSource === 'missing').length,
        itemsCogsFallback: items.filter(i => i.cogsSource === 'fallback').length,
      },
    });
  } catch (error) {
    db.close();
    console.error('In-flight orders API error:', error);
    return NextResponse.json({ error: 'Failed to load in-flight orders' }, { status: 500 });
  }
}
