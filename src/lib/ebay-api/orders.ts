/**
 * eBay Fulfillment API client.
 * Pulls orders and line items, stores in shared orders/order_items tables.
 */

import { ebayApiRequest } from './auth';
import type { EbayCredentials, EbayOrder } from './types';
import Database from 'better-sqlite3';
import path from 'path';

const FULFILLMENT_API = 'https://api.ebay.com/sell/fulfillment/v1';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function toCents(amount: number | string | undefined): number {
  if (amount === undefined || amount === null || amount === '') return 0;
  return Math.round(Number(amount) * 100);
}

/**
 * Sync eBay orders for a given date range.
 * Uses offset-based pagination.
 */
export async function syncEbayOrders(
  credentials: EbayCredentials,
  startDate: string,
  endDate?: string,
): Promise<{ recordsFetched: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let recordsFetched = 0;

  try {
    let offset = 0;
    const limit = 200;

    // eBay filter uses bracket range syntax
    const endDateStr = endDate || new Date().toISOString();
    const filter = `creationdate:[${startDate}..${endDateStr}]`;

    do {
      let response: any;
      try {
        // Request full order details including fees
        response = await ebayApiRequest(
          credentials,
          `${FULFILLMENT_API}/order`,
          { filter, limit: String(limit), offset: String(offset), fieldGroups: 'TAX_BREAKDOWN' },
        );
      } catch (err: any) {
        errors.push(`Orders fetch error: ${err.message}`);
        break;
      }

      const orders: EbayOrder[] = response?.orders || [];
      if (orders.length === 0) break;

      for (const order of orders) {
        try {
          processEbayOrder(db, order);
          recordsFetched++;
        } catch (err: any) {
          errors.push(`Order ${order.orderId || 'unknown'}: ${err.message}`);
        }
      }

      // Check if there are more pages
      const total = response?.total || 0;
      offset += limit;
      if (offset >= total) break;
    } while (true);
  } finally {
    db.close();
  }

  return { recordsFetched, errors };
}

function processEbayOrder(db: Database.Database, order: EbayOrder) {
  const orderId = order.orderId;
  if (!orderId) return;

  const orderDate = order.creationDate || new Date().toISOString();
  const now = new Date().toISOString();

  // Skip cancelled orders
  if (order.cancelStatus?.cancelState === 'CANCELED' ||
      order.orderFulfillmentStatus === 'NOT_STARTED' && order.orderPaymentStatus === 'FAILED') {
    return;
  }

  // Always MFN (self-fulfilled)
  const fulfillmentChannel = 'MFN';

  // Get buyer's state for sales tax
  const shippingAddr = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress;
  const state = shippingAddr?.stateOrProvince || 'Unknown';

  // Insert/update order
  db.prepare(`
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, created_at)
    VALUES (?, ?, 'Shipped', 'ebay', ?, 1, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      status = CASE WHEN excluded.status != status THEN excluded.status ELSE status END
  `).run(orderId, orderDate, fulfillmentChannel, now);

  // Extract order-level fee data from Fulfillment API (no Finances API needed)
  const totalMarketplaceFee = toCents((order as any).totalMarketplaceFee?.value);
  const totalFeeBasis = toCents((order as any).totalFeeBasisAmount?.value);

  const lineItems = order.lineItems || [];

  for (const item of lineItems) {
    const sku = item.sku || item.legacyItemId || '';
    const ebayItemId = item.legacyItemId || '';
    const title = item.title || '';
    const quantity = item.quantity || 1;
    const productPrice = toCents(item.lineItemCost?.value);
    const shippingCharge = toCents(item.deliveryCost?.shippingCost?.value);
    const pricePerUnit = quantity > 0 ? Math.round(productPrice / quantity) : productPrice;

    // Tax from line item
    let taxAmount = 0;
    if (item.taxes) {
      for (const tax of item.taxes) {
        taxAmount += toCents(tax.amount?.value);
      }
    }
    // Also check ebayCollectAndRemitTaxes
    const ebayTaxes = (item as any).ebayCollectAndRemitTaxes || [];
    for (const tax of ebayTaxes) {
      taxAmount += toCents(tax.amount?.value);
    }

    // Insert order item
    db.prepare(`
      INSERT OR IGNORE INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, cogs_per_unit, promotional_rebate)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
    `).run(orderId, ebayItemId, sku, quantity, pricePerUnit, productPrice, shippingCharge);

    // Insert product
    if (sku || ebayItemId) {
      const productKey = sku || ebayItemId;
      db.prepare(`
        INSERT OR IGNORE INTO products (asin, sku, name, marketplace, created_at, updated_at)
        VALUES (?, ?, ?, 'ebay', ?, ?)
      `).run(productKey, sku, title, now, now);

      // Update name if existing is empty
      db.prepare(`
        UPDATE products SET name = ?, updated_at = ?
        WHERE asin = ? AND (name IS NULL OR name = '' OR name = asin)
      `).run(title, now, productKey);
    }

    // Insert financial event (for posted_date subquery to work)
    db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('ShipmentEvent', ?, ?, ?, ?, 'ebay', ?, '{}', ?)
    `).run(orderDate, orderId, ebayItemId, sku, productPrice, now);

    // Sales tax
    if (taxAmount > 0) {
      db.prepare(`
        INSERT OR IGNORE INTO sales_tax (order_id, state, tax_collected, marketplace_facilitator_tax, posted_date, marketplace)
        VALUES (?, ?, ?, ?, ?, 'ebay')
      `).run(orderId, state, taxAmount, taxAmount, orderDate);
    }
  }

  // Insert marketplace fee as fee_detail (order-level, not per-item)
  if (totalMarketplaceFee > 0) {
    // Create a financial event for the fee
    const feeResult = db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('EbayFeeEvent', ?, ?, ?, ?, 'ebay', ?, '{}', ?)
    `).run(orderDate, orderId, '', '', -totalMarketplaceFee, now);

    if (feeResult.changes > 0) {
      const eventId = Number(feeResult.lastInsertRowid);
      db.prepare(`
        INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
        VALUES (?, ?, ?, 'EbayFinalValueFee', 'eBay Selling Fees', ?, ?)
      `).run(eventId, orderId, '', -totalMarketplaceFee, orderDate);
    }

    // Mark order as reconciled (we have real fees)
    db.prepare(`UPDATE orders SET is_estimated = 0 WHERE order_id = ?`).run(orderId);
  }
}
