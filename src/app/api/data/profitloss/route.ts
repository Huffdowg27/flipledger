import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

// Subquery to get each order's date — cash basis (posted_date) or accrual (purchase_date)
const ORDER_POSTED_DATE = `(
  SELECT order_id, MIN(posted_date) as posted_date
  FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL
  GROUP BY order_id
)`;

const ORDER_PURCHASE_DATE = `(
  SELECT order_id, purchase_date as posted_date FROM orders
)`;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const db = getDb();

  let startDate = searchParams.get('startDate');
  let endDate = searchParams.get('endDate');
  if (!startDate) {
    const days = parseInt(searchParams.get('days') || '30');
    startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  }
  if (!endDate) {
    endDate = new Date().toISOString().split('T')[0];
  }
  const marketplace = searchParams.get('marketplace');
  const MF = marketplace ? `AND o.marketplace = '${marketplace}'` : '';
  const MF_R = marketplace ? `AND marketplace = '${marketplace}'` : '';
  const dateBasis = searchParams.get('dateBasis') || 'posted';
  const DATE_SUB = dateBasis === 'purchase' ? ORDER_PURCHASE_DATE : ORDER_POSTED_DATE;

  const endDateNext = new Date(new Date(endDate).getTime() + 86400000).toISOString().split('T')[0];

  try {
    // Income (by posted_date — cash basis)
    const salesIncome = db.prepare(`
      SELECT COALESCE(SUM(oi.total_price), 0) as total
      FROM order_items oi
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(startDate, endDateNext) as any;

    // MFN shipping credits (income — seller charges buyer for shipping)
    const mfnShippingCredits = db.prepare(`
      SELECT COALESCE(SUM(oi.shipping_charged), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF} AND o.fulfillment_channel IN ('MFN', 'Seller')
    `).get(startDate, endDateNext) as any;

    // FBA/WFS shipping credits (Amazon/Walmart charges buyer, passes to seller)
    const fbaShippingCredits = db.prepare(`
      SELECT COALESCE(SUM(oi.shipping_charged), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF} AND o.fulfillment_channel NOT IN ('MFN', 'Seller')
    `).get(startDate, endDateNext) as any;

    // Only include MFN shipping credits as income — FBA shipping credits are offset by ShippingChargeback fees
    const shippingCredits = { total: mfnShippingCredits.total };

    // Promotional rebates (negative — reduces income)
    const promoRebates = db.prepare(`
      SELECT COALESCE(SUM(oi.promotional_rebate), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(startDate, endDateNext) as any;

    const otherIncomeTotal = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM other_income WHERE date >= ? AND date < ? ${MF_R}
    `).get(startDate, endDateNext) as any;

    // COGS (FIFO)
    const cogsTotal = db.prepare(`
      SELECT COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as total
      FROM order_items oi
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
    `).get(startDate, endDateNext) as any;

    // Order-linked fees (by order's posted_date)
    // Use -SUM(amount) instead of SUM(ABS(amount)) so that positive clawbacks reduce the fee total
    const orderFees = db.prepare(`
      SELECT
        COALESCE(fd.fee_category, 'Other Fees') as category,
        fd.fee_type,
        COALESCE(-SUM(fd.amount), 0) as total
      FROM fee_details fd
      JOIN ${DATE_SUB} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE fd.order_id IS NOT NULL AND fd.order_id != ''
        AND fe.posted_date >= ? AND fe.posted_date < ? ${MF}
      GROUP BY fd.fee_category, fd.fee_type
    `).all(startDate, endDateNext) as any[];

    // Non-order fees (service fees like storage, inbound shipping, subscriptions)
    // These are marketplace-specific — filter by marketplace when one is selected
    const serviceFeeFilter = marketplace ? `AND fe.marketplace = '${marketplace}'` : '';
    const serviceFees = db.prepare(`
      SELECT
        COALESCE(fd.fee_category, 'Other Fees') as category,
        fd.fee_type,
        COALESCE(-SUM(fd.amount), 0) as total
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE (fd.order_id IS NULL OR fd.order_id = '')
        AND date(fd.posted_date) >= ?
        AND date(fd.posted_date) < ?
        ${serviceFeeFilter}
      GROUP BY fd.fee_category, fd.fee_type
    `).all(startDate, endDateNext) as any[];

    const feesByCategory = [...orderFees, ...serviceFees]
      .sort((a, b) => (a.category || '').localeCompare(b.category || '') || b.total - a.total);

    // Other expenses — only include when viewing All Marketplaces (they're business-wide, not marketplace-specific)
    const expensesByCategory = marketplace ? [] : db.prepare(`
      SELECT category, COALESCE(SUM(amount), 0) as total
      FROM expenses WHERE date >= ? AND date < ?
      GROUP BY category ORDER BY total DESC
    `).all(startDate, endDateNext) as any[];

    const totalExpenses = marketplace ? { total: 0 } : db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ? AND date < ?
    `).get(startDate, endDateNext) as any;

    // Shipping costs
    const shippingCosts = db.prepare(`
      SELECT COALESCE(SUM(oi.shipping_cost), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF} AND o.fulfillment_channel = 'MFN'
    `).get(startDate, endDateNext) as any;

    // Refunds — for Walmart, only count refunds that have a corresponding
    // WalmartRefundEvent in the recon report (i.e., Walmart has actually
    // deducted the seller). Walmart's Returns API surfaces refunds at customer-
    // initiation time, but the seller debit lags by 1-3 weeks. Counting at
    // initiation overstates expenses; matching to recon settlement gives true
    // cash basis matching Walmart's Net Payable view.
    const refundTotal = db.prepare(`
      SELECT COALESCE(SUM(refund_amount), 0) as total, COALESCE(SUM(fee_clawback), 0) as clawback
      FROM refunds r
      WHERE r.refund_date >= ? AND r.refund_date < ? ${MF_R.replace(/marketplace/g, 'r.marketplace')}
        AND (
          r.marketplace != 'walmart'
          OR EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.event_type = 'WalmartRefundEvent'
              AND fe.order_id = r.order_id
              AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
          )
        )
    `).get(startDate, endDateNext) as any;

    // Reimbursements
    const reimbTotal = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM reimbursements WHERE reimbursement_date >= ? AND reimbursement_date < ? ${MF_R}
    `).get(startDate, endDateNext) as any;

    // Sales tax
    const taxTotal = db.prepare(`
      SELECT COALESCE(SUM(tax_collected), 0) as collected, COALESCE(SUM(marketplace_facilitator_tax), 0) as facilitator
      FROM sales_tax WHERE posted_date >= ? AND posted_date < ? ${MF_R}
    `).get(startDate, endDateNext) as any;

    // Group fees into hierarchy
    const feeHierarchy: Record<string, { total: number; children: { name: string; amount: number }[] }> = {};
    for (const fee of feesByCategory) {
      if (!feeHierarchy[fee.category]) {
        feeHierarchy[fee.category] = { total: 0, children: [] };
      }
      feeHierarchy[fee.category].total += fee.total;
      feeHierarchy[fee.category].children.push({ name: fee.fee_type, amount: fee.total });
    }

    const totalIncome = salesIncome.total + shippingCredits.total + otherIncomeTotal.total;
    const totalFees = Object.values(feeHierarchy).reduce((sum: number, cat: any) => sum + cat.total, 0);
    const totalAllExpenses = cogsTotal.total + totalFees + shippingCosts.total + totalExpenses.total;
    const netProfit = totalIncome - totalAllExpenses - refundTotal.total + refundTotal.clawback + reimbTotal.total;

    // Sales detail — individual products sold in the period, with per-order fees
    const salesDetail = db.prepare(`
      SELECT
        oi.order_id,
        o.marketplace,
        o.fulfillment_channel,
        COALESCE(p.name, oi.asin) as product_name,
        oi.asin,
        oi.sku,
        oi.quantity,
        oi.total_price as revenue,
        oi.cogs_per_unit * oi.quantity as cogs,
        COALESCE(order_fees.total_fees, 0) as fees,
        oi.shipping_cost as shippingCost,
        oi.total_price - (oi.cogs_per_unit * oi.quantity) + COALESCE(order_fees.total_fees, 0) - COALESCE(oi.shipping_cost, 0) as net_profit,
        fe.posted_date,
        o.purchase_date
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      LEFT JOIN products p ON p.asin IN (oi.asin, oi.sku)
      LEFT JOIN (
        SELECT order_id, SUM(amount) as total_fees
        FROM fee_details
        WHERE order_id IS NOT NULL AND order_id != ''
        GROUP BY order_id
      ) order_fees ON oi.order_id = order_fees.order_id
      WHERE fe.posted_date >= ? AND fe.posted_date < ? ${MF}
      ORDER BY fe.posted_date DESC
      LIMIT 500
    `).all(startDate, endDateNext) as any[];

    // Refund detail for the period.
    //
    // Amazon refunds often arrive with an EMPTY asin and the numeric MSKU in
    // r.sku (e.g. "1070389709"). The products table is keyed by real ASIN
    // (B0…), so direct r.asin → products.asin and r.sku → products.asin joins
    // both fail. The fix: go through order_items (which has the real ASIN + a
    // products.name-compatible row) via r.order_id. We also try the historic
    // fallbacks (r.asin → products.asin, r.sku → products.asin or sku) to
    // handle marketplaces where refunds.asin is actually populated (Walmart,
    // eBay historical).
    const refundDetail = db.prepare(`
      SELECT
        r.order_id,
        r.marketplace,
        COALESCE(
          p_via_oi.name,   -- real ASIN resolved through order_items
          p.name,          -- refunds.asin → products.asin
          p2.name,         -- refunds.sku → products.asin (legacy)
          p3.name,         -- refunds.sku → products.sku (Walmart/eBay path)
          oi.asin,         -- if we got a real ASIN from order_items but no products row, display it
          NULLIF(r.asin, ''),
          r.sku
        ) as product_name,
        COALESCE(NULLIF(r.asin, ''), oi.asin) as asin,
        r.sku,
        r.quantity,
        r.refund_amount,
        r.fee_clawback,
        r.reason,
        r.refund_date
      FROM refunds r
      LEFT JOIN order_items oi
        ON oi.order_id = r.order_id
        AND (
          oi.sku = r.sku
          OR oi.asin = r.asin
          OR (NULLIF(r.asin, '') IS NULL AND NULLIF(r.sku, '') IS NOT NULL)
        )
      LEFT JOIN products p_via_oi ON p_via_oi.asin = oi.asin
      LEFT JOIN products p  ON p.asin = r.asin AND r.asin != ''
      LEFT JOIN products p2 ON p2.asin = r.sku
      LEFT JOIN products p3 ON p3.sku  = r.sku
      WHERE r.refund_date >= ? AND r.refund_date < ? ${marketplace ? `AND r.marketplace = '${marketplace}'` : ''}
        AND (
          r.marketplace != 'walmart'
          OR EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.event_type = 'WalmartRefundEvent'
              AND fe.order_id = r.order_id
              AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
          )
        )
      GROUP BY r.id
      ORDER BY r.refund_date DESC
      LIMIT 200
    `).all(startDate, endDateNext) as any[];

    db.close();

    return NextResponse.json({
      income: {
        sales: salesIncome.total,
        shippingCredits: shippingCredits.total,
        mfnShippingCredits: mfnShippingCredits.total,
        fbaShippingCredits: fbaShippingCredits.total,
        promoRebates: promoRebates.total,
        otherIncome: otherIncomeTotal.total,
        total: totalIncome,
      },
      expenses: {
        cogs: cogsTotal.total,
        feeHierarchy,
        shippingCosts: shippingCosts.total,
        otherExpenses: totalExpenses.total,
        otherExpensesByCategory: expensesByCategory,
        totalFees,
        total: totalAllExpenses,
      },
      refunds: {
        total: refundTotal.total,
        clawback: refundTotal.clawback,
        net: refundTotal.total - refundTotal.clawback,
      },
      reimbursements: reimbTotal.total,
      salesTax: {
        collected: taxTotal.collected,
        facilitator: taxTotal.facilitator,
      },
      netProfit,
      margin: totalIncome > 0 ? (netProfit / totalIncome) * 100 : 0,
      dateBasis,
      salesDetail,
      refundDetail,
    });
  } catch (error) {
    db.close();
    console.error('P&L API error:', error);
    return NextResponse.json({ error: 'Failed to load P&L data' }, { status: 500 });
  }
}
