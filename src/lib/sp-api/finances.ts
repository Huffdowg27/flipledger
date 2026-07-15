/**
 * SP-API Finances API client.
 * Pulls financial events (sales, fees, refunds, reimbursements, etc.)
 * This is the primary data source for all bookkeeping pages.
 */

import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';
import { storeRemovalShipmentEvent } from '../removal-events';
import { storeShippingLabelFee } from '../shipping-label-events';

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
            processServiceFeeEvent(db, event, startDate);
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

      // Process Product Ads Payments (sponsored ads invoices)
      if (eventGroup.ProductAdsPaymentEventList) {
        for (const event of eventGroup.ProductAdsPaymentEventList) {
          try {
            processProductAdsPaymentEvent(db, event);
            eventsProcessed++;
          } catch (err) {
            errors.push(`ProductAdsPayment error: ${err}`);
          }
        }
      }

      // Process Removal Shipment Events
      if (eventGroup.RemovalShipmentEventList) {
        for (const event of eventGroup.RemovalShipmentEventList) {
          try {
            storeRemovalShipmentEvent(db, event);
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
  // ShippingHB = shipping holdback (referral fee on buyer-paid shipping).
  // InventoryLab groups it with closing fees under selling fees; keeping it
  // there makes FL's Selling Fees line reconcile 1:1 against IL.
  const sellingFees = ['Commission', 'RefundCommission', 'VariableClosingFee', 'FixedClosingFee', 'HighVolumeListingFee', 'ShippingHB'];
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
    let restockingFee = 0;

    // Charges being refunded to customer. Adjustments post NEGATIVE when money
    // goes back to the buyer, so negate to store the refund as a positive cost.
    // Two charge types are NOT refund costs and must stay out of refund_amount:
    // - RestockingFee posts positive — money the seller KEEPS (income).
    // - Tax/ShippingTax are marketplace-facilitator money; Amazon collects and
    //   remits both legs, so neither direction touches seller profit.
    const charges = item.ItemChargeAdjustmentList || [];
    for (const charge of charges) {
      const chargeType: string = charge.ChargeType || '';
      if (chargeType === 'RestockingFee') {
        restockingFee += toCents(charge.ChargeAmount);
        continue;
      }
      if (chargeType.includes('Tax')) continue;
      refundAmount += -toCents(charge.ChargeAmount);
    }

    // Promotion adjustments post POSITIVE when a promo discount is clawed back
    // from the buyer's refund — they reduce what the seller pays out.
    const promos = item.PromotionAdjustmentList || [];
    for (const promo of promos) {
      refundAmount += -toCents(promo.PromotionAmount);
    }

    // Fees being returned to seller
    const fees = item.ItemFeeAdjustmentList || [];
    for (const fee of fees) {
      const feeAmount = toCents(fee.FeeAmount);
      if (feeAmount > 0) {
        feeClawback += feeAmount; // Positive = money back to seller
      }
    }

    // ON CONFLICT: keep the highest fee_clawback seen across sync runs.
    // Amazon sometimes sends the same refund item twice — once with fee credits
    // and once without — so we upsert to always preserve the real credit amount.
    db.prepare(`
      INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, restocking_fee, marketplace, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_id, COALESCE(sku,''), COALESCE(asin,''), refund_date, refund_amount, marketplace)
      DO UPDATE SET fee_clawback = MAX(fee_clawback, excluded.fee_clawback),
                    restocking_fee = MAX(restocking_fee, excluded.restocking_fee)
    `).run(orderId, postedDate, item.ASIN || null, item.SellerSKU, item.QuantityShipped || 1,
      refundAmount, 'CUSTOMER_RETURN', 0, feeClawback, restockingFee, 'amazon', now);

    // Also insert fee details for the clawback
    const result = db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('RefundEvent', postedDate, orderId, item.ASIN || null, item.SellerSKU, 'amazon', -refundAmount + feeClawback + restockingFee, JSON.stringify(event), now);

    if (result.changes > 0) {
      const eventId = Number(result.lastInsertRowid);
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

// Sponsored ads invoices. NOTE: unlike every other financial event type,
// ProductAdsPaymentEvent uses lowerCamelCase field names (postedDate,
// invoiceId, transactionValue) — a documented SP-API inconsistency. Read both
// casings defensively. The invoiceId is stored in order_id purely as a stable
// identity key for the financial_events unique index.
function processProductAdsPaymentEvent(db: Database.Database, event: any) {
  const postedDate = event.postedDate || event.PostedDate;
  if (!postedDate) return;
  const invoiceId = event.invoiceId || event.InvoiceId || null;
  let amount = toCents(event.transactionValue || event.TransactionValue);
  if (amount === 0) amount = toCents(event.baseValue || event.BaseValue);
  if (amount === 0) return;

  // Normalize sign: ad charges are costs (negative), refunds are credits.
  const txType = String(event.transactionType || event.TransactionType || '').toLowerCase();
  const signed = txType === 'refund' ? Math.abs(amount) : -Math.abs(amount);

  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ProductAdsPaymentEvent', postedDate, invoiceId, null, null, 'amazon', signed, JSON.stringify(event), now);

  if (result.changes > 0) {
    // order_id stays NULL so the P&L picks this up via its non-order
    // (service fee) query — invoiceId is not a customer order.
    db.prepare(`
      INSERT INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
      VALUES (?, NULL, NULL, 'CostOfAdvertising', 'Cost of Advertising', ?, ?)
    `).run(Number(result.lastInsertRowid), signed, postedDate);
  }
}

// Track service fees seen in this sync batch to avoid inserting duplicates
// from the same API response. Reset at the start of each sync.
const serviceFeeTracker = new Map<string, number>();
export function resetServiceFeeTracker() { serviceFeeTracker.clear(); }

function processServiceFeeEvent(db: Database.Database, event: any, contextDate: string) {
  const now = new Date().toISOString();
  const fees = event.FeeList || [];
  // Amazon's ServiceFeeEvent does not include a PostedDate field — use the
  // sync chunk's startDate so fees land in the correct period, not today.
  const postedDate = event.PostedDate || contextDate;
  // FBA inbound fees carry an AmazonOrderId that is an FBA shipment plan ID
  // (e.g. FBA198R06DXG), not a customer order. We use it as a stable identity
  // key so the same fee doesn't re-insert on every sync run.
  const shipmentId: string | null = event.AmazonOrderId || null;

  for (const fee of fees) {
    const amount = toCents(fee.FeeAmount);
    if (amount === 0) continue;

    const feeType = fee.FeeType;
    const asin = event.ASIN || null;
    const sku = event.SellerSKU || null;
    const currency = fee.FeeAmount?.CurrencyCode || 'USD';

    if (shipmentId) {
      // Shipment-plan fees: dedup by (fee_type, shipment_id, amount).
      // The date-based path below would re-insert the same fee on every sync
      // because contextDate moves forward daily and ServiceFeeEvent has no
      // PostedDate of its own.
      const alreadyStored = (db.prepare(`
        SELECT COUNT(*) as cnt
        FROM fee_details fd
        JOIN financial_events fe ON fd.financial_event_id = fe.id
        WHERE fe.event_type = 'ServiceFeeEvent'
          AND fd.fee_type = ?
          AND fd.amount = ?
          AND json_extract(fe.raw_data, '$.AmazonOrderId') = ?
      `).get(feeType, amount, shipmentId) as any).cnt > 0;

      if (alreadyStored) continue;

      const result = db.prepare(`
        INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ServiceFeeEvent', postedDate, null, asin, sku, 'amazon', amount, JSON.stringify(event), now);

      if (result.changes > 0) {
        const eventId = Number(result.lastInsertRowid);
        db.prepare(`
          INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(eventId, null, asin, feeType, categorizeFee(feeType), amount, postedDate);
      }
      continue;
    }

    // Non-shipment service fees (storage, subscription, etc.): use existing
    // date + batch dedup. These fees have no stable identity key other than
    // (fee_type, amount, asin, sku, day).

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

    // INSERT OR IGNORE relies on idx_reimbursements_unique:
    // (marketplace, reason, date(reimbursement_date), amount, sku, asin)
    // This deduplicates across re-sync runs regardless of timestamp precision
    // or whether Amazon returns an AdjustmentId.
    db.prepare(`
      INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.AdjustmentId || `ADJ-${postedDate}-${adjustmentType}-${amount}`, postedDate,
      item.ASIN || null, item.SellerSKU || null,
      adjustmentType, amount, item.Quantity || 1,
      'Approved', 'amazon', now
    );
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
  if (!orderId || !postedDate) {
    throw new Error('shipping-label event missing AmazonOrderId or PostedDate');
  }

  const fees = event.FeeList || [];
  for (const fee of fees) {
    const amount = Math.abs(toCents(fee.FeeAmount));
    if (amount === 0) continue;

    // PostageBilling = shipping label cost, PostageRefund = refund of label
    if (fee.FeeType === 'PostageBilling' || fee.FeeType === 'PostageRefund') {
      storeShippingLabelFee(db, {
        orderId,
        postedDate,
        feeType: fee.FeeType,
        amountCents: amount,
        rawData: JSON.stringify(event),
      });
    }
  }
}
