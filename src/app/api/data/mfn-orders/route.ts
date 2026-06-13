import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

/**
 * GET /api/data/mfn-orders — operational fulfillment queue for merchant-fulfilled
 * orders (Prep Ship Hub-style). Read-only: surfaces current open orders and their
 * status so they can be triaged for shipping. NOT a P&L view — see
 * /api/data/merchant-sales for sales/profit reporting.
 *
 * Query params:
 *   status = awaiting (default) | pending | shipped | all
 */
function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

const OPEN_STATUSES = ['Unshipped', 'PartiallyShipped'];

function statusClause(status: string): { sql: string; recentLimit: boolean } {
  switch (status) {
    case 'pending':
      return { sql: `o.status = 'Pending'`, recentLimit: false };
    case 'shipped':
      return { sql: `o.status IN ('Shipped', 'PartiallyShipped')`, recentLimit: true };
    case 'canceled':
      return { sql: `o.status IN ('Canceled', 'Cancelled')`, recentLimit: true };
    case 'all':
      return { sql: `o.status IN ('Pending', 'Unshipped', 'PartiallyShipped')`, recentLimit: false };
    case 'awaiting':
    default:
      return { sql: `o.status IN ('Unshipped', 'PartiallyShipped')`, recentLimit: false };
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'awaiting';
  const db = getDb();

  try {
    const { sql: statusSql, recentLimit } = statusClause(status);

    // One row per order. The primary item (highest line value) supplies the
    // image/title/SKU shown in the row; itemCount + quantity summarise the rest.
    const orders = db.prepare(`
      SELECT
        o.order_id      AS orderId,
        o.purchase_date AS purchaseDate,
        o.status        AS status,
        o.marketplace   AS marketplace,
        o.order_total   AS orderTotal,
        o.ship_service_level AS shipServiceLevel,
        o.latest_ship_date AS latestShipDate,
        (SELECT COUNT(*)        FROM order_items x WHERE x.order_id = o.order_id) AS itemCount,
        (SELECT SUM(x.quantity) FROM order_items x WHERE x.order_id = o.order_id) AS quantity,
        -- Pending orders carry an opaque 'PENDING' order_item; fall back to the
        -- display-only preview catalog (pv, keyed by orders.preview_asin) so the
        -- photo/title/ASIN still render. NULLIF strips the 'PENDING' sentinel.
        COALESCE(NULLIF(pi.sku, 'PENDING'), pv.sku)            AS sku,
        COALESCE(NULLIF(pi.asin, 'PENDING'), o.preview_asin)   AS asin,
        COALESCE(pi.upc, pv.upc)                               AS upc,
        COALESCE(NULLIF(pi.productName, 'PENDING'), pv.name)   AS productName,
        COALESCE(pi.imageUrl, pv.image_url)                    AS imageUrl,
        (SELECT il.bin_location FROM inventory_ledger il
          WHERE il.sku = pi.sku AND il.bin_location IS NOT NULL AND il.bin_location != ''
          ORDER BY il.quantity_remaining DESC
          LIMIT 1) AS bin
      FROM orders o
      LEFT JOIN products pv ON pv.asin = o.preview_asin
      LEFT JOIN (
        SELECT
          oi.order_id,
          oi.sku,
          oi.asin,
          COALESCE(p.upc, p2.upc)                   AS upc,
          COALESCE(p.name, p2.name, oi.asin)        AS productName,
          COALESCE(p.image_url, p2.image_url)       AS imageUrl,
          ROW_NUMBER() OVER (
            PARTITION BY oi.order_id
            ORDER BY oi.total_price DESC, oi.id ASC
          ) AS rn
        FROM order_items oi
        LEFT JOIN products p  ON oi.asin = p.asin
        LEFT JOIN products p2 ON oi.sku = p2.asin AND p.asin IS NULL
      ) pi ON pi.order_id = o.order_id AND pi.rn = 1
      WHERE o.fulfillment_channel IN ('MFN', 'Seller')
        AND o.marketplace != 'ebay'
        AND ${statusSql}
      ORDER BY o.purchase_date DESC
      ${recentLimit ? 'LIMIT 100' : ''}
    `).all() as any[];

    // Sidebar store counts are always over the open (awaiting) set, regardless of
    // the active filter — they answer "what's waiting to ship per channel".
    const channelRows = db.prepare(`
      SELECT marketplace, COUNT(*) AS n
      FROM orders o
      WHERE o.fulfillment_channel IN ('MFN', 'Seller')
        AND o.marketplace != 'ebay'
        AND o.status IN (${OPEN_STATUSES.map(() => '?').join(',')})
      GROUP BY marketplace
    `).all(...OPEN_STATUSES) as { marketplace: string; n: number }[];

    const amazon = channelRows.find((r) => r.marketplace === 'amazon')?.n || 0;
    const walmart = channelRows.find((r) => r.marketplace === 'walmart')?.n || 0;
    const counts = {
      all: amazon + walmart, // eBay/Shopify not wired as MFN channels yet
      amazon,
      walmart,
      ebay: 0,
      shopify: 0,
    };

    // Per-tab badge counts over the MFN scope: how many orders sit in each bucket.
    // 'all' here matches the "All Open" tab (Pending + Unshipped + PartiallyShipped).
    const statusRows = db.prepare(`
      SELECT o.status AS status, COUNT(*) AS n
      FROM orders o
      WHERE o.fulfillment_channel IN ('MFN', 'Seller')
        AND o.marketplace != 'ebay'
      GROUP BY o.status
    `).all() as { status: string; n: number }[];

    const byStatus = (s: string) => statusRows.find((r) => r.status === s)?.n || 0;
    const statusCounts = {
      awaiting: byStatus('Unshipped') + byStatus('PartiallyShipped'),
      pending: byStatus('Pending'),
      shipped: byStatus('Shipped') + byStatus('PartiallyShipped'),
      canceled: byStatus('Canceled') + byStatus('Cancelled'),
      all: byStatus('Pending') + byStatus('Unshipped') + byStatus('PartiallyShipped'),
    };

    return NextResponse.json({ orders, counts, statusCounts });
  } catch (err) {
    console.error('[mfn-orders] error:', err);
    return NextResponse.json({ error: 'Failed to load MFN orders' }, { status: 500 });
  } finally {
    db.close();
  }
}
