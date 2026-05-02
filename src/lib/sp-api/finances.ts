/**
 * SP-API Finances API client.
 * Pulls financial events (sales, fees, refunds, reimbursements, etc.)
 * This is the primary data source for all bookkeeping pages.
 */

import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

interface FinancialEventGroup {
  ShipmentEventList?: any[];
  RefundEventList?: any[];
  ServiceFeeEventList?: any[];
  AdjustmentEventList?: any[];
  RemovalShipmentEventList?: any[];
  SellerReviewEnrollmentPaymentEventList?: any[];
  DebtRecoveryEventList?: any[];
  ProductAdsPaymentEventList?: any[];
  SAFETReimbursementEventList?: any[];
  [key: string]: any;
}

/**
 * Sync financial events from SP-API.
 * Paginates through all events in the date range.
 */
export async function syncFinancialEvents(
  credentials: SPAPICredentials,
  startDate: string,
  endDate?: string
): Promise<{ eventsProcessed: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let eventsProcessed = 0;
  let nextToken: string | undefined;

  try {
    do {
      const params: Record<string, string> = {};
      if (nextToken) {
        params.NextToken = nextToken;
      } else {
        params.PostedAfter = startDate;
        if (endDate) params.PostedBefore = endDate;
      }

      const response = await spApiRequest(
        credentials,
        '/finances/v0/financialEvents',
        params
      );

      const payload = response.payload;
      if (!payload) break;

      const eventGroup: FinancialEventGroup = payload.FinancialEvents || {};

      // Process Shipment Events (sales)
      if (eventGroup.ShipmentEventList) {
        for (const event of eventGroup.ShipmentEventList) {
          try {
            processShipmentEvent(db, event);
            eventsProcessed++;
          } catch (err) {
            errors.push(`ShipmentEvent error: ${err}`);
          }
        }
      }

      // Process Refund Events
      if (eventGroup.RefundEventList) {
        for (const event of eventGroup.RefundEventList) {
          try {
            processRefundEvent(db, event);
            eventsProcessed++;
          } catch (err) {
            errors.push(`RefundEvent error: ${err}`);
          }
        }
      }

      // Process Service Fee Events (monthly storage, subscription, etc.)
      if (eventGroup.ServiceFeeEventList) {
        for (const event of eventGroup.ServiceFeeEventList) {
          try {
            processServiceFeeEvent(db, event);
            eventsProcessed++;
          } catch (err) {
            errors.push(`ServiceFeeEvent error: ${err}`);
          }
        }
      }

      // Process Adjustment Events (reimbursements)
      if (eventGroup.AdjustmentEventList) {
        for (const event of eventGroup.AdjustmentEventList) {
          try {
            processAdjustmentEvent(db, event);
            eventsProcessed++;
          } catch (err) {
            errors.push(`AdjustmentEvent error: ${err}`);
          }
        }
      }

      // Process SAFE-T Reimbursements
      if (eventGroup.SAFETReimbursementEventList) {
        for (const event of eventGroup.SAFETReimbursementEventList) {
          try {
            processSafetReimbursement(db, event);
            eventsProcessed++;
          } catch (err) {
            errors.push(`SAFETReimbursement error: ${err}`);
          }
        }
      }

      // Process Shipping Label Costs (Buy Shipping / MFN labels)
      if (eventGroup.ShipmentServiceFeeList) {
        for (const event of eventGroup.ShipmentServiceFeeList) {
          try {
            processShippingLabelEvent(db, event);
            eventsProcessed++;
          } catch (err) {
            errors.push(`ShippingLabel error: ${err}`);
          }
        }
      }

      // Process Guarantee Claims (A-to-Z)
      if (eventGroup.GuaranteeClaimEventList) {
        for (const event of eventGroup.GuaranteeClaimEventList) {
          try {
            processGenericFinancialEvent(db, event, 'GuaranteeClaim');
            eventsProcessed++;
          } catch (err) {
            errors.push(`GuaranteeClaim error: ${err}`);
          }
        }
      }

      // Process Chargebacks
      if (eventGroup.ChargebackEventList) {
        for (const event of eventGroup.ChargebackEventList) {
          try {
            processGenericFinancialEvent(db, event, 'Chargeback');
            eventsProcessed++;
          } catch (err) {
            errors.push(`Chargeback error: ${err}`);
          }
        }
      }

      // Process Retrocharges (retroactive fee changes)
      if (eventGroup.RetrochargeEventList) {
        for (const event of eventGroup.RetrochargeEventList) {
          try {
            processGenericFinancialEvent(db, event, 'Retrocharge');
            eventsProcessed++;
          } catch (err) {
            errors.push(`Retrocharge error: ${err}`);
          }
        }
      }

      // Process Debt Recovery
      if (eventGroup.DebtRecoveryEventList) {
        for (const event of eventGroup.DebtRecoveryEventList) {
          try {
            processGenericFinancialEvent(db, event, 'DebtRecovery');
            eventsProcessed++;
          } catch (err) {
            errors.push(`DebtRecovery error: ${err}`);
          }
        }
      }

      // Process Seller Deal Payments (Lightning Deals)
      if (eventGroup.SellerDealPaymentEventList) {
        for (const event of eventGroup.SellerDealPaymentEventList) {
          try {
            processGenericFinancialEvent(db, event, 'SellerDeal');
            eventsProcessed++;
          } catch (err) {
            errors.push(`SellerDeal error: ${err}`);
          }
        }
      }

      // Process Removal Shipment Events
      if (eventGroup.RemovalShipmentEventList) {
        for (const event of eventGroup.RemovalShipmentEventList) {
          try {
            processRemovalEvent(db, event);
            eventsProcessed++;
          } catch (err) {
            errors.push(`RemovalEvent error: ${err}`);
          }
        }
      }

      nextToken = payload.NextToken;
    } while (nextToken);
  } finally {
    db.close();
  }

  return { eventsProcessed, errors };
}

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

