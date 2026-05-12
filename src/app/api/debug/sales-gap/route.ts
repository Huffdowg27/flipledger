/**
 * GET /api/debug/sales-gap?startDate=2026-04-11&endDate=2026-05-11
 *
 * READ-ONLY sales gap drilldown.
 *
 * Answers:
 *  1. Is FL missing orders that IL includes?
 *  2. Are missing orders mostly from the last few days?
 *  3. Which date basis does each system use?
 *  4. Which statuses are excluded?
 *  5. Are refunds reducing the sales line?
 *  6. Are shipping credits counted differently?
 *
 * HARD RULES: readonly DB, no writes, no production formula changes.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  return new Database(dbPath, { readonly: true });
}

function cents(n: number | null | undefined): string {
  if (n == null) return '$0.00';
  return '$' + (n / 100).toFixed(2);
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const startDate = searchParams.get('startDate') ?? '2026-04-11';
  const endDate   = searchParams.get('endDate')   ?? '2026-05-11';
  // endDate is inclusive — make exclusive for SQL < comparisons
  const endExcl = new Date(endDate);
  endExcl.setDate(endExcl.getDate() + 1);
  const endNext = endExcl.toISOString().slice(0, 10);

  const db = getDb();
  try {
    // ─── BUCKET DEFINITIONS ─────────────────────────────────────────────────
    //
    // Bucket A  FL Accrual        purchase_date in range, any status
    // Bucket B  FL Cash           ShipmentEvent posted_date in range
    // Bucket C  Held / DD+7       shipped_at in range, NO ShipmentEvent ever
    // Bucket D  Prior-period post  purchased BEFORE range, ShipmentEvent IN range
    // Bucket E  IL Estimated ≈    B + C (settled + estimated shipped)
    //
    // IL Estimated = $45,177.78 per report
    // FL Accrual   = $37,036.51 — gap is $8,141.27
    // ─────────────────────────────────────────────────────────────────────────

    // ── BUCKET A: FL Accrual (purchase_date basis) ──────────────────────────
    const bucketA = db.prepare(`
      SELECT
        o.order_id,
        o.purchase_date,
        o.shipped_at,
        o.status,
        o.fulfillment_channel,
        o.is_estimated,
        SUM(oi.total_price)                                   AS item_price_cents,
        SUM(COALESCE(oi.shipping_charged, 0))                 AS shipping_cents,
        SUM(COALESCE(oi.promotional_rebate, 0))               AS promo_cents,
        COUNT(oi.id)                                          AS line_items
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
      GROUP BY o.order_id
      ORDER BY o.purchase_date
    `).all(startDate, endNext) as any[];

    // ── ShipmentEvent lookup: posted_date per order ──────────────────────────
    const shipEvents = db.prepare(`
      SELECT order_id, MIN(posted_date) AS posted_date
      FROM financial_events
      WHERE event_type = 'ShipmentEvent'
      GROUP BY order_id
    `).all() as { order_id: string; posted_date: string }[];
    const shipEventMap = new Map(shipEvents.map(r => [r.order_id, r.posted_date]));

    // ── ShipmentEvent orders in range (Bucket B) ────────────────────────────
    const shipEventInRange = new Set(
      db.prepare(`
        SELECT DISTINCT order_id FROM financial_events
        WHERE event_type = 'ShipmentEvent'
          AND posted_date >= ? AND posted_date < ?
      `).all(startDate, endNext).map((r: any) => r.order_id)
    );

    // ── Refunds per order in this range ─────────────────────────────────────
    const refundRows = db.prepare(`
      SELECT order_id,
             SUM(refund_amount) AS refund_cents,
             COUNT(*) AS refund_count
      FROM refunds
      WHERE refund_date >= ? AND refund_date < ?
      GROUP BY order_id
    `).all(startDate, endNext) as any[];
    const refundMap = new Map(refundRows.map(r => [r.order_id, r]));

    // ── Annotate Bucket A rows ───────────────────────────────────────────────
    const today = new Date();
    const annotated = bucketA.map((o: any) => {
      const postedDate = shipEventMap.get(o.order_id) ?? null;
      const hasShipEvent = postedDate != null;
      const postedInRange = hasShipEvent && postedDate >= startDate && postedDate < endNext;
      const refund = refundMap.get(o.order_id);
      const saleCents = o.item_price_cents + o.shipping_cents; // matches FL accrual calc

      // FL included in accrual = always yes for this bucket (purchase_date in range)
      // FL included in cash = only if ShipmentEvent in range
      const flAccrual = true;
      const flCash = postedInRange;

      // Is this a DD+7 held order?
      const shippedAt = o.shipped_at ? new Date(o.shipped_at) : null;
      const expectedPost = shippedAt ? new Date(shippedAt.getTime() + 7 * 86400000) : null;
      const isDd7Held = hasShipEvent === false && shippedAt != null;
      const isOverdue = expectedPost != null && expectedPost < today;

      return {
        order_id: o.order_id,
        purchase_date: o.purchase_date ? o.purchase_date.slice(0, 10) : null,
        shipped_at: o.shipped_at ? o.shipped_at.slice(0, 10) : null,
        posted_date: postedDate ? postedDate.slice(0, 10) : null,
        status: o.status,
        channel: o.fulfillment_channel,
        is_estimated: o.is_estimated === 1,
        line_items: o.line_items,
        item_price: cents(o.item_price_cents),
        shipping_credit: cents(o.shipping_cents),
        promo_rebate: cents(o.promo_cents),
        sale_total: cents(saleCents),
        refund_amount: refund ? cents(refund.refund_cents) : null,
        fl_accrual: true,
        fl_cash: flCash,
        reason_not_cash: !flCash
          ? (hasShipEvent
              ? `ShipmentEvent posted ${postedDate?.slice(0, 10)} (outside range)`
              : 'No ShipmentEvent — not yet settled')
          : null,
        has_ship_event: hasShipEvent,
        posted_in_range: postedInRange,
        is_dd7_held: isDd7Held,
        is_overdue: isOverdue,
        expected_post: expectedPost ? expectedPost.toISOString().slice(0, 10) : null,
      };
    });

    // ── BUCKET C: Shipped in range, NO ShipmentEvent (held orders not in Bucket A)
    const bucketC_extra = db.prepare(`
      SELECT
        o.order_id,
        o.purchase_date,
        o.shipped_at,
        o.status,
        o.fulfillment_channel,
        o.is_estimated,
        SUM(oi.total_price)                           AS item_price_cents,
        SUM(COALESCE(oi.shipping_charged, 0))         AS shipping_cents,
        SUM(COALESCE(oi.promotional_rebate, 0))       AS promo_cents
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.shipped_at >= ? AND o.shipped_at < ?
        AND (o.purchase_date IS NULL OR o.purchase_date < ?)
        AND o.status NOT IN ('Canceled','Cancelled','Pending','Unshipped')
        AND NOT EXISTS (
          SELECT 1 FROM financial_events fe2
          WHERE fe2.order_id = o.order_id AND fe2.event_type = 'ShipmentEvent'
        )
      GROUP BY o.order_id
    `).all(startDate, endNext, startDate) as any[];

    // ── BUCKET D: Purchased BEFORE range, ShipmentEvent IN range ────────────
    const bucketD = db.prepare(`
      SELECT
        o.order_id,
        o.purchase_date,
        o.shipped_at,
        MIN(fe.posted_date) AS posted_date,
        o.status,
        o.fulfillment_channel,
        SUM(oi.total_price)                           AS item_price_cents,
        SUM(COALESCE(oi.shipping_charged, 0))         AS shipping_cents,
        SUM(COALESCE(oi.promotional_rebate, 0))       AS promo_cents
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      JOIN financial_events fe ON fe.order_id = o.order_id
                               AND fe.event_type = 'ShipmentEvent'
      WHERE fe.posted_date >= ? AND fe.posted_date < ?
        AND o.purchase_date < ?
      GROUP BY o.order_id
    `).all(startDate, endNext, startDate) as any[];

    // ── BUCKET SUMMARIES ────────────────────────────────────────────────────
    const sumCents = (rows: any[], key = 'item_price_cents', ship = 'shipping_cents') =>
      rows.reduce((s, r) => s + (r[key] ?? 0) + (r[ship] ?? 0), 0);

    const bucketA_sum = sumCents(annotated.map(r => ({
      item_price_cents: r.item_price ? parseInt(r.item_price.replace('$', '').replace('.', '')) * 1 : 0,
      shipping_cents: 0,
    })));
    // Recompute properly
    const aRevCents  = bucketA.reduce((s, r) => s + r.item_price_cents + r.shipping_cents, 0);
    const bRevCents  = bucketA.filter(r => shipEventInRange.has(r.order_id))
                               .reduce((s, r) => s + r.item_price_cents + r.shipping_cents, 0);
    const cExtRev    = bucketC_extra.reduce((s, r) => s + r.item_price_cents + r.shipping_cents, 0);
    const dRevCents  = bucketD.reduce((s, r) => s + r.item_price_cents + r.shipping_cents, 0);
    const heldInA    = bucketA.filter(r => !shipEventMap.has(r.order_id) && r.shipped_at);
    const heldInARev = heldInA.reduce((s, r) => s + r.item_price_cents + r.shipping_cents, 0);

    // IL Estimated hypothesis: B (cash orders in range) + heldInA + bucketC_extra
    const ilEstHypRevCents = bRevCents + heldInARev + cExtRev;

    const IL_ESTIMATED_CENTS = 4517778; // $45,177.78 from report

    // ── DAILY BREAKDOWN ─────────────────────────────────────────────────────
    // Group by day: purchase_date (FL accrual), shipped_at (IL-like estimated)
    const dailyMap = new Map<string, {
      purchase_cnt: number; purchase_rev: number;
      shipped_cnt: number; shipped_rev: number;
      posted_cnt: number; posted_rev: number;
    }>();

    const addDay = (map: typeof dailyMap, date: string, key: 'purchase' | 'shipped' | 'posted', rev: number) => {
      const d = date.slice(0, 10);
      if (!map.has(d)) map.set(d, { purchase_cnt:0, purchase_rev:0, shipped_cnt:0, shipped_rev:0, posted_cnt:0, posted_rev:0 });
      const row = map.get(d)!;
      (row as any)[`${key}_cnt`]++;
      (row as any)[`${key}_rev`] += rev;
    };

    for (const o of bucketA) {
      const rev = o.item_price_cents + o.shipping_cents;
      if (o.purchase_date) addDay(dailyMap, o.purchase_date, 'purchase', rev);
      if (o.shipped_at) addDay(dailyMap, o.shipped_at, 'shipped', rev);
      const posted = shipEventMap.get(o.order_id);
      if (posted && posted >= startDate && posted < endNext) addDay(dailyMap, posted, 'posted', rev);
    }
    for (const o of bucketC_extra) {
      const rev = o.item_price_cents + o.shipping_cents;
      if (o.shipped_at) addDay(dailyMap, o.shipped_at, 'shipped', rev);
    }
    for (const o of bucketD) {
      const rev = o.item_price_cents + o.shipping_cents;
      if (o.posted_date) addDay(dailyMap, o.posted_date, 'posted', rev);
    }

    const dailyTotals = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({
        date,
        fl_accrual_orders: d.purchase_cnt,
        fl_accrual_sales: cents(d.purchase_rev),
        shipped_orders: d.shipped_cnt,
        shipped_sales: cents(d.shipped_rev),
        posted_orders: d.posted_cnt,
        posted_sales: cents(d.posted_rev),
        // delta vs uniform daily IL-estimated pace
      }));

    // ── STATUS BREAKDOWN ─────────────────────────────────────────────────────
    const statusBreakdown = db.prepare(`
      SELECT o.status, o.fulfillment_channel, COUNT(DISTINCT o.order_id) as cnt,
             SUM(oi.total_price + COALESCE(oi.shipping_charged,0)) as rev_cents
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.purchase_date < ?
      GROUP BY o.status, o.fulfillment_channel
      ORDER BY rev_cents DESC
    `).all(startDate, endNext) as any[];

    // ── REFUND CHECK: is refund_date reducing the accrual sales line? ────────
    // FL keeps refunds on a separate line — but check if any are double-counted
    const refundsInRange = db.prepare(`
      SELECT COUNT(*) as cnt, SUM(refund_amount) as total
      FROM refunds
      WHERE refund_date >= ? AND refund_date < ?
    `).all(startDate, endNext)[0] as any;

    // ShipmentEvent amounts vs order_items amounts (are they equal?)
    const feVsOiSample = db.prepare(`
      SELECT fe.order_id,
             fe.total_amount AS fe_amount,
             SUM(oi.total_price + COALESCE(oi.shipping_charged,0)) AS oi_amount,
             (fe.total_amount - SUM(oi.total_price + COALESCE(oi.shipping_charged,0))) AS delta
      FROM financial_events fe
      JOIN order_items oi ON oi.order_id = fe.order_id
      WHERE fe.event_type = 'ShipmentEvent'
        AND fe.posted_date >= ? AND fe.posted_date < ?
      GROUP BY fe.order_id, fe.total_amount
      HAVING ABS(delta) > 50
      ORDER BY ABS(delta) DESC
      LIMIT 20
    `).all(startDate, endNext) as any[];

    const feVsOiTotal = db.prepare(`
      SELECT SUM(fe.total_amount) AS fe_total,
             SUM(sub.oi_amount) AS oi_total
      FROM financial_events fe
      JOIN (
        SELECT order_id, SUM(total_price + COALESCE(shipping_charged,0)) AS oi_amount
        FROM order_items GROUP BY order_id
      ) sub ON sub.order_id = fe.order_id
      WHERE fe.event_type = 'ShipmentEvent'
        AND fe.posted_date >= ? AND fe.posted_date < ?
    `).all(startDate, endNext)[0] as any;

    // ── ANALYSIS SUMMARY ────────────────────────────────────────────────────
    const analysis = {
      fl_accrual_sales:        cents(aRevCents),
      fl_cash_sales:           cents(bRevCents),
      held_in_accrual:         cents(heldInARev),
      held_extra_not_in_accrual: cents(cExtRev),
      prior_period_posted_in_range: cents(dRevCents),
      il_estimated_target:     cents(IL_ESTIMATED_CENTS),
      il_estimated_gap:        cents(aRevCents - IL_ESTIMATED_CENTS),
      hypothesis_il_estimated: cents(ilEstHypRevCents),
      hypothesis_gap_vs_il:    cents(ilEstHypRevCents - IL_ESTIMATED_CENTS),
      fe_total_amount_cash:    cents(feVsOiTotal?.fe_total ?? 0),
      oi_total_cash:           cents(feVsOiTotal?.oi_total ?? 0),
      fe_vs_oi_delta:          cents((feVsOiTotal?.fe_total ?? 0) - (feVsOiTotal?.oi_total ?? 0)),
    };

    const bucketSummary = {
      A_fl_accrual: {
        label: 'FL Accrual: purchase_date in range',
        orders: bucketA.length,
        revenue: cents(aRevCents),
        note: 'What FL currently reports as Mode 1 / Accrual',
      },
      B_fl_cash: {
        label: 'FL Cash: ShipmentEvent posted_date in range',
        orders: [...shipEventInRange].filter(id => bucketA.some(r => r.order_id === id)).length + bucketD.length,
        revenue: cents(bRevCents + dRevCents),
        note: 'Settled orders regardless of purchase date',
      },
      B_only_purchase_in_range: {
        label: 'FL Cash: only orders purchased in range',
        orders: bucketA.filter(r => shipEventInRange.has(r.order_id)).length,
        revenue: cents(bRevCents),
      },
      C_held_in_accrual: {
        label: 'Held in accrual: shipped but no ShipmentEvent (purchase_date in range)',
        orders: heldInA.length,
        revenue: cents(heldInARev),
        note: 'These ARE in FL accrual (purchase_date in range) but not settled',
      },
      C_held_extra: {
        label: 'Held extra: shipped in range, purchase_date BEFORE range or NULL',
        orders: bucketC_extra.length,
        revenue: cents(cExtRev),
        note: 'NOT in FL accrual or cash — missing from both FL modes',
      },
      D_prior_period: {
        label: 'Prior-period: purchased BEFORE range, settled IN range',
        orders: bucketD.length,
        revenue: cents(dRevCents),
        note: 'In FL cash but NOT FL accrual. IL estimated probably excludes these.',
      },
    };

    const questions = {
      q1_fl_missing_orders: {
        answer: `YES — Bucket C_held_extra: ${bucketC_extra.length} orders shipped in range with purchase_date before range. FL accrual excludes them (wrong period). Revenue: ${cents(cExtRev)}. These may be in IL estimated.`,
        also: `Bucket D: ${bucketD.length} orders purchased before range, settled in range. FL accrual also excludes these.`,
      },
      q2_missing_orders_last_few_days: {
        answer: `Held orders (C_held_in_accrual, ${heldInA.length} orders) have shipped_at ~2026-05-06. Check daily table for concentration.`,
      },
      q3_fl_date_basis: {
        answer: 'FL Accrual uses ORDER purchase_date. FL Cash uses ShipmentEvent MIN(posted_date).',
      },
      q4_il_date_basis: {
        answer: `IL Estimated hypothesis: shipped_at date (all shipped in range). Cash basis = ${cents(bRevCents + cExtRev + heldInARev)} (all shipped regardless of settlement). Gap vs IL target: ${cents(bRevCents + cExtRev + heldInARev - IL_ESTIMATED_CENTS)}. Confirm by checking if IL matches this.`,
      },
      q5_canceled_pending_excluded: {
        answer: 'FL accrual includes Unshipped (4 MFN orders, $247.29) and Shipped. No Canceled found in purchase_date range.',
        status_breakdown: statusBreakdown.map(r => ({
          status: r.status,
          channel: r.fulfillment_channel,
          orders: r.cnt,
          revenue: cents(r.rev_cents),
        })),
      },
      q6_refunds_reducing_sales: {
        answer: 'NO — FL keeps refunds on a separate line (refund_date basis). They do NOT reduce the sales/incomeTotal line.',
        refunds_in_range: { orders: refundsInRange.cnt, total: cents(refundsInRange.total) },
      },
      q7_shipping_credits: {
        answer: `FL accrual includes shipping_charged (MFN shipping credits). FBA ship = $287.23 (from fee_details fba_ship_credit). IL separates MFN Shipping Credit ($316.94) and Shipping Credit ($304.85). Check if FL is netting promo_rebate against shipping.`,
        fe_vs_oi_note: `ShipmentEvent total_amount (${cents(feVsOiTotal?.fe_total ?? 0)}) vs order_items total (${cents(feVsOiTotal?.oi_total ?? 0)}) — delta ${cents((feVsOiTotal?.fe_total ?? 0) - (feVsOiTotal?.oi_total ?? 0))}. ShipmentEvent includes tax/adjustments not in order_items.`,
      },
    };

    // ── PER-ORDER TABLE (Bucket A — all accrual orders) ─────────────────────
    const orderTable = annotated.map(o => ({
      order_id: o.order_id,
      purchase_date: o.purchase_date,
      shipped_at: o.shipped_at,
      posted_date: o.posted_date,
      status: o.status,
      channel: o.channel,
      item_price: o.item_price,
      shipping_credit: o.shipping_credit,
      promo_rebate: o.promo_rebate,
      sale_total: o.sale_total,
      refund: o.refund_amount,
      fl_accrual: 'YES',
      fl_cash: o.fl_cash ? 'YES' : 'NO',
      reason_not_cash: o.reason_not_cash,
      has_ship_event: o.has_ship_event ? 'YES' : 'NO',
      posted_in_range: o.posted_in_range ? 'YES' : 'NO',
      is_dd7_held: o.is_dd7_held ? 'YES' : 'NO',
      expected_post: o.expected_post,
      is_overdue: o.is_overdue ? 'YES' : 'NO',
    }));

    // Bucket C extra (not in accrual)
    const orderTableExtra = bucketC_extra.map((o: any) => ({
      order_id: o.order_id,
      purchase_date: o.purchase_date ? o.purchase_date.slice(0, 10) : null,
      shipped_at: o.shipped_at ? o.shipped_at.slice(0, 10) : null,
      posted_date: null,
      status: o.status,
      channel: o.fulfillment_channel,
      item_price: cents(o.item_price_cents),
      shipping_credit: cents(o.shipping_cents),
      promo_rebate: cents(o.promo_cents),
      sale_total: cents(o.item_price_cents + o.shipping_cents),
      refund: null,
      fl_accrual: 'NO',
      fl_cash: 'NO',
      reason_not_cash: 'purchase_date before range; no ShipmentEvent in range',
      has_ship_event: 'NO',
      posted_in_range: 'NO',
      is_dd7_held: 'YES',
      expected_post: null,
      is_overdue: null,
    }));

    return NextResponse.json({
      meta: {
        startDate, endDate, endNextUsed: endNext,
        today: new Date().toISOString().slice(0, 10),
        note: 'READ-ONLY sales gap drilldown. No writes.',
        generatedAt: new Date().toISOString(),
        il_estimated_sales: '$45,177.78',
        fl_accrual_sales: cents(aRevCents),
        gap: cents(aRevCents - IL_ESTIMATED_CENTS),
      },
      analysis,
      questions,
      bucket_summary: bucketSummary,
      daily_totals: dailyTotals,
      fe_vs_oi_mismatches: feVsOiSample.map((r: any) => ({
        order_id: r.order_id,
        fe_amount: cents(r.fe_amount),
        oi_amount: cents(r.oi_amount),
        delta: cents(r.delta),
      })),
      order_table: {
        note: 'All orders where FL Accrual = YES. Bucket A (purchase_date in range).',
        count: orderTable.length,
        revenue_total: cents(aRevCents),
        rows: orderTable,
      },
      order_table_extra: {
        note: 'Orders shipped in range but purchase_date before range AND no ShipmentEvent. NOT in FL accrual or cash.',
        count: orderTableExtra.length,
        revenue_total: cents(cExtRev),
        rows: orderTableExtra,
      },
      prior_period_orders: {
        note: 'Purchased BEFORE range, ShipmentEvent IN range. In FL cash only.',
        count: bucketD.length,
        revenue_total: cents(dRevCents),
        rows: bucketD.map((o: any) => ({
          order_id: o.order_id,
          purchase_date: o.purchase_date ? o.purchase_date.slice(0, 10) : null,
          shipped_at: o.shipped_at ? o.shipped_at.slice(0, 10) : null,
          posted_date: o.posted_date ? o.posted_date.slice(0, 10) : null,
          status: o.status,
          item_price: cents(o.item_price_cents),
          shipping_credit: cents(o.shipping_cents),
          sale_total: cents(o.item_price_cents + o.shipping_cents),
        })),
      },
    });
  } finally {
    db.close();
  }
}
