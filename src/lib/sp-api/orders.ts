/**
 * SP-API Orders API client.
 * Pulls order details and enriches existing order data with
 * fulfillment channel, status, and shipping address (for sales tax state).
 */

import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import { extractCogsFromSku, isCogsEncodedSku, isAmazonGradedSku } from '../sku-cogs';
import { recalculateFIFO } from '../fifo';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Wait for a held write lock (e.g. the background sync worker writing at the
  // same time) instead of failing immediately with "database is locked".
  db.pragma('busy_timeout = 5000');
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
        params.OrderStatuses = 'Pending,Unshipped,PartiallyShipped,Shipped';
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
          const orderTotal = order.OrderTotal?.Amount
            ? Math.round(parseFloat(order.OrderTotal.Amount) * 100)
            : 0;
          const orderTotalCurrency = order.OrderTotal?.CurrencyCode || null;
          // shipped_at: when status is Shipped or PartiallyShipped, LastUpdateDate is when it shipped.
          // Don't overwrite a previously-recorded shipped_at on subsequent syncs (keep first-seen ship time).
          const shippedAt = (status === 'Shipped' || status === 'PartiallyShipped') ? (order.LastUpdateDate || null) : null;
          // Delivery promise (Standard / Expedited / SecondDay / NextDay …); shown on /mfn/orders.
          const shipServiceLevel = order.ShipmentServiceLevelCategory || null;
          // Fulfillment deadline — ship by this date to stay on time (MFN).
          const latestShipDate = order.LatestShipDate || null;

          // Upsert order. Preserve shipped_at once set: COALESCE keeps existing value if not null.
          db.prepare(`
            INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, order_total, order_total_currency, ship_service_level, latest_ship_date, shipped_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(order_id) DO UPDATE SET
              purchase_date = excluded.purchase_date,
              status = excluded.status,
              fulfillment_channel = excluded.fulfillment_channel,
              is_estimated = excluded.is_estimated,
              order_total = CASE WHEN excluded.order_total > 0 THEN excluded.order_total ELSE orders.order_total END,
              order_total_currency = COALESCE(excluded.order_total_currency, orders.order_total_currency),
              ship_service_level = COALESCE(excluded.ship_service_level, orders.ship_service_level),
              latest_ship_date = COALESCE(excluded.latest_ship_date, orders.latest_ship_date),
              shipped_at = COALESCE(orders.shipped_at, excluded.shipped_at)
          `).run(orderId, purchaseDate, status, 'amazon', channel, isEstimated, orderTotal, orderTotalCurrency, shipServiceLevel, latestShipDate, shippedAt, now);

          // Update sales tax state from shipping address
          const shipState = order.ShippingAddress?.StateOrRegion;
          if (shipState) {
            db.prepare(`
              UPDATE sales_tax SET state = ? WHERE order_id = ? AND state = 'Unknown'
            `).run(shipState, orderId);
          }

          // Pending orders: the bulk getOrders call hides line items, so we record
          // an opaque 'PENDING' placeholder order_item carrying just the order total.
          // (The real ASIN is fetchable via getOrderItems — see resolvePendingPreviews
          // below — but it must NOT land in order_items, because FIFO consumes Pending
          // orders and would deplete inventory / mint COGS for an unsettled order.)
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

        // For auto-ledger creation: fetch order metadata once
        const orderMeta = db.prepare(
          'SELECT purchase_date, fulfillment_channel FROM orders WHERE order_id = ? LIMIT 1'
        ).get(oid) as { purchase_date: string; fulfillment_channel: string } | undefined;

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

          // Auto-create inventory_ledger entry for COGS-encoded SKUs that have
          // no existing lot. Works for MFN and FBA items bought per-order where
          // the buy cost is embedded in the SKU (LV_/ZTPC_ format).
          // NEVER for amzn.gr.* resales: they wrap an LV_/ZTPC_ SKU (so the cost
          // decoder would otherwise fire), but their cost was already expensed on
          // the unit's first sale — creating a lot would be a zero-basis ghost lot.
          if (oiSku && asin && isCogsEncodedSku(oiSku) && !isAmazonGradedSku(oiSku) && orderMeta) {
            const cogsCents = extractCogsFromSku(oiSku);
            if (cogsCents > 0) {
              const hasLot = db.prepare(
                'SELECT 1 FROM inventory_ledger WHERE sku = ? LIMIT 1'
              ).get(oiSku);
              if (!hasLot) {
                const datePurchased = orderMeta.purchase_date
                  ? orderMeta.purchase_date.slice(0, 10)
                  : now.slice(0, 10);
                try {
                  db.prepare(`
                    INSERT INTO inventory_ledger
                      (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, notes, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'sku:auto', ?)
                  `).run(asin, oiSku, cogsCents, qty, qty, datePurchased, now);
                } catch { /* ignore; FIFO will recalc on next sync */ }
              }
            }
          }

          if (asin) {
            try {
              db.prepare(`
                INSERT INTO products (asin, sku, name, marketplace, created_at, updated_at)
                VALUES (?, ?, ?, 'amazon', ?, ?)
                ON CONFLICT(asin) DO UPDATE SET
                  name = COALESCE(excluded.name, products.name),
                  sku = COALESCE(excluded.sku, products.sku),
                  updated_at = excluded.updated_at
              `).run(asin, oiSku, oi.Title || null, now, now);
            } catch { /* products is display-only; don't let it interrupt order_items */ }
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (itemErr) {
        errors.push(`OrderItems ${oid}: ${itemErr}`);
      }
    }

    // Display-only: resolve the real ASIN/title for Pending orders so /mfn/orders
    // can show a photo. getOrderItems returns line items even while the bulk
    // getOrders call hides them. We write ONLY to orders.preview_asin and the
    // products catalog (both display-only) — never to order_items / inventory_ledger,
    // so FIFO and COGS stay untouched for orders that haven't settled.
    const pendingToPreview = orderIdsToFetchItems.length
      ? db.prepare(`
          SELECT order_id FROM orders
          WHERE order_id IN (${orderIdsToFetchItems.map(() => '?').join(',')})
            AND status = 'Pending'
            AND preview_asin IS NULL
        `).all(...orderIdsToFetchItems) as { order_id: string }[]
      : [];

    for (const { order_id: oid } of pendingToPreview) {
      try {
        const resp = await spApiRequest(credentials, `/orders/v0/orders/${oid}/orderItems`);
        const items = resp.payload?.OrderItems || [];
        if (items.length === 0) continue;
        // Primary item = highest line value, mirroring the /mfn/orders row picker.
        const primary = items.reduce((best: any, it: any) =>
          (it.ItemPrice?.Amount || 0) > (best?.ItemPrice?.Amount || 0) ? it : best, items[0]);
        const asin = primary.ASIN;
        if (!asin) continue;
        const now = new Date().toISOString();

        db.prepare('UPDATE orders SET preview_asin = ? WHERE order_id = ?').run(asin, oid);
        // Display-only catalog row; enrichProductCatalog fills the image on its pass.
        db.prepare(`
          INSERT INTO products (asin, sku, name, marketplace, created_at, updated_at)
          VALUES (?, ?, ?, 'amazon', ?, ?)
          ON CONFLICT(asin) DO UPDATE SET
            name = COALESCE(excluded.name, products.name),
            sku = COALESCE(excluded.sku, products.sku),
            updated_at = excluded.updated_at
        `).run(asin, primary.SellerSKU || null, primary.Title || null, now, now);

        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (previewErr) {
        errors.push(`PendingPreview ${oid}: ${previewErr}`);
      }
    }
  } finally {
    db.close();
  }

  return { ordersProcessed, errors };
}

