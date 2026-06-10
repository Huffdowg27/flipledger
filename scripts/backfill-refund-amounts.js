#!/usr/bin/env node
/**
 * One-off backfill: re-derive refunds.refund_amount + refunds.restocking_fee
 * from the raw RefundEvent JSON stored in financial_events.raw_data.
 *
 * Why: the old processRefundEvent took Math.abs() of EVERY charge adjustment,
 * so restocking fees (seller income) and marketplace-facilitator tax were
 * counted as refund expense, and promo clawbacks were ignored.
 *
 * Matching: old rows are located by (order_id, sku, asin, refund_date,
 * old_abs_amount) where old_abs_amount is recomputed with the OLD formula —
 * deterministic against the same raw data the row was inserted from.
 *
 * Idempotent: a second run recomputes the same old amounts, finds no rows
 * still carrying them (already updated), and reports them as alreadyDone.
 */
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'flipledger.db'));
db.pragma('journal_mode = WAL');

const toCents = (a) => (!a || a.CurrencyAmount === undefined) ? 0 : Math.round(a.CurrencyAmount * 100);

const events = db.prepare(`
  SELECT DISTINCT raw_data FROM financial_events
  WHERE event_type = 'RefundEvent' AND raw_data IS NOT NULL AND marketplace = 'amazon'
`).all();

const findOld = db.prepare(`
  SELECT id, refund_amount, restocking_fee FROM refunds
  WHERE order_id = ? AND COALESCE(sku,'') = ? AND COALESCE(asin,'') = ?
    AND refund_date = ? AND refund_amount = ? AND marketplace = 'amazon'
`);
const findNew = db.prepare(`
  SELECT id FROM refunds
  WHERE order_id = ? AND COALESCE(sku,'') = ? AND COALESCE(asin,'') = ?
    AND refund_date = ? AND refund_amount = ? AND marketplace = 'amazon'
`);
const update = db.prepare(`UPDATE refunds SET refund_amount = ?, restocking_fee = ? WHERE id = ?`);
const del = db.prepare(`DELETE FROM refunds WHERE id = ?`);

let updated = 0, alreadyDone = 0, noMatch = 0, dupesRemoved = 0, parseErrors = 0;
let taxRemoved = 0, restockingMoved = 0, promoApplied = 0;

const run = db.transaction(() => {
  for (const row of events) {
    let event;
    try { event = JSON.parse(row.raw_data); } catch { parseErrors++; continue; }
    const orderId = event.AmazonOrderId;
    const postedDate = event.PostedDate;
    if (!orderId || !postedDate) continue;

    for (const item of event.ShipmentItemAdjustmentList || []) {
      const charges = item.ItemChargeAdjustmentList || [];
      const promos = item.PromotionAdjustmentList || [];

      // OLD formula (what the buggy code stored)
      let oldAmount = 0;
      for (const c of charges) oldAmount += Math.abs(toCents(c.ChargeAmount));

      // NEW formula (matches the fixed processRefundEvent)
      let newAmount = 0, restocking = 0, taxPart = 0;
      for (const c of charges) {
        const t = c.ChargeType || '';
        const cents = toCents(c.ChargeAmount);
        if (t === 'RestockingFee') { restocking += cents; continue; }
        if (t.includes('Tax')) { taxPart += Math.abs(cents); continue; }
        newAmount += -cents;
      }
      for (const p of promos) {
        const cents = toCents(p.PromotionAmount);
        if (cents !== 0) { newAmount += -cents; promoApplied++; }
      }

      const sku = item.SellerSKU || '';
      const asin = item.ASIN || '';
      const old = findOld.get(orderId, sku, asin, postedDate, oldAmount);
      if (!old) {
        // Either already migrated on a previous pass, or never inserted.
        const done = findNew.get(orderId, sku, asin, postedDate, newAmount);
        if (done) alreadyDone++; else noMatch++;
        continue;
      }
      if (oldAmount === newAmount && restocking === 0) { alreadyDone++; continue; }

      // If a row with the new tuple already exists, this row is a duplicate.
      const clash = findNew.get(orderId, sku, asin, postedDate, newAmount);
      if (clash && clash.id !== old.id) { del.run(old.id); dupesRemoved++; continue; }

      update.run(newAmount, restocking, old.id);
      updated++;
      if (restocking > 0) restockingMoved++;
      if (taxPart > 0) taxRemoved++;
    }
  }
});
run();

console.log(JSON.stringify({
  rawEvents: events.length, updated, alreadyDone, noMatch, dupesRemoved, parseErrors,
  itemsWithRestocking: restockingMoved, itemsWithTaxRemoved: taxRemoved, promoAdjustmentsApplied: promoApplied,
}, null, 2));

const check = db.prepare(`
  SELECT COALESCE(SUM(refund_amount),0)/100.0 AS total, COALESCE(SUM(restocking_fee),0)/100.0 AS restocking
  FROM refunds WHERE refund_date >= '2026-06-01' AND refund_date < '2026-06-07' AND marketplace='amazon'
`).get();
console.log('Window 6/1-6/6 after backfill:', check);
db.close();
