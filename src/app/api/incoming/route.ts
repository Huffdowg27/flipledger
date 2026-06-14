/**
 * GET /api/incoming
 *
 * The Incoming page payload: open purchases (on_order/partial) with aging,
 * recently received rows, open issues, header stats (bought today/week/month,
 * $ on order, $ overdue, $ in open issues), and relink data — live Seller
 * Central SKUs per ASIN so a SKU mismatch is a one-click fix at receive time.
 */
import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

const OVERDUE_DAYS_DEFAULT = 14;

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET() {
  const db = getDb();
  try {
    const overdueDays = parseInt(
      (db.prepare("SELECT value FROM settings WHERE key = 'incoming_overdue_days'").get() as any)?.value || ''
    ) || OVERDUE_DAYS_DEFAULT;

    const open = db.prepare(`
      SELECT id, airtable_record_id as airtableRecordId, order_source as orderSource,
             order_ref as orderRef, asin, sku, product_name as productName, image_url as imageUrl,
             quantity, quantity_received as quantityReceived, unit_cost_cents as unitCostCents,
             ordered_at as orderedAt, tracking_number as trackingNumber,
             delivery_status as deliveryStatus, status, notes, snoozed_until as snoozedUntil
      FROM incoming_purchases
      WHERE status IN ('on_order', 'partial')
      ORDER BY ordered_at ASC, id ASC
    `).all() as any[];

    const received = db.prepare(`
      SELECT id, order_ref as orderRef, asin, sku, product_name as productName,
             quantity, quantity_received as quantityReceived, unit_cost_cents as unitCostCents,
             ordered_at as orderedAt, received_at as receivedAt, status
      FROM incoming_purchases
      WHERE status IN ('received', 'cancelled')
      ORDER BY received_at DESC
      LIMIT 50
    `).all() as any[];

    const issues = db.prepare(`
      SELECT ri.id, ri.incoming_purchase_id as incomingPurchaseId, ri.inventory_ledger_id as inventoryLedgerId,
             ri.asin, ri.sku, ri.quantity, ri.issue_type as issueType, ri.note, ri.status,
             ri.resolution, ri.refund_cents as refundCents, ri.resolved_at as resolvedAt, ri.created_at as createdAt,
             ip.product_name as productName, ip.order_ref as orderRef, ip.unit_cost_cents as unitCostCents
      FROM receiving_issues ri
      LEFT JOIN incoming_purchases ip ON ip.id = ri.incoming_purchase_id
      ORDER BY ri.status ASC, ri.created_at DESC
      LIMIT 200
    `).all() as any[];

    // Aging + grouping.
    const now = Date.now();
    for (const r of open) {
      const ordered = r.orderedAt ? new Date(r.orderedAt).getTime() : now;
      r.daysOutstanding = Math.floor((now - ordered) / 86400000);
      const snoozed = r.snoozedUntil && new Date(r.snoozedUntil).getTime() > now;
      r.overdue = !snoozed && r.daysOutstanding >= overdueDays;
      r.remaining = Math.max(0, r.quantity - r.quantityReceived);
    }

    // Relink data: which open SKUs exist in Seller Central, and the live SKUs
    // per ASIN for the ones that don't.
    const liveSkuRows = db.prepare(`
      SELECT sku, asin, status FROM merchant_listings WHERE marketplace = 'amazon'
    `).all() as { sku: string; asin: string; status: string | null }[];
    const liveSkus = new Set(liveSkuRows.map((r) => r.sku));
    const skusByAsin = new Map<string, { sku: string; status: string | null }[]>();
    for (const r of liveSkuRows) {
      if (!skusByAsin.has(r.asin)) skusByAsin.set(r.asin, []);
      skusByAsin.get(r.asin)!.push({ sku: r.sku, status: r.status });
    }
    for (const r of open) {
      r.skuInSellerCentral = r.sku ? liveSkus.has(r.sku) : null;
      r.liveSkusForAsin = r.asin ? (skusByAsin.get(r.asin) || []) : [];
    }

    // Header stats.
    const sum = (rows: any[], f: (r: any) => number) => rows.reduce((s, r) => s + f(r), 0);
    const purchasedSince = (sinceIso: string) => {
      const row = db.prepare(`
        SELECT COALESCE(SUM(quantity * unit_cost_cents), 0) as cents, COALESCE(SUM(quantity), 0) as units, COUNT(*) as orders,
               COALESCE(SUM(quantity * COALESCE(profit_cents, 0)), 0) as profitCents
        FROM incoming_purchases WHERE ordered_at >= ? AND status != 'cancelled'
      `).get(sinceIso) as any;
      return { cents: row.cents, units: row.units, orders: row.orders, profitCents: row.profitCents };
    };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const week = new Date(today); week.setDate(week.getDate() - week.getDay());
    const month = new Date(today.getFullYear(), today.getMonth(), 1);

    // Profit targets (dollars in settings → cents). 0/blank = unset.
    const targetCents = (key: string) => {
      const v = parseFloat((db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value || '');
      return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : 0;
    };

    const openIssues = issues.filter((i) => i.status === 'open');
    const stats = {
      purchasedToday: purchasedSince(today.toISOString().slice(0, 10)),
      purchasedWeek: purchasedSince(week.toISOString().slice(0, 10)),
      purchasedMonth: purchasedSince(month.toISOString().slice(0, 10)),
      onOrderCents: sum(open, (r) => r.remaining * r.unitCostCents),
      onOrderUnits: sum(open, (r) => r.remaining),
      overdueCents: sum(open.filter((r) => r.overdue), (r) => r.remaining * r.unitCostCents),
      overdueCount: open.filter((r) => r.overdue).length,
      openIssuesCents: sum(openIssues, (i) => i.quantity * (i.unitCostCents || 0)),
      openIssuesCount: openIssues.length,
      overdueDays,
      // Single monthly profit target — the dashboard derives day/week from it.
      profitTargetMonthlyCents: targetCents('profit_target_monthly'),
    };

    return NextResponse.json({ open, received, issues, stats });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
