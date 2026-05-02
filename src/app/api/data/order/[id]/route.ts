/**
 * Unified order detail — every record in the DB tied to a single order_id.
 * Used by /lookup/[id] page to give a single-pane-of-glass view for
 * investigations like "did Walmart actually pay me back for X?".
 */

import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await context.params;
  const orderId = decodeURIComponent(rawId);

  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const order = db.prepare(`
      SELECT order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, created_at
      FROM orders WHERE order_id = ?
    `).get(orderId) as { order_id: string; purchase_date: string; status: string; marketplace: string; fulfillment_channel: string; is_estimated: number; created_at: string } | undefined;

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const items = db.prepare(`
      SELECT oi.id, oi.asin, oi.sku, oi.quantity, oi.price_per_unit, oi.total_price,
             oi.shipping_charged, oi.shipping_cost, oi.promotional_rebate, oi.cogs_per_unit,
             COALESCE(p.name, li.product_name, oi.sku, oi.asin) AS product_name,
             p.image_url, p.category
      FROM order_items oi
      LEFT JOIN products p ON p.asin = oi.asin OR p.asin = oi.sku
      LEFT JOIN live_inventory li ON li.sku = oi.sku
      WHERE oi.order_id = ?
      GROUP BY oi.id
    `).all(orderId) as Array<{ id: number; asin: string; sku: string; quantity: number; price_per_unit: number; total_price: number; shipping_charged: number; shipping_cost: number; promotional_rebate: number; cogs_per_unit: number; product_name: string; image_url: string | null; category: string | null }>;

    const financialEvents = db.prepare(`
      SELECT id, event_type, posted_date, asin, sku, total_amount, raw_data, created_at
      FROM financial_events
      WHERE order_id = ?
      ORDER BY posted_date, id
    `).all(orderId) as Array<{ id: number; event_type: string; posted_date: string; asin: string | null; sku: string | null; total_amount: number; raw_data: string | null; created_at: string }>;

    const events = financialEvents.map((e) => {
      let txType: string | null = null;
      let amtType: string | null = null;
      let txDesc: string | null = null;
      try {
        if (e.raw_data) {
          const r = JSON.parse(e.raw_data);
          txType = r['Transaction Type'] || null;
          amtType = r['Amount Type'] || null;
          txDesc = r['Transaction Description'] || null;
        }
      } catch {}
      return {
        id: e.id,
        eventType: e.event_type,
        postedDate: e.posted_date,
        amountCents: e.total_amount,
        asin: e.asin,
        sku: e.sku,
        txType,
        amtType,
        txDesc,
      };
    });

    const fees = db.prepare(`
      SELECT id, fee_type, fee_category, amount, posted_date
      FROM fee_details WHERE order_id = ?
      ORDER BY posted_date, id
    `).all(orderId) as Array<{ id: number; fee_type: string; fee_category: string; amount: number; posted_date: string }>;

    const refunds = db.prepare(`
      SELECT id, refund_date, asin, sku, quantity, refund_amount, reason, fee_clawback, marketplace
      FROM refunds WHERE order_id = ?
      ORDER BY refund_date, id
    `).all(orderId) as Array<{ id: number; refund_date: string; asin: string | null; sku: string | null; quantity: number; refund_amount: number; reason: string | null; fee_clawback: number; marketplace: string }>;

    const reimbursements = db.prepare(`
      SELECT id, reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace
      FROM reimbursements
      WHERE reimbursement_id LIKE '%' || ? || '%'
         OR (sku IS NOT NULL AND sku IN (SELECT DISTINCT sku FROM order_items WHERE order_id = ?))
      ORDER BY reimbursement_date DESC
    `).all(orderId, orderId).slice(0, 20) as Array<{ id: number; reimbursement_id: string; reimbursement_date: string; asin: string | null; sku: string | null; reason: string | null; amount: number; quantity: number; status: string; marketplace: string }>;

    const refundIds = refunds.map((r) => r.id);
    let amazonDisputes: Array<{ id: number; refund_id: number; eligibility: string; status: string; refund_amount_cents: number; return_reason: string | null }> = [];
    let walmartDisputes: typeof amazonDisputes = [];
    if (refundIds.length > 0) {
      const placeholders = refundIds.map(() => '?').join(',');
      amazonDisputes = db.prepare(`
        SELECT id, refund_id, eligibility, status, refund_amount_cents, return_reason
        FROM amazon_dispute_candidates WHERE refund_id IN (${placeholders})
      `).all(...refundIds) as typeof amazonDisputes;
      walmartDisputes = db.prepare(`
        SELECT id, refund_id, eligibility, status, refund_amount_cents, return_reason
        FROM walmart_dispute_candidates WHERE refund_id IN (${placeholders})
      `).all(...refundIds) as typeof walmartDisputes;
    }

    // Net P&L computed from financial_events (signed)
    const netCents = financialEvents.reduce((sum, e) => sum + e.total_amount, 0);
    const totalCogsCents = items.reduce((sum, i) => sum + (i.cogs_per_unit * i.quantity), 0);

    return NextResponse.json({
      order,
      items,
      events,
      fees,
      refunds,
      reimbursements,
      amazonDisputes,
      walmartDisputes,
      summary: {
        netCents,
        totalCogsCents,
        profitCents: netCents - totalCogsCents,
        eventCount: events.length,
        feeCount: fees.length,
        refundCount: refunds.length,
        reimbursementCount: reimbursements.length,
      },
    });
  } finally {
    db.close();
  }
}
