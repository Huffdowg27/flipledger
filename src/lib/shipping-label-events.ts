import type Database from 'better-sqlite3';

export type ShippingLabelFeeType = 'PostageBilling' | 'PostageRefund';

export interface ShippingLabelFee {
  orderId: string;
  postedDate: string;
  feeType: ShippingLabelFeeType;
  amountCents: number;
  rawData: string;
  createdAt?: string;
}

/**
 * Persist and apply one Amazon Buy Shipping fee exactly once.
 *
 * The event insert is the replay guard. Shipping is order-level, so the entire
 * delta is assigned to the lowest-id line rather than duplicated across every
 * item in a multi-line order.
 */
export function storeShippingLabelFee(
  db: Database.Database,
  fee: ShippingLabelFee,
): number {
  const orderId = fee.orderId.trim();
  const postedDate = fee.postedDate.trim();
  if (!orderId) throw new Error('shipping-label event missing order id');
  if (!postedDate) throw new Error(`shipping-label event ${orderId} missing posted date`);
  if (!Number.isSafeInteger(fee.amountCents) || fee.amountCents <= 0) {
    throw new Error(`invalid shipping-label amount for order ${orderId}`);
  }

  return db.transaction(() => {
    const delta = fee.feeType === 'PostageBilling'
      ? fee.amountCents
      : -fee.amountCents;
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO financial_events (
        event_type, posted_date, order_id, asin, sku, marketplace,
        total_amount, raw_data, created_at
      ) VALUES (?, ?, ?, NULL, NULL, 'amazon', ?, ?, ?)
    `).run(
      `ShippingLabel:${fee.feeType}`,
      postedDate,
      orderId,
      delta,
      fee.rawData,
      fee.createdAt || new Date().toISOString(),
    ).changes;
    if (inserted === 0) return 0;

    const updated = db.prepare(`
      UPDATE order_items
      SET shipping_cost = COALESCE(shipping_cost, 0) + ?
      WHERE id = (
        SELECT MIN(id) FROM order_items WHERE order_id = ?
      )
    `).run(delta, orderId).changes;
    if (updated !== 1) {
      throw new Error(`shipping-label event ${orderId} cannot apply: no order item exists`);
    }
    return 1;
  })();
}
