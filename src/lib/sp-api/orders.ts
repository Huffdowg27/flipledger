/**
 * SP-API Orders API client.
 * Pulls order details and enriches existing order data with
 * fulfillment channel, status, and shipping address (for sales tax state).
 */

import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Sync orders from SP-API.
 * Fetches orders created after startDate and updates existing records
 * or creates new ones.
 */
export async function syncOrders(
  credentials: SPAPICredentials,
  startDate: string,
  endDate?: string
): Promise<{ ordersProcessed: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let ordersProcessed = 0;
  let nextToken: string | undefined;
  const orderIdsToFetchItems: string[] = [];

  try {
    do {
      const params: Record<string, string> = {
        MarketplaceIds: credentials.marketplaceId,
      };

      if (nextToken) {
        params.NextToken = nextToken;
      } else {
        params.CreatedAfter = startDate;
        if (endDate) params.CreatedBefore = endDate;
        params.OrderStatuses = 'Unshipped,PartiallyShipped,Shipped';
      }

      const response = await spApiRequest(credentials, '/orders/v0/orders', params, 8);
      const payload = response.payload;
      if (!payload) break;

      const orders = payload.Orders || [];
      const now = new Date().toISOString();

      for (const order of orders) {
        try {
          const orderId = order.AmazonOrderId;
          const purchaseDate = order.PurchaseDate;
          const status = order.OrderStatus;
          const channel = order.FulfillmentChannel === 'AFN' ? 'FBA' : 'MFN';
          const isEstimated = (order.OrderStatus === 'Pending' || order.OrderStatus === 'Unshipped') ? 1 : 0;

          // Upsert order
          db.prepare(`
            INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(order_id) DO UPDATE SET
              purchase_date = excluded.purchase_date,
              status = excluded.status,
              fulfillment_channel = excluded.fulfillment_channel,
              is_estimated = excluded.is_estimated
          `).run(orderId, purchaseDate, status, 'amazon', channel, isEstimated, now);

          // Update sales tax state from shipping address
          const shipState = order.ShippingAddress?.StateOrRegion;
          if (shipState) {
            db.prepare(`
              UPDATE sales_tax SET state = ? WHERE order_id = ? AND state = 'Unknown'
            `).run(shipState, orderId);
          }

          // For Pending orders, Amazon won't return item details
          // but OrderTotal is available — use it as a single order_item
          if (status === 'Pending' && order.OrderTotal?.Amount) {
            const totalCents = Math.round(parseFloat(order.OrderTotal.Amount) * 100);
            db.prepare(`
              INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(order_id, asin, sku) DO UPDATE SET
                total_price = excluded.total_price
            `).run(orderId, 'PENDING', 'PENDING', 1, totalCents, totalCents, 0);
          }

          ordersProcessed++;
          // Track orders that need items fetched
          orderIdsToFetchItems.push(orderId);
        } catch (err) {
          errors.push(`Order ${order.AmazonOrderId}: ${err}`);
        }
      }

      nextToken = payload.NextToken;
    } while (nextToken);

    // Fetch order items for orders that either:
    // 1. Have no items at all, or
    // 2. Have only a PENDING placeholder (order shipped since last sync)
    const missingItems = db.prepare(`
      SELECT o.order_id, o.status FROM orders o
      LEFT JOIN order_items oi ON o.order_id = oi.order_id AND oi.asin != 'PENDING'
      WHERE o.order_id IN (${orderIdsToFetchItems.map(() => '?').join(',')})
      AND oi.order_id IS NULL
      AND o.status != 'Pending'
    `).all(...orderIdsToFetchItems) as { order_id: string; status: string }[];

    console.log(`[Sync] Fetching items for ${missingItems.length} orders missing price data (of ${orderIdsToFetchItems.length} total)`);

    for (const { order_id: oid } of missingItems) {
      try {
        const itemsResponse = await spApiRequest(
          credentials,
          `/orders/v0/orders/${oid}/orderItems`
        );
        const orderItems = itemsResponse.payload?.OrderItems || [];
        const now = new Date().toISOString();

        if (orderItems.length > 0) {
          // Remove PENDING placeholder if it exists
          db.prepare('DELETE FROM order_items WHERE order_id = ? AND asin = ?').run(oid, 'PENDING');
        }

        for (const oi of orderItems) {
          const asin = oi.ASIN;
          const oiSku = oi.SellerSKU;
          const qty = oi.QuantityOrdered || 1;
          const itemPrice = Math.round((oi.ItemPrice?.Amount || 0) * 100);
          const shippingPrice = Math.round((oi.ShippingPrice?.Amount || 0) * 100);

          if (itemPrice > 0) {
            db.prepare(`
              INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(order_id, asin, sku) DO UPDATE SET
                quantity = excluded.quantity,
                price_per_unit = excluded.price_per_unit,
                total_price = excluded.total_price,
                shipping_charged = excluded.shipping_charged
            `).run(oid, asin, oiSku, qty, qty > 0 ? Math.round(itemPrice / qty) : itemPrice, itemPrice, shippingPrice);
          }

          if (asin) {
            db.prepare(`
              INSERT INTO products (asin, sku, name, marketplace, created_at, updated_at)
              VALUES (?, ?, ?, 'amazon', ?, ?)
              ON CONFLICT(asin) DO UPDATE SET
                name = COALESCE(excluded.name, products.name),
                sku = COALESCE(excluded.sku, products.sku),
                updated_at = excluded.updated_at
            `).run(asin, oiSku, oi.Title || null, now, now);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (itemErr) {
        errors.push(`OrderItems ${oid}: ${itemErr}`);
      }
    }
  } finally {
    db.close();
  }

  return { ordersProcessed, errors };
}

/**
 * Fetch order items for a specific order.
 * Used to enrich order data with item-level details.
 */
export async function fetchOrderItems(
  credentials: SPAPICredentials,
  orderId: string
): Promise<any[]> {
  const response = await spApiRequest(
    credentials,
    `/orders/v0/orders/${orderId}/orderItems`
  );
  return response.payload?.OrderItems || [];
}