/** Convert SP-API CurrencyAmount to integer cents */
function toCents(amount: { CurrencyAmount?: number; CurrencyCode?: string } | undefined): number {
  if (!amount || amount.CurrencyAmount === undefined) return 0;
  return Math.round(amount.CurrencyAmount * 100);
}

/** Categorize Amazon fee types into groups for P&L reporting */
function categorizeFee(feeType: string): string {
  const sellingFees = ['Commission', 'RefundCommission', 'VariableClosingFee', 'FixedClosingFee', 'HighVolumeListingFee'];
  const fbaTransactionFees = ['FBAPerUnitFulfillmentFee', 'FBAPerOrderFulfillmentFee', 'FBAWeightBasedFee', 'ShippingChargeback', 'ShippingChargeBack'];
  const fbaInventoryFees = ['FBAInboundTransportationFee', 'FBAStorageFee', 'FBALongTermStorageFee', 'FBARemovalFee', 'FBADisposalFee', 'FBAInboundTransportationProgramFee'];

  if (sellingFees.includes(feeType)) return 'Selling Fees';
  if (fbaTransactionFees.includes(feeType)) return 'FBA Transaction Fees';
  if (fbaInventoryFees.includes(feeType)) return 'FBA Inventory and Inbound Service Fees';
  return 'Other Fees';
}

