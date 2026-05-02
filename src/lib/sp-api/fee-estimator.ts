/**
 * Fee estimator — estimates fees for orders missing financial event data.
 *
 * Estimated fees use financial_event_id = 0 so they can be identified and
 * overridden when real data arrives (from Financial Events API or settlement reports).
 *
 * Estimation methods:
 * - Commission: per-SKU average rate from existing orders (typically 8-15%)
 * - FBA fulfillment: per-SKU average from existing orders (varies by size/weight)
 * - If no per-SKU data: use category-based defaults
 */

import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

interface FeeEstimate {
  commissionRate: number;  // 0-1 (e.g., 0.15 = 15%)
  fbaFeePerUnit: number;   // cents
}

/**
 * Get fee estimates for a SKU based on historical data.
 */
function getSkuFeeEstimate(db: Database.Database, sku: string, asin: string): FeeEstimate {
  // Try per-SKU commission rate
  const commRate = db.prepare(`
    SELECT AVG(ABS(fd.amount) * 1.0 / oi.total_price) as rate
    FROM fee_details fd
    JOIN order_items oi ON fd.order_id = oi.order_id
    WHERE fd.fee_type = 'Commission' AND fd.financial_event_id != 0
    AND (oi.sku = ? OR oi.asin = ?)
    AND oi.total_price > 0
  `).get(sku, asin) as any;

  // Try per-SKU FBA fee
  const fbaFee = db.prepare(`
    SELECT AVG(ABS(fd.amount)) as avg_fee
    FROM fee_details fd
    JOIN order_items oi ON fd.order_id = oi.order_id
    WHERE fd.fee_type = 'FBAPerUnitFulfillmentFee' AND fd.financial_event_id != 0
    AND (oi.sku = ? OR oi.asin = ?)
    AND ABS(fd.amount) > 0
  `).get(sku, asin) as any;

  // Fall back to category-based defaults if no per-SKU data
  let commissionRate = commRate?.rate || 0;
  if (commissionRate === 0) {
    // Get category
    const product = db.prepare('SELECT category FROM products WHERE asin = ?').get(asin) as any;
    const category = (product?.category || '').toLowerCase();

    // Amazon referral fee rates by category
    if (category.includes('electronic') || category.includes('computer') || category.includes('camera')) {
      commissionRate = 0.08;
    } else if (category.includes('video game') || category.includes('software')) {
      commissionRate = 0.15;
    } else if (category.includes('toy') || category.includes('game')) {
      commissionRate = 0.15;
    } else {
      commissionRate = 0.15; // default 15%
    }
  }

  const fbaFeePerUnit = fbaFee?.avg_fee || 669; // default $6.69

  return { commissionRate, fbaFeePerUnit };
}

/**
 * Estimate and backfill fees for orders missing financial event data.
 * Only creates estimates (financial_event_id = 0) that will be overridden
 * when real data arrives.
 */
export function estimateAndBackfillFees(): { estimated: number; skipped: number } {
  const db = getDb();
  let estimated = 0;
  let skipped = 0;

  try {
    // Find orders missing ANY fee data
    const ordersMissingFees = db.prepare(`
      SELECT oi.order_id, oi.asin, oi.sku, oi.total_price, oi.quantity, o.fulfillment_channel
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN fee_details fd ON oi.order_id = fd.order_id
      WHERE fd.order_id IS NULL
      AND o.status = 'Shipped'
      AND oi.total_price > 0
    `).all() as any[];

    for (const order of ordersMissingFees) {
      const estimate = getSkuFeeEstimate(db, order.sku, order.asin);

      // Commission
      const commissionFee = -Math.round(order.total_price * estimate.commissionRate);
      if (commissionFee < 0) {
        db.prepare(`
          INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
          VALUES (0, ?, ?, 'Commission', 'Selling Fees', ?, datetime('now'))
        `).run(order.order_id, order.asin, commissionFee);
      }

      // FBA fulfillment fee (only for FBA orders)
      if (order.fulfillment_channel === 'FBA') {
        const fbaFee = -Math.round(estimate.fbaFeePerUnit * order.quantity);
        if (fbaFee < 0) {
          db.prepare(`
            INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
            VALUES (0, ?, ?, 'FBAPerUnitFulfillmentFee', 'FBA Transaction Fees', ?, datetime('now'))
          `).run(order.order_id, order.asin, fbaFee);
        }
      }

      estimated++;
    }

    // Also check for orders that have Commission but missing FBA fee (FBA orders only)
    const missingFbaOnly = db.prepare(`
      SELECT oi.order_id, oi.asin, oi.sku, oi.quantity
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE o.fulfillment_channel = 'FBA'
      AND o.status = 'Shipped'
      AND EXISTS (SELECT 1 FROM fee_details WHERE order_id = oi.order_id AND fee_type = 'Commission')
      AND NOT EXISTS (SELECT 1 FROM fee_details WHERE order_id = oi.order_id AND fee_type = 'FBAPerUnitFulfillmentFee')
    `).all() as any[];

    for (const order of missingFbaOnly) {
      const estimate = getSkuFeeEstimate(db, order.sku, order.asin);
      const fbaFee = -Math.round(estimate.fbaFeePerUnit * order.quantity);
      if (fbaFee < 0) {
        db.prepare(`
          INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
          VALUES (0, ?, ?, 'FBAPerUnitFulfillmentFee', 'FBA Transaction Fees', ?, datetime('now'))
        `).run(order.order_id, order.asin, fbaFee);
        estimated++;
      }
    }
  } finally {
    db.close();
  }

  return { estimated, skipped };
}

/**
 * Override estimated fees with real data.
 * Called during sync when Financial Events API returns actual fees.
 * Deletes estimates (financial_event_id = 0) for orders that now have real fees.
 */
export function overrideEstimatedFees(): number {
  const db = getDb();
  let overridden = 0;

  try {
    // Find orders that have BOTH estimated (id=0) and real (id!=0) fees
    const result = db.prepare(`
      DELETE FROM fee_details
      WHERE financial_event_id = 0
      AND order_id IN (
        SELECT DISTINCT order_id FROM fee_details WHERE financial_event_id != 0 AND financial_event_id != -1
      )
    `).run();

    overridden = result.changes;
  } finally {
    db.close();
  }

  return overridden;
}
