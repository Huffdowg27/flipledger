/**
 * Walmart Marketplace Orders API client.
 * Pulls orders and line items, stores in the same orders/order_items tables as Amazon.
 */

import { walmartApiRequest } from './auth';
import type { WalmartCredentials, WalmartOrder, WalmartCharge } from './types';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

/** Convert dollar amount to integer cents */
function toCents(amount: number | string | undefined): number {
  if (amount === undefined || amount === null) return 0;
  return Math.round(Number(amount) * 100);
}

/**
 * Sync Walmart orders for a given date range.
 * Auto-chunks into 14-day windows to avoid the Walmart pagination bug
 * where nextCursor loops infinitely for >200 WFS orders in a single range.
 */
export async function syncWalmartOrders(
  credentials: WalmartCredentials,
  startDate: string,
  endDate?: string,
): Promise<{ recordsFetched: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let recordsFetched = 0;

  // Split into 14-day chunks to avoid Walmart pagination bug
  const CHUNK_DAYS = 14;
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate || new Date().toISOString()).getTime();
  const chunks: { start: string; end: string }[] = [];

  let current = startMs;
  while (current < endMs) {
    const chunkEnd = Math.min(current + CHUNK_DAYS * 86400000, endMs);
    chunks.push({
      start: new Date(current).toISOString(),
      end: new Date(chunkEnd).toISOString(),
    });
    current = chunkEnd;
  }

  console.log(`[Walmart Orders] Splitting into ${chunks.length} chunks of ${CHUNK_DAYS} days`);

  try {
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      console.log(`[Walmart Orders] Chunk ${ci + 1}/${chunks.length}: ${chunk.start.split('T')[0]} → ${chunk.end.split('T')[0]}`);

      // Must sync both Seller Fulfilled and WFS orders separately
      for (const shipNodeType of ['SellerFulfilled', 'WFSFulfilled']) {
        let nextCursor: string | undefined;
        let iterations = 0;
        const MAX_ITERATIONS = 50; // safety valve — 50 pages × 200 = 10,000 orders max per chunk

        do {
          iterations++;
          if (iterations > MAX_ITERATIONS) {
            errors.push(`Pagination loop exceeded ${MAX_ITERATIONS} iterations for ${shipNodeType} chunk ${ci + 1}`);
            break;
          }

          const params: Record<string, string> = {
            createdStartDate: chunk.start,
            createdEndDate: chunk.end,
            limit: '200',
            shipNodeType,
          };
          if (nextCursor) params.nextCursor = nextCursor;

          let response: any;
          try {
            response = await walmartApiRequest(credentials, '/orders', params);
          } catch (err: any) {
            errors.push(`Orders fetch error (${shipNodeType}): ${err.message}`);
            break;
          }

          const orderList = response?.list?.elements?.order || response?.elements?.order || [];
          if (!Array.isArray(orderList) || orderList.length === 0) break;

          for (const order of orderList) {
            try {
              processWalmartOrder(db, order);
              recordsFetched++;
            } catch (err: any) {
              errors.push(`Order ${order.purchaseOrderId || 'unknown'}: ${err.message}`);
            }
          }

          const newCursor = response?.list?.meta?.nextCursor || response?.meta?.nextCursor;
          // Detect cursor loop — if same cursor comes back, bail
          if (newCursor && newCursor === nextCursor) {
            console.warn(`[Walmart Orders] Cursor loop detected for ${shipNodeType} chunk ${ci + 1}, breaking`);
            break;
          }
          nextCursor = newCursor;
        } while (nextCursor);
      }
    }
  } finally {
    db.close();
  }

  return { recordsFetched, errors };
}