function processShipmentEvent(db: Database.Database, event: any) {
  const orderId = event.AmazonOrderId;
  const postedDate = event.PostedDate;
  if (!orderId || !postedDate) return;

  const items = event.ShipmentItemList || [];
  const now = new Date().toISOString();

  for (const item of items) {
    const asin = item.SellerSKU ? undefined : undefined; // ASIN comes from catalog
    const sku = item.SellerSKU;
    const quantity = item.QuantityShipped || 1;

    // Calculate total amount from item charges
    let totalAmount = 0;
    const itemCharges = item.ItemChargeList || [];
    for (const charge of itemCharges) {
      totalAmount += toCents(charge.ChargeAmount);
    }

    // Insert financial event
    const result = db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ShipmentEvent', postedDate, orderId, item.ASIN || null, sku, 'amazon', totalAmount, JSON.stringify(event), now);

    const eventId = result.changes > 0 ? Number(result.lastInsertRowid) : null;

    // Insert broken-out fees (always attempt — OR IGNORE handles duplicates)
    if (eventId) {
      const itemFees = item.ItemFeeList || [];
      for (const fee of itemFees) {
        const feeAmount = toCents(fee.FeeAmount);
        if (feeAmount === 0) continue;
        db.prepare(`
          INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(eventId, orderId, item.ASIN || null, fee.FeeType, categorizeFee(fee.FeeType), feeAmount, postedDate);
      }
    }

    // Insert/update order — don't overwrite purchase_date if Orders API already set it
    db.prepare(`
      INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, created_at)
      VALUES (?, ?, 'Shipped', 'amazon', 'FBA', 0, ?)
      ON CONFLICT(order_id) DO UPDATE SET status = 'Shipped'
    `).run(orderId, postedDate, now);

    // Update shipping_charged from financial events if Orders API missed it
    const shippingChargeItem = itemCharges.find((c: any) => c.ChargeType === 'ShippingCharge');
    const shippingChargedAmount = toCents(shippingChargeItem?.ChargeAmount);
    if (shippingChargedAmount > 0) {
      db.prepare(
        'UPDATE order_items SET shipping_charged = ? WHERE order_id = ? AND shipping_charged = 0'
      ).run(shippingChargedAmount, orderId);
    }

    // Calculate promotional rebate
    const promotions = item.PromotionList || [];
    let promoTotal = 0;
    for (const promo of promotions) {
      promoTotal += toCents(promo.PromotionAmount);
    }

    // Only insert order items if Orders API hasn't already provided them
    const existingItem = db.prepare(
      'SELECT 1 FROM order_items WHERE order_id = ? LIMIT 1'
    ).get(orderId);

    if (!existingItem) {
      const priceCharge = itemCharges.find((c: any) => c.ChargeType === 'Principal');
      const price = toCents(priceCharge?.ChargeAmount);
      const shippingCharge = itemCharges.find((c: any) => c.ChargeType === 'Shipping');
      const shipping = toCents(shippingCharge?.ChargeAmount);

      db.prepare(`
        INSERT OR IGNORE INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, promotional_rebate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(orderId, item.ASIN || sku, sku, quantity, quantity > 0 ? Math.round(price / quantity) : price, price, shipping, promoTotal);
    } else if (promoTotal !== 0) {
      // Update promo on existing item if we have it
      db.prepare(
        'UPDATE order_items SET promotional_rebate = ? WHERE order_id = ? AND promotional_rebate = 0'
      ).run(promoTotal, orderId);
    }

    // Insert sales tax if present
    const taxCharges = item.ItemTaxWithheldList || [];
    for (const tax of taxCharges) {
      const taxChargeList = tax.TaxesWithheld || [];
      for (const tc of taxChargeList) {
        const taxAmount = toCents(tc.ChargeAmount);
        if (taxAmount === 0) continue;
        // Try to determine state from shipping address (not available here, use 'Unknown')
        db.prepare(`
          INSERT OR IGNORE INTO sales_tax (order_id, state, tax_collected, marketplace_facilitator_tax, posted_date)
          VALUES (?, ?, ?, ?, ?)
        `).run(orderId, 'Unknown', taxAmount, taxAmount, postedDate);
      }
    }

    // Upsert product
    if (item.ASIN) {
      db.prepare(`
        INSERT OR IGNORE INTO products (asin, sku, marketplace, created_at, updated_at)
        VALUES (?, ?, 'amazon', ?, ?)
      `).run(item.ASIN, sku, now, now);
    }
  }
}

function processRefundEvent(db: Database.Database, event: any) {
  const orderId = event.AmazonOrderId;
  const postedDate = event.PostedDate;
  if (!orderId || !postedDate) return;

  const now = new Date().toISOString();
  const items = event.ShipmentItemAdjustmentList || [];

  for (const item of items) {
    let refundAmount = 0;
    let feeClawback = 0;

    // Charges being refunded to customer
    const charges = item.ItemChargeAdjustmentList || [];
    for (const charge of charges) {
      refundAmount += Math.abs(toCents(charge.ChargeAmount));
    }

    // Fees being returned to seller
    const fees = item.ItemFeeAdjustmentList || [];
    for (const fee of fees) {
      const feeAmount = toCents(fee.FeeAmount);
      if (feeAmount > 0) {
        feeClawback += feeAmount; // Positive = money back to seller
      }
    }

    db.prepare(`
      INSERT OR IGNORE INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, postedDate, item.ASIN || null, item.SellerSKU, item.QuantityShipped || 1,
      refundAmount, 'CUSTOMER_RETURN', 0, feeClawback, 'amazon', now);

    // Also insert fee details for the clawback
    const result = db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('RefundEvent', postedDate, orderId, item.ASIN || null, item.SellerSKU, 'amazon', -refundAmount + feeClawback, JSON.stringify(event), now);

    const eventId = Number(result.lastInsertRowid);
    if (eventId > 0) {
      for (const fee of fees) {
        const feeAmount = toCents(fee.FeeAmount);
        if (feeAmount === 0) continue;
        db.prepare(`
          INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(eventId, orderId, item.ASIN || null, fee.FeeType, categorizeFee(fee.FeeType), feeAmount, postedDate);
      }
    }
  }
}

