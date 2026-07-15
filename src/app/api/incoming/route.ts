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
import { classifyIncomingBulkReconciliation } from '@/lib/incoming-bulk-reconcile';

const OVERDUE_DAYS_DEFAULT = 14;        // unshipped: no evidence the supplier shipped → chase it
const SHIPPED_OVERDUE_DAYS_DEFAULT = 30; // shipped but still not received → possible lost-in-transit

// A purchase counts as "shipped" once it has a tracking number, or its delivery
// status says it's moving/arrived. Shipped orders are in transit / awaiting
// receive — NOT "overdue from the supplier", so they use the longer fuse.
const SHIPPED_STATUS_RE = /transit|delivered|shipped|out for delivery|picked up|arriv/i;
function isShipped(trackingNumber: string | null, deliveryStatus: string | null): boolean {
  if (trackingNumber && trackingNumber.trim()) return true;
  return !!deliveryStatus && SHIPPED_STATUS_RE.test(deliveryStatus);
}

interface CandidateLotRow {
  inventoryLedgerId: number;
  asin: string | null;
  sku: string | null;
  quantity: number;
  quantityReceived: number;
  quantityRemaining: number;
  attributedUnits: number;
  availableToReconcile: number;
  buyPriceCents: number;
  datePurchased: string;
  receivedAt: string | null;
  binLocation: string | null;
}

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
    const shippedOverdueDays = parseInt(
      (db.prepare("SELECT value FROM settings WHERE key = 'incoming_shipped_overdue_days'").get() as any)?.value || ''
    ) || SHIPPED_OVERDUE_DAYS_DEFAULT;

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

    // How close a lot's purchase date must be to the order date for an
    // ASIN-based suggestion on a SKU-mismatch row (operator's SKU-per-buy
    // convention means the SKU string can diverge while ASIN+date is a
    // near-fingerprint of the same purchase).
    const ASIN_DATE_WINDOW_DAYS = 3;
    const dayMs = 86400000;
    const dateKey = (v: string | null | undefined) => {
      const t = Date.parse(String(v || '').slice(0, 10));
      return Number.isFinite(t) ? t : null;
    };
    const candidateLotsByPurchase = new Map<number, Array<CandidateLotRow & { matchType: 'sku' | 'asin' | 'asin_date' }>>();
    const addCandidateLots = (rows: CandidateLotRow[], matchType: 'sku' | 'asin' | 'asin_date') => {
      for (const lot of rows) {
        for (const purchase of open) {
          let matches = false;
          if (matchType === 'sku') {
            matches = purchase.sku === lot.sku;
          } else if (matchType === 'asin') {
            matches = !purchase.sku && purchase.asin === lot.asin;
          } else {
            // asin_date: row HAS a sku that found no lot — suggest same-ASIN
            // lots bought within the window. Flag tier: UI badges it and the
            // reconcile action requires the explicit mismatch confirmation.
            const rowDate = dateKey((purchase as { orderedAt?: string | null }).orderedAt);
            const lotDate = dateKey(lot.datePurchased);
            matches = !!purchase.sku && purchase.sku !== lot.sku
              && !!purchase.asin && purchase.asin === lot.asin
              && rowDate !== null && lotDate !== null
              && Math.abs(rowDate - lotDate) <= ASIN_DATE_WINDOW_DAYS * dayMs;
          }
          if (!matches) continue;
          // A lot already suggested via exact SKU shouldn't repeat as asin_date.
          if (matchType === 'asin_date'
              && (candidateLotsByPurchase.get(purchase.id) || []).some(c => c.inventoryLedgerId === lot.inventoryLedgerId)) {
            continue;
          }
          const quantityReceived = Number(lot.quantityReceived);
          const attributedUnits = Number(lot.attributedUnits);
          const candidates = candidateLotsByPurchase.get(purchase.id) || [];
          candidates.push({
            inventoryLedgerId: lot.inventoryLedgerId,
            asin: lot.asin,
            sku: lot.sku,
            quantity: lot.quantity,
            quantityReceived,
            quantityRemaining: lot.quantityRemaining,
            attributedUnits,
            availableToReconcile: Math.max(0, quantityReceived - attributedUnits),
            buyPriceCents: lot.buyPriceCents,
            datePurchased: lot.datePurchased,
            receivedAt: lot.receivedAt,
            binLocation: lot.binLocation,
            matchType,
          });
          candidateLotsByPurchase.set(purchase.id, candidates);
        }
      }
    };
    const candidateQuery = (column: 'sku' | 'asin', values: string[]) => {
      if (values.length === 0) return [];
      return db.prepare(`
        WITH attributed AS (
          SELECT inventory_ledger_id, COALESCE(SUM(quantity_good), 0) attributedUnits
          FROM incoming_receipt_allocations
          WHERE inventory_ledger_id IS NOT NULL
          GROUP BY inventory_ledger_id
        )
        SELECT il.id AS inventoryLedgerId, il.asin, il.sku,
               il.quantity, COALESCE(il.quantity_received, il.quantity) AS quantityReceived,
               il.quantity_remaining AS quantityRemaining,
               COALESCE(a.attributedUnits, 0) AS attributedUnits,
               il.buy_price AS buyPriceCents, il.date_purchased AS datePurchased,
               il.received_at AS receivedAt, il.bin_location AS binLocation
        FROM inventory_ledger il
        LEFT JOIN attributed a ON a.inventory_ledger_id = il.id
        WHERE il.${column} IN (${values.map(() => '?').join(', ')})
        ORDER BY il.received_at DESC, il.id DESC
      `).all(...values) as CandidateLotRow[];
    };
    const openSkus = [...new Set(open.map((row) => row.sku).filter(Boolean))] as string[];
    const fallbackAsins = [...new Set(open.filter((row) => !row.sku).map((row) => row.asin).filter(Boolean))] as string[];
    addCandidateLots(candidateQuery('sku', openSkus), 'sku');
    addCandidateLots(candidateQuery('asin', fallbackAsins), 'asin');
    const mismatchAsins = [...new Set(
      open
        .filter((row) => row.sku && row.asin && (candidateLotsByPurchase.get(row.id) || []).length === 0)
        .map((row) => row.asin)
    )] as string[];
    addCandidateLots(candidateQuery('asin', mismatchAsins), 'asin_date');
    for (const row of open) {
      row.reconciliationCandidates = candidateLotsByPurchase.get(row.id) || [];
    }

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
      // Shipped orders are in transit / awaiting receive — only "overdue" on the
      // longer lost-in-transit fuse. Unshipped orders (no tracking) are the ones
      // worth chasing while the supplier's refund window is open.
      r.shipped = isShipped(r.trackingNumber, r.deliveryStatus);
      const threshold = r.shipped ? shippedOverdueDays : overdueDays;
      r.overdue = !snoozed && r.daysOutstanding >= threshold;
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
      r.bulkReconciliation = classifyIncomingBulkReconciliation({
        id: r.id,
        sku: r.sku,
        quantity: r.quantity,
        quantityReceived: r.quantityReceived,
        orderedAt: r.orderedAt,
        skuInSellerCentral: r.skuInSellerCentral,
        liveSkusForAsin: r.liveSkusForAsin,
      }, r.reconciliationCandidates);
      r.highConfidenceReconciliation = r.bulkReconciliation.highConfidence;
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
      reconciliationCandidateCount: open.filter((r) => r.reconciliationCandidates.length > 0).length,
      highConfidenceReconciliationCount: open.filter((r) => r.highConfidenceReconciliation).length,
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