function processWalmartOrder(db: Database.Database, order: WalmartOrder) {
  const orderId = order.purchaseOrderId;
  if (!orderId) return;

  // Walmart returns dates as Unix timestamps in ms or ISO strings
  let orderDate = order.orderDate || new Date().toISOString();
  if (typeof orderDate === 'number' || /^\d+$/.test(String(orderDate))) {
    orderDate = new Date(Number(orderDate)).toISOString();
  }
  const now = new Date().toISOString();

  const orderLines = order.orderLines?.orderLine || [];

  // Skip cancelled orders
  const isCancelled = orderLines.some((line: any) => {
    const statuses = line.orderLineStatuses?.orderLineStatus || [];
    return statuses.some((s: any) => s.status === 'Cancelled');
  });
  if (isCancelled) return;

  // Determine fulfillment channel — check shipNode or fulfillment option
  let fulfillmentChannel = 'Seller';
  if ((order as any).shipNode?.type === 'WFSFulfilled') {
    fulfillmentChannel = 'WFS';
  } else {
    for (const line of orderLines) {
      if (line.fulfillment?.fulfillmentOption?.toLowerCase().includes('wfs') ||
          line.fulfillment?.fulfillmentOption?.toLowerCase().includes('warehouse') ||
          line.fulfillment?.fulfillmentOption?.toLowerCase().includes('s2h')) {
        fulfillmentChannel = 'WFS';
        break;
      }
    }
  }

  // Insert/update order
  db.prepare(`
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, created_at)
    VALUES (?, ?, 'Shipped', 'walmart', ?, 1, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      status = CASE WHEN excluded.status != status THEN excluded.status ELSE status END,
      fulfillment_channel = excluded.fulfillment_channel
  `).run(orderId, orderDate, fulfillmentChannel, now);

  // Process each line item
  for (const line of orderLines) {
    const sku = line.item?.sku || '';
    const productName = line.item?.productName || '';
    const quantity = parseInt(line.orderLineQuantity?.amount || line.quantity?.amount || '1');

    // Extract charges
    const charges = line.charges?.charge || [];
    let productPrice = 0;
    let shippingCharge = 0;
    let productTax = 0;
    let shippingTax = 0;

    for (const charge of charges) {
      const amount = toCents(charge.chargeAmount?.amount);
      const taxAmount = toCents(charge.tax?.taxAmount?.amount);

      if (charge.chargeType === 'PRODUCT') {
        productPrice += amount;
        productTax += taxAmount;
      } else if (charge.chargeType === 'SHIPPING') {
        shippingCharge += amount;
        shippingTax += taxAmount;
      }
    }

    const pricePerUnit = quantity > 0 ? Math.round(productPrice / quantity) : productPrice;

    // Insert order item (skip if already exists)
    db.prepare(`
      INSERT OR IGNORE INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, cogs_per_unit, promotional_rebate)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
    `).run(orderId, sku, sku, quantity, pricePerUnit, productPrice, shippingCharge);

    // Insert product if not exists
    if (sku) {
      db.prepare(`
        INSERT OR IGNORE INTO products (asin, sku, name, marketplace, created_at, updated_at)
        VALUES (?, ?, ?, 'walmart', ?, ?)
      `).run(sku, sku, productName, now, now);

      // Update name if we have it and the existing one is just the SKU
      db.prepare(`
        UPDATE products SET name = ?, updated_at = ?
        WHERE asin = ? AND (name IS NULL OR name = '' OR name = asin)
      `).run(productName, now, sku);
    }

    // Insert financial event so posted_date subquery works (same as Amazon ShipmentEvents)
    db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('ShipmentEvent', ?, ?, ?, ?, 'walmart', ?, '{}', ?)
    `).run(orderDate, orderId, sku, sku, productPrice, now);

    // Insert sales tax
    if (productTax > 0 || shippingTax > 0) {
      const state = order.shippingInfo?.postalAddress?.state || 'Unknown';
      const totalTax = productTax + shippingTax;
      db.prepare(`
        INSERT OR IGNORE INTO sales_tax (order_id, state, tax_collected, marketplace_facilitator_tax, posted_date, marketplace)
        VALUES (?, ?, ?, ?, ?, 'walmart')
      `).run(orderId, state, totalTax, totalTax, orderDate);
    }
  }
}