// Track service fees seen in this sync batch to avoid inserting duplicates
// from the same API response. Reset at the start of each sync.
const serviceFeeTracker = new Map<string, number>();
export function resetServiceFeeTracker() { serviceFeeTracker.clear(); }

function processServiceFeeEvent(db: Database.Database, event: any) {
  const now = new Date().toISOString();
  const fees = event.FeeList || [];
  const postedDate = event.PostedDate || now;

  for (const fee of fees) {
    const amount = toCents(fee.FeeAmount);
    if (amount === 0) continue;

    const feeType = fee.FeeType;
    const asin = event.ASIN || null;
    const sku = event.SellerSKU || null;
    const currency = fee.FeeAmount?.CurrencyCode || 'USD';

    // Build a dedup key: fee_type + amount + currency + asin + day
    const dedupKey = `${feeType}|${amount}|${currency}|${asin || ''}|${sku || ''}|${postedDate.substring(0, 10)}`;

    // Count how many of this exact fee we've seen in this sync batch
    const batchCount = (serviceFeeTracker.get(dedupKey) || 0) + 1;
    serviceFeeTracker.set(dedupKey, batchCount);

    // Count how many already exist in the DB for this day
    const dbCount = (db.prepare(`
      SELECT COUNT(*) as cnt FROM financial_events
      WHERE event_type = 'ServiceFeeEvent'
        AND total_amount = ?
        AND date(posted_date) = ?
        AND COALESCE(asin, '') = ?
        AND COALESCE(sku, '') = ?
    `).get(amount, postedDate.substring(0, 10), asin || '', sku || '') as any).cnt;

    // Only insert if this batch has seen more than the DB already has
    if (batchCount <= dbCount) continue;

    // Use INSERT OR IGNORE — the COALESCE unique index may still block some inserts
    // when timestamps collide. That's OK for order-linked events but service fees need
    // a unique timestamp. Append batch count to milliseconds to ensure uniqueness.
    const uniquePostedDate = postedDate.replace(/(\.\d+)?Z$/, `.${String(batchCount).padStart(3, '0')}Z`);
    const result = db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ServiceFeeEvent', uniquePostedDate, null, asin, sku, 'amazon', amount, JSON.stringify(event), now);

    if (result.changes > 0) {
      const eventId = Number(result.lastInsertRowid);
      db.prepare(`
        INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(eventId, null, asin, feeType, categorizeFee(feeType), amount, uniquePostedDate);
    }
  }
}

function processAdjustmentEvent(db: Database.Database, event: any) {
  const now = new Date().toISOString();
  const items = event.AdjustmentItemList || [];
  const postedDate = event.PostedDate || now;
  const adjustmentType = event.AdjustmentType || 'Unknown';

  for (const item of items) {
    const amount = toCents(item.TotalAmount);
    if (amount === 0) continue;

    // Dedup by reason + date + amount (not AdjustmentId — it changes on each API call)
    const existing = db.prepare(`
      SELECT 1 FROM reimbursements
      WHERE reason = ? AND reimbursement_date = ? AND amount = ? AND marketplace = 'amazon'
      LIMIT 1
    `).get(adjustmentType, postedDate, amount);

    // Skip if the canonical FBA Reimbursements Report already has this entry
    // (same date, amount, and either matching sku or asin). Canonical numeric
    // IDs supersede our ADJ-* placeholders.
    const canonical = db.prepare(`
      SELECT 1 FROM reimbursements
      WHERE marketplace = 'amazon'
        AND reimbursement_id GLOB '[0-9]*'
        AND date(reimbursement_date) = date(?)
        AND amount = ?
        AND (
          (? IS NOT NULL AND sku = ?)
          OR (? IS NOT NULL AND asin = ?)
        )
      LIMIT 1
    `).get(postedDate, amount, item.SellerSKU || null, item.SellerSKU || null, item.ASIN || null, item.ASIN || null);

    if (!existing && !canonical) {
      db.prepare(`
        INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.AdjustmentId || `ADJ-${Date.now()}`, postedDate,
        item.ASIN || null, item.SellerSKU || null,
        adjustmentType, amount, item.Quantity || 1,
        'Approved', 'amazon', now
      );
    }
  }
}