/**
 * Reconcile locally-open orders against Amazon's current status.
 *
 * The incremental order sync queries by CreatedAfter and only requests
 * Pending/Unshipped/PartiallyShipped/Shipped — so an order that was created
 * earlier and later *canceled* drops out of the result set and its local row
 * freezes forever at its last-seen status. This pass closes that gap: it takes
 * every order we still believe is open, asks Amazon for its real status via
 * AmazonOrderIds (which returns Canceled too), and updates any that drifted.
 *
 * Canceled orders never shipped, so their PENDING revenue placeholders are
 * removed and FIFO is recalculated for any real SKUs they touched (FIFO now
 * excludes canceled orders, releasing the wrongly-consumed inventory).
 */
export async function reconcileOpenOrders(
  credentials: SPAPICredentials,
  maxOrders: number = 250
): Promise<{ checked: number; updated: number; canceled: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let checked = 0;
  let updated = 0;
  let canceled = 0;
  const affectedSkus = new Set<string>();

  try {
    const openOrders = db.prepare(`
      SELECT order_id FROM orders
      WHERE status IN ('Pending', 'Unshipped', 'PartiallyShipped')
      ORDER BY purchase_date ASC
      LIMIT ?
    `).all(maxOrders) as { order_id: string }[];

    if (openOrders.length === 0) {
      return { checked, updated, canceled, errors };
    }

    // Amazon getOrders accepts up to 50 AmazonOrderIds per call.
    const BATCH = 50;
    for (let i = 0; i < openOrders.length; i += BATCH) {
      const batch = openOrders.slice(i, i + BATCH);
      try {
        const response = await spApiRequest(credentials, '/orders/v0/orders', {
          MarketplaceIds: credentials.marketplaceId,
          AmazonOrderIds: batch.map(o => o.order_id).join(','),
        }, 8);

        const returned = response?.payload?.Orders || [];
        for (const order of returned) {
          checked++;
          const orderId = order.AmazonOrderId;
          const newStatus = order.OrderStatus;
          const local = db.prepare('SELECT status FROM orders WHERE order_id = ?').get(orderId) as { status: string } | undefined;

          // Backfill the delivery promise for any order missing it, even when the
          // status hasn't drifted — this is what populates ship_service_level on
          // already-synced open orders so /mfn/orders can show Standard vs 2nd Day.
          if (order.ShipmentServiceLevelCategory) {
            db.prepare(
              `UPDATE orders SET ship_service_level = ? WHERE order_id = ? AND ship_service_level IS NULL`
            ).run(order.ShipmentServiceLevelCategory, orderId);
          }

          if (!local || local.status === newStatus) continue;

          const isEstimated = (newStatus === 'Pending' || newStatus === 'Unshipped') ? 1 : 0;
          const shippedAt = (newStatus === 'Shipped' || newStatus === 'PartiallyShipped') ? (order.LastUpdateDate || null) : null;

          db.prepare(`
            UPDATE orders SET status = ?, is_estimated = ?, shipped_at = COALESCE(shipped_at, ?) WHERE order_id = ?
          `).run(newStatus, isEstimated, shippedAt, orderId);
          updated++;

          if (newStatus === 'Canceled' || newStatus === 'Cancelled') {
            canceled++;
            // Collect real SKUs to recalc, then drop placeholder PENDING revenue rows.
            const skus = db.prepare(`
              SELECT DISTINCT sku FROM order_items
              WHERE order_id = ? AND sku IS NOT NULL AND sku != '' AND sku != 'PENDING'
            `).all(orderId) as { sku: string }[];
            for (const s of skus) affectedSkus.add(s.sku);
            db.prepare(`DELETE FROM order_items WHERE order_id = ? AND asin = 'PENDING'`).run(orderId);
          }
        }
      } catch (err) {
        errors.push(`reconcile batch ${i}: ${err}`);
      }
    }
  } finally {
    db.close();
  }

  // Release inventory that canceled orders had wrongly consumed.
  for (const sku of affectedSkus) {
    try {
      recalculateFIFO({ sku });
    } catch (err) {
      errors.push(`fifo recalc ${sku}: ${err}`);
    }
  }

  return { checked, updated, canceled, errors };
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
