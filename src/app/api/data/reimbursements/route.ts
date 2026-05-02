import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

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
  const endDateNext = new Date(new Date(endDate).getTime() + 86400000).toISOString().split('T')[0];

  const marketplace = searchParams.get('marketplace');
  // Qualify with `r.` — the products table also has a `marketplace` column,
  // so an unqualified reference raises "ambiguous column name" in SQLite and
  // silently returned 0 rows in the API path.
  const MF_R = marketplace ? `AND r.marketplace = '${marketplace}'` : '';

  try {
    // Amazon reimbursements
    const amazonRows = db.prepare(`
      SELECT
        r.reimbursement_date as date,
        r.reimbursement_id as reimbursementId,
        r.asin,
        r.sku,
        COALESCE(p.name, p2.name,
          (SELECT p3.name FROM order_items oi JOIN products p3 ON oi.asin = p3.asin WHERE oi.sku = r.sku LIMIT 1),
          r.asin, r.sku) as productName,
        r.reason,
        r.amount,
        r.quantity,
        r.status,
        COALESCE(r.marketplace, 'amazon') as marketplace
      FROM reimbursements r
      LEFT JOIN products p ON r.asin = p.asin
      LEFT JOIN products p2 ON r.sku = p2.sku
      WHERE r.reimbursement_date >= ? AND r.reimbursement_date < ? ${MF_R}
      ORDER BY r.reimbursement_date DESC
    `).all(startDate, endDateNext) as any[];

    // Walmart adjustment credits (WFS Refund, Customer Return Reversal, etc.)
    // These are positive fee_details from Walmart recon that represent money back
    let walmartRows: any[] = [];
    if (!marketplace || marketplace === 'walmart') {
      walmartRows = db.prepare(`
        SELECT
          fe.posted_date as date,
          fe.id as reimbursementId,
          fe.order_id as _orderId,
          json_extract(fe.raw_data, '$."Customer Order #"') as _customerOrderId,
          fe.sku as asin,
          fe.sku,
          COALESCE(p.name, fe.sku) as productName,
          COALESCE(json_extract(fe.raw_data, '$."Transaction Description"'), fd.fee_type, 'Adjustment Credit') as reason,
          ABS(fd.amount) as amount,
          1 as quantity,
          'Credited' as status,
          'walmart' as marketplace
        FROM financial_events fe
        JOIN fee_details fd ON fd.financial_event_id = fe.id
        LEFT JOIN products p ON fe.sku = p.asin
        WHERE fe.marketplace = 'walmart'
          AND fd.amount > 0
          AND fe.posted_date >= ? AND fe.posted_date < ?
          -- Exclude refund commission clawbacks. They neutralize the original
          -- referral fee charged on the sale (already netted in P&L), not a
          -- separate income event. Walmart Seller Center treats sale + clawback
          -- as a single net line and so should we.
          AND fd.fee_type != 'WalmartReferralFeeClawback'
        ORDER BY fe.posted_date DESC
      `).all(startDate, endDateNext) as any[];
    }

    // Attach related order context per reimbursement so the global table
    // search can match by PO / Customer Order # too.
    //
    // Strategy:
    //  1. WMT-DISPUTE-* IDs encode the Walmart Transaction Key. JOIN on it.
    //  2. WMT-INCENTIVE-{order_id}-{sku}-{price} — parse out the order_id.
    //  3. Walmart credits sourced from financial_events directly (rows from
    //     walmartRows above) — order_id is on the source row.
    //  4. Amazon ADJ-* IDs — look up the AdjustmentEvent in financial_events.
    //  5. Numeric Amazon reimbursement IDs (FBA Reimbursements Report) and
    //     SETTLEMENT-* synthetic IDs — no order link unless we can match by
    //     sku to a same-day order, which is fuzzy. Skip rather than guess.
    const orderContextStmt = db.prepare(`
      SELECT order_id,
             json_extract(raw_data, '$."Customer Order #"') AS customer_order_id
      FROM financial_events
      WHERE order_id IS NOT NULL
        AND (
             json_extract(raw_data, '$."Transaction Key"') = ?
          OR id = ?
        )
      LIMIT 1
    `);

    function parseWmtIncentiveOrderId(reimbursementId: string): string | null {
      // Format: WMT-INCENTIVE-{14-19 digit PO}-{sku}-{price}
      const m = reimbursementId.match(/^WMT-INCENTIVE-(\d{12,})-/);
      return m ? m[1] : null;
    }

    function attachOrderContext(row: Record<string, unknown>): { orderId: string | null; customerOrderId: string | null } {
      const id = String(row.reimbursementId);
      // Walmart credits sourced from financial_events already carry both
      if (row._orderId !== undefined && row._orderId !== null) {
        return {
          orderId: String(row._orderId),
          customerOrderId: row._customerOrderId ? String(row._customerOrderId) : null,
        };
      }
      // Walmart dispute reimbursements
      if (id.startsWith('WMT-DISPUTE-')) {
        const txKey = id.replace(/^WMT-DISPUTE-/, '');
        const ctx = orderContextStmt.get(txKey, null) as { order_id: string; customer_order_id: string } | undefined;
        return { orderId: ctx?.order_id || null, customerOrderId: ctx?.customer_order_id || null };
      }
      // Walmart commission incentive
      if (id.startsWith('WMT-INCENTIVE-')) {
        const orderId = parseWmtIncentiveOrderId(id);
        return { orderId, customerOrderId: null };
      }
      // Amazon AdjustmentEvent — id matches financial_events.AdjustmentId stored as reimbursement_id
      if (id.startsWith('ADJ-')) {
        const ctx = db.prepare(`
          SELECT fe.order_id,
                 json_extract(fe.raw_data, '$."Customer Order #"') AS customer_order_id
          FROM reimbursements r
          JOIN financial_events fe ON fe.event_type = 'AdjustmentEvent'
          WHERE r.reimbursement_id = ?
            AND fe.order_id IS NOT NULL
            AND fe.posted_date = r.reimbursement_date
            AND fe.total_amount = r.amount
          LIMIT 1
        `).get(id) as { order_id: string; customer_order_id: string } | undefined;
        return { orderId: ctx?.order_id || null, customerOrderId: ctx?.customer_order_id || null };
      }
      return { orderId: null, customerOrderId: null };
    }

    // walmartRows already carry _orderId + _customerOrderId from the SQL above.
    const allItems = [...amazonRows, ...walmartRows].map((row) => {
      const ctx = attachOrderContext(row);
      return {
        date: row.date,
        reimbursementId: String(row.reimbursementId),
        asin: row.asin,
        sku: row.sku,
        productName: row.productName,
        reason: row.reason,
        amount: row.amount,
        quantity: row.quantity,
        status: row.status,
        marketplace: row.marketplace || 'amazon',
        orderId: ctx.orderId,
        customerOrderId: ctx.customerOrderId,
      };
    }).sort((a, b) => b.date.localeCompare(a.date));

    const count = allItems.length;
    const totalAmount = allItems.reduce((s, i) => s + i.amount, 0);

    db.close();

    return NextResponse.json({
      items: allItems,
      totals: { count, totalAmount },
    });
  } catch (error) {
    db.close();
    console.error('Reimbursements API error:', error);
    return NextResponse.json({ error: 'Failed to load reimbursements data' }, { status: 500 });
  }
}