function processSafetReimbursement(db: Database.Database, event: any) {
  const now = new Date().toISOString();
  const postedDate = event.PostedDate || now;
  const amount = toCents(event.ReimbursedAmount);

  if (amount === 0) return;

  db.prepare(`
    INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.SAFETClaimId || `SAFET-${Date.now()}`, postedDate,
    null, null, `SAFE-T: ${event.ReasonCode || 'Unknown'}`,
    amount, 1, 'Paid', 'amazon', now
  );
}

function processGenericFinancialEvent(db: Database.Database, event: any, eventType: string) {
  const now = new Date().toISOString();
  const orderId = event.AmazonOrderId || event.OrderId || null;
  const postedDate = event.PostedDate || now;

  // Calculate total from charges and fees
  let totalAmount = 0;
  const charges = event.ShipmentItemAdjustmentList || event.ChargeList || event.ItemChargeList || [];
  for (const charge of charges) {
    const chargeAmount = charge.ChargeAmount || charge.Amount;
    if (chargeAmount) totalAmount += toCents(chargeAmount);
  }
  const fees = event.FeeList || event.ItemFeeList || [];
  for (const fee of fees) {
    totalAmount += toCents(fee.FeeAmount);
  }

  // Also check for a direct Amount field
  if (totalAmount === 0 && event.Amount) {
    totalAmount = toCents(event.Amount);
  }

  if (totalAmount === 0) return;

  db.prepare(`
    INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(eventType, postedDate, orderId, event.ASIN || null, event.SellerSKU || null, 'amazon', totalAmount, JSON.stringify(event), now);

  // Store as other_income if positive, or as a fee if negative
  if (totalAmount > 0) {
    db.prepare(`
      INSERT OR IGNORE INTO other_income (date, income_type, amount, description, marketplace, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(postedDate, eventType, totalAmount, `${eventType} for order ${orderId || 'N/A'}`, 'amazon', now);
  }
}

function processShippingLabelEvent(db: Database.Database, event: any) {
  const orderId = event.AmazonOrderId;
  const postedDate = event.PostedDate;
  if (!orderId) return;

  const fees = event.FeeList || [];
  for (const fee of fees) {
    const amount = Math.abs(toCents(fee.FeeAmount));
    if (amount === 0) continue;

    // PostageBilling = shipping label cost, PostageRefund = refund of label
    if (fee.FeeType === 'PostageBilling' || fee.FeeType === 'PostageRefund') {
      // Update the order_item's shipping_cost
      db.prepare(`
        UPDATE order_items SET shipping_cost = shipping_cost + ? WHERE order_id = ?
      `).run(fee.FeeType === 'PostageBilling' ? amount : -amount, orderId);
    }
  }
}

function processRemovalEvent(db: Database.Database, event: any) {
  const now = new Date().toISOString();
  const postedDate = event.PostedDate || now;
  const orderId = event.OrderId;
  const items = event.RemovalShipmentItemList || [];

  for (const item of items) {
    const fee = toCents(item.FeeAmount);

    db.prepare(`
      INSERT OR IGNORE INTO removals (removal_order_id, asin, sku, quantity, removal_type, reason, status, date_requested, fee, marketplace, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId || `REM-${Date.now()}`, item.ASIN || null, item.SellerSKU || null,
      item.Quantity || 1, item.RemovalDisposition || 'Return',
      'FBA Removal', 'Completed', postedDate, fee, 'amazon', now
    );
  }
}
