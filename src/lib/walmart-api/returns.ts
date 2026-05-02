/**
 * Walmart Marketplace Returns API client.
 */

import { walmartApiRequest } from './auth';
import type { WalmartCredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function toCents(amount: number | string | undefined): number {
  if (amount === undefined || amount === null) return 0;
  return Math.round(Number(amount) * 100);
}

export async function syncWalmartReturns(
  credentials: WalmartCredentials,
  startDate: string,
  endDate?: string,
): Promise<{ recordsFetched: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let recordsFetched = 0;

  try {
    let nextCursor: string | undefined;

    do {
      const params: Record<string, string> = {
        returnCreationStartDate: startDate,
        returnCreationEndDate: endDate || new Date().toISOString(),
        limit: '200',
      };

      let response: any;
      try {
        const endpoint = nextCursor ? `/returns${nextCursor.substring(nextCursor.indexOf('?'))}` : '/returns';
        response = await walmartApiRequest(credentials, nextCursor ? endpoint : '/returns', nextCursor ? undefined : params);
      } catch (err: any) {
        errors.push(`Returns fetch error: ${err.message}`);
        break;
      }

      const returns = response?.returnOrders || [];
      if (!Array.isArray(returns) || returns.length === 0) break;

      const now = new Date().toISOString();

      for (const ret of returns) {
        try {
          const returnOrderId = ret.returnOrderId;
          const returnDate = ret.returnOrderDate || now;
          const totalRefund = toCents(ret.totalRefundAmount?.currencyAmount);
          const lines = ret.returnOrderLines || [];

          for (const line of lines) {
            const purchaseOrderId = line.purchaseOrderId || returnOrderId;
            const sku = line.item?.sku || '';
            const quantity = 1;
            const reason = line.returnReason || line.returnDescription || 'CUSTOMER_RETURN';

            // Get refund amount from charges or totalRefundAmount
            let refundAmount = 0;
            const charges = line.charges || [];
            for (const charge of charges) {
              if (charge.chargeCategory === 'PRODUCT') {
                refundAmount += toCents(charge.chargePerUnit?.currencyAmount) * quantity;
              }
            }
            // Fallback to total if per-line not available
            if (refundAmount === 0 && lines.length === 1) {
              refundAmount = totalRefund;
            }

            db.prepare(`
              INSERT OR IGNORE INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 'walmart', ?)
            `).run(purchaseOrderId, returnDate, sku, sku, quantity, refundAmount, reason, now);

            recordsFetched++;
          }
        } catch (err: any) {
          errors.push(`Return ${ret.returnOrderId || 'unknown'}: ${err.message}`);
        }
      }

      nextCursor = response?.meta?.nextCursor;
    } while (nextCursor);
  } finally {
    db.close();
  }

  return { recordsFetched, errors };
}
