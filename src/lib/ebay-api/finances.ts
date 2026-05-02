/**
 * eBay Finances API client.
 * Single source of truth for fees AND refunds.
 * Replaces what Amazon does with financial_events + fee_details,
 * and what Walmart does with recon reports + returns API.
 */

import { ebayApiRequest } from './auth';
import type { EbayCredentials, EbayTransaction } from './types';
import Database from 'better-sqlite3';
import path from 'path';

const FINANCES_API = 'https://api.ebay.com/sell/finances/v1';

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

/** Map eBay fee types to our fee_type and fee_category */
function categorizeEbayFee(feeType: string): { feeType: string; feeCategory: string } {
  switch (feeType) {
    case 'FINAL_VALUE_FEE':
    case 'FINAL_VALUE_FEE_FIXED_PER_ORDER':
      return { feeType: 'EbayFinalValueFee', feeCategory: 'eBay Selling Fees' };
    case 'AD_FEE':
      return { feeType: 'EbayAdFee', feeCategory: 'eBay Advertising Fees' };
    case 'INTERNATIONAL_FEE':
      return { feeType: 'EbayInternationalFee', feeCategory: 'eBay International Fees' };
    case 'INSERTION_FEE':
      return { feeType: 'EbayInsertionFee', feeCategory: 'eBay Listing Fees' };
    case 'REGULATORY_OPERATING_FEE':
      return { feeType: 'EbayRegulatoryFee', feeCategory: 'eBay Regulatory Fees' };
    default:
      return { feeType: `Ebay_${feeType}`, feeCategory: 'eBay Other Fees' };
  }
}

/**
 * Sync eBay financial transactions (fees + refunds).
 */
export async function syncEbayFinances(
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
    const endDateStr = endDate || new Date().toISOString();
    const filter = `transactionDate:[${startDate}..${endDateStr}]`;

    do {
      let response: any;
      try {
        response = await ebayApiRequest(
          credentials,
          `${FINANCES_API}/transaction`,
          { filter, limit: String(limit), offset: String(offset) },
        );
      } catch (err: any) {
        errors.push(`Finances fetch error: ${err.message}`);
        break;
      }

      const transactions: EbayTransaction[] = response?.transactions || [];
      if (transactions.length === 0) break;

      for (const txn of transactions) {
        try {
          processTransaction(db, txn);
          recordsFetched++;
        } catch (err: any) {
          errors.push(`Transaction ${txn.transactionId || 'unknown'}: ${err.message}`);
        }
      }

      const total = response?.total || 0;
      offset += limit;
      if (offset >= total) break;
    } while (true);
  } finally {
    db.close();
  }

  return { recordsFetched, errors };
}

function processTransaction(db: Database.Database, txn: EbayTransaction) {
  const now = new Date().toISOString();
  const transactionDate = txn.transactionDate || now;
  const orderId = txn.orderId || null;
  const transactionId = txn.transactionId;

  switch (txn.transactionType) {
    case 'SALE':
    case 'ORDER': {
      // Extract fees from order line items
      const lineItems = txn.orderLineItems || [];

      for (const li of lineItems) {
        const fees = li.marketplaceFees || [];
        const asin = li.lineItemId || '';

        for (const fee of fees) {
          const amount = toCents(fee.amount?.value); // eBay fees are negative
          if (amount === 0) continue;

          const { feeType, feeCategory } = categorizeEbayFee(fee.feeType);

          // Insert financial event for this fee
          const result = db.prepare(`
            INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
            VALUES ('EbayFeeEvent', ?, ?, ?, ?, 'ebay', ?, ?, ?)
          `).run(transactionDate, orderId, asin, '', amount, JSON.stringify({ transactionId, feeType: fee.feeType }), now);

          if (result.changes > 0) {
            const eventId = Number(result.lastInsertRowid);
            db.prepare(`
              INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(eventId, orderId, asin, feeType, feeCategory, amount, transactionDate);
          }
        }
      }

      // Mark order as reconciled (not estimated anymore)
      if (orderId) {
        db.prepare(`UPDATE orders SET is_estimated = 0 WHERE order_id = ? AND is_estimated = 1`).run(orderId);
      }
      break;
    }

    case 'REFUND': {
      if (!orderId) break;
      const refundAmount = Math.abs(toCents(txn.amount?.value));

      // Extract fee clawbacks from refund transaction
      let feeClawback = 0;
      const lineItems = txn.orderLineItems || [];
      for (const li of lineItems) {
        const fees = li.marketplaceFees || [];
        for (const fee of fees) {
          feeClawback += Math.abs(toCents(fee.amount?.value));
        }
      }

      // Get first line item's SKU for the refund record
      const firstLine = lineItems[0];
      const sku = firstLine?.lineItemId || '';

      db.prepare(`
        INSERT OR IGNORE INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, 'ebay', ?)
      `).run(orderId, transactionDate, sku, sku, refundAmount, 'eBay Refund', feeClawback, now);
      break;
    }

    case 'CREDIT':
    case 'NON_SALE_CHARGE':
    case 'SHIPPING_LABEL': {
      // Service-level charges (promoted listing credits, subscription fees, shipping labels)
      const amount = toCents(txn.amount?.value);
      if (amount === 0) break;

      // Store as a reimbursement if positive (credit), or service fee if negative
      if (amount > 0) {
        db.prepare(`
          INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, 'Approved', 'ebay', ?)
        `).run(transactionId, transactionDate, null, null, `eBay ${txn.transactionType}`, amount, now);
      } else {
        // Negative = expense/fee
        const result = db.prepare(`
          INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
          VALUES ('EbayServiceFee', ?, ?, ?, ?, 'ebay', ?, ?, ?)
        `).run(transactionDate, null, null, null, amount, JSON.stringify({ transactionId, type: txn.transactionType }), now);

        if (result.changes > 0) {
          const eventId = Number(result.lastInsertRowid);
          const feeLabel = txn.transactionType === 'SHIPPING_LABEL' ? 'EbayShippingLabel' : `Ebay_${txn.transactionType}`;
          const category = txn.transactionType === 'SHIPPING_LABEL' ? 'eBay Shipping Labels' : 'eBay Service Fees';
          db.prepare(`
            INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(eventId, null, null, feeLabel, category, amount, transactionDate);
        }
      }
      break;
    }

    // TRANSFER, DISPUTE, etc. — log but don't process
    default:
      break;
  }
}
