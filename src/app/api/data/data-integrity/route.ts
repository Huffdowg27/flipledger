import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { HISTORY_CUTOVER } from '@/lib/accounting-cutover';
import {
  parseAmazonShippingTemplateCache,
  resolveAmazonShippingTemplateName,
} from '@/lib/amazonShippingTemplates';
import {
  countFlaggedSettlementCoveragePeriods,
  getFlaggedSettlementCoveragePeriods,
} from '@/lib/settlement-coverage';

/**
 * Data-integrity guardrail (audit F4).
 *
 * Standing health check for the numbers FlipLedger reports. Surfaces the silent
 * failure modes that erode trust once FlipLedger is the system of record (i.e.
 * once InventoryLab is gone and there's no second tool to cross-check against):
 *
 *  - shipped units booked at $0 COGS         → profit OVERSTATED, silently (F2)
 *  - sold SKUs/ASINs with no purchase lot    → root cause of the above
 *  - oversold lots (negative remaining)      → FIFO inconsistency
 *  - multi-SKU ASIN fallback collisions      → FIFO double-consume risk (F3)
 *  - pending orders consuming inventory      → unsettled orders depleting stock
 *
 * Read-only. Cents are returned as integers (the app's money convention).
 */

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

const NOT_CANCELED = "o.status NOT IN ('Canceled','Cancelled')";
const REAL_ASIN = "oi.asin IS NOT NULL AND oi.asin <> '' AND oi.asin <> 'PENDING'";
// Genuine "needs cost" only: exclude amzn.gr.* resales (intentionally $0 COGS)
// and pre-cutover orders (those costs live in historical_cogs, not order_items).
const COGS_RELEVANT = `COALESCE(oi.sku, '') NOT LIKE 'amzn.gr%' AND o.purchase_date >= '${HISTORY_CUTOVER}'`;

type Severity = 'ok' | 'warn' | 'error';

interface Check {
  id: string;
  label: string;
  description: string;
  severity: Severity;
  count: number;
  units?: number;
  amountCents?: number;
  sample: Record<string, unknown>[];
  fix?: string;
}

interface ReceiptConservationCount {
  purchases: number;
  units: number;
}

interface AllocationCount {
  allocations: number;
}

interface RowCount {
  rows: number;
}

interface DuplicateKeyCount {
  duplicateKeys: number;
}

interface PurchaseCount {
  purchases: number;
}

interface ReceivedLotOpenIncomingCount {
  rows: number;
  units: number;
}

interface CogsCoverageCount {
  totalUnits: number;
  coveredUnits: number;
}

interface ZeroCogsCount {
  items: number;
  units: number;
  revenueCents: number;
  asins: number;
}

interface AsinCount {
  asins: number;
}

interface OversoldCount {
  lots: number;
  negUnits: number;
}

interface FallbackCollisionCount {
  saleItems: number;
  asins: number;
}

interface PendingFifoCount {
  orders: number;
  units: number;
}

interface ReceivingIssueCostBasisCount {
  issues: number;
  units: number;
}

interface MfnValuationCount {
  skus: number;
  units: number;
  valueCents: number;
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((row) => row.name === column);
}

export async function GET() {
  const db = getDb();
  try {
    const checks: Check[] = [];

    // --- A: shipped units booked at $0 COGS (profit overstatement exposure) ---
    const zeroCogs = db.prepare(`
      SELECT COUNT(*) items, COALESCE(SUM(oi.quantity),0) units,
             COALESCE(SUM(oi.total_price),0) revenueCents,
             COUNT(DISTINCT oi.asin) asins
      FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
      WHERE (oi.cogs_per_unit IS NULL OR oi.cogs_per_unit = 0)
        AND ${NOT_CANCELED} AND ${REAL_ASIN} AND ${COGS_RELEVANT}
    `).get() as ZeroCogsCount;
    const zeroCogsSample = db.prepare(`
      SELECT oi.asin, oi.sku,
             COALESCE(p.name, oi.asin) as productName,
             COUNT(*) items, SUM(oi.quantity) units, SUM(oi.total_price) revenueCents,
             MIN(o.purchase_date) firstSold, MAX(o.purchase_date) lastSold
      FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN products p ON p.asin = oi.asin
      WHERE (oi.cogs_per_unit IS NULL OR oi.cogs_per_unit = 0)
        AND ${NOT_CANCELED} AND ${REAL_ASIN} AND ${COGS_RELEVANT}
      GROUP BY oi.asin ORDER BY revenueCents DESC LIMIT 200
    `).all();
    checks.push({
      id: 'zero_cogs_sales',
      label: 'Shipped units booked at $0 COGS',
      description: 'Sold units with no cost recorded. Profit is overstated by their true cost until a buy lot is added and FIFO re-runs.',
      severity: zeroCogs.items > 0 ? 'warn' : 'ok',
      count: zeroCogs.items,
      units: zeroCogs.units,
      amountCents: zeroCogs.revenueCents,
      sample: zeroCogsSample as Record<string, unknown>[],
      fix: 'Add a purchase lot (Products & COGS) for each ASIN below, then COGS backfills on the next FIFO run / sync.',
    });

    // --- B: sold SKUs/ASINs with no purchase lot at all (root cause of A) ---
    const noLot = db.prepare(`
      SELECT COUNT(*) asins FROM (
        SELECT DISTINCT oi.asin
        FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
        WHERE ${NOT_CANCELED} AND ${REAL_ASIN} AND ${COGS_RELEVANT}
          AND (oi.cogs_per_unit IS NULL OR oi.cogs_per_unit = 0)
          AND NOT EXISTS (
            SELECT 1 FROM inventory_ledger il
            WHERE il.buy_price > 0
              AND (il.sku = oi.sku OR il.asin = oi.asin)
          )
      )
    `).get() as AsinCount;
    checks.push({
      id: 'sold_without_lot',
      label: 'Sold ASINs with no purchase lot',
      description: 'ASINs that have sold but have zero inventory_ledger lots (neither by SKU nor ASIN). This is the root cause of $0-COGS sales.',
      severity: noLot.asins > 0 ? 'warn' : 'ok',
      count: noLot.asins,
      sample: [],
      fix: 'Same ASINs as the $0-COGS list above — adding a lot resolves both.',
    });

    // --- C: oversold lots (negative remaining) — FIFO inconsistency ---
    const oversold = db.prepare(`
      SELECT COUNT(*) lots, COALESCE(SUM(quantity_remaining),0) negUnits
      FROM inventory_ledger WHERE quantity_remaining < 0
    `).get() as OversoldCount;
    const oversoldSample = db.prepare(`
      SELECT sku, asin, quantity, quantity_remaining as quantityRemaining, date_purchased as datePurchased
      FROM inventory_ledger WHERE quantity_remaining < 0
      ORDER BY quantity_remaining ASC LIMIT 50
    `).all();
    checks.push({
      id: 'oversold_lots',
      label: 'Oversold lots (negative remaining)',
      description: 'Lots whose remaining quantity went negative — more units sold than purchased. Indicates a missing/short buy lot.',
      severity: oversold.lots > 0 ? 'error' : 'ok',
      count: oversold.lots,
      units: oversold.negUnits,
      sample: oversoldSample as Record<string, unknown>[],
      fix: 'Add the missing buy lot for the SKU, then re-run FIFO.',
    });

    // --- D: ambiguous ASIN fallback cost ---
    // The FIFO engine claims an orphan-SKU sale only once, so multiple lot SKUs
    // no longer double-consume it. What still needs attention is an orphan sale
    // whose candidate lot SKUs carry different costs: the oldest candidate wins
    // deterministically, but the source data cannot prove that cost is correct.
    const collision = db.prepare(`
      WITH ambiguous AS (
        SELECT oi.id, oi.asin
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.order_id
        JOIN inventory_ledger il ON il.asin = oi.asin AND il.buy_price > 0
        WHERE ${NOT_CANCELED} AND ${REAL_ASIN} AND ${COGS_RELEVANT}
          AND (
            oi.sku IS NULL OR oi.sku = ''
            OR oi.sku NOT IN (
              SELECT sku FROM inventory_ledger WHERE buy_price > 0
            )
          )
        GROUP BY oi.id, oi.asin
        HAVING COUNT(DISTINCT il.sku) > 1
          AND COUNT(DISTINCT il.buy_price) > 1
      )
      SELECT COUNT(*) saleItems, COUNT(DISTINCT asin) asins FROM ambiguous
    `).get() as FallbackCollisionCount;
    const collisionSample = db.prepare(`
      SELECT
        oi.order_id AS orderId,
        oi.asin,
        oi.sku,
        oi.cogs_per_unit AS assignedCogsPerUnit,
        GROUP_CONCAT(DISTINCT il.buy_price) AS candidateCosts
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN inventory_ledger il ON il.asin = oi.asin AND il.buy_price > 0
      WHERE ${NOT_CANCELED} AND ${REAL_ASIN} AND ${COGS_RELEVANT}
        AND (
          oi.sku IS NULL OR oi.sku = ''
          OR oi.sku NOT IN (
            SELECT sku FROM inventory_ledger WHERE buy_price > 0
          )
        )
      GROUP BY oi.id
      HAVING COUNT(DISTINCT il.sku) > 1
        AND COUNT(DISTINCT il.buy_price) > 1
      ORDER BY o.purchase_date DESC, oi.id DESC
      LIMIT 50
    `).all();
    checks.push({
      id: 'fifo_fallback_collision',
      label: 'FIFO ASIN fallback cost ambiguity',
      description: 'Sales whose SKU has no lot and whose ASIN has candidate lots at different costs. FIFO uses the oldest cost deterministically, but the purchase source should be verified.',
      severity: collision.saleItems > 0 ? 'warn' : 'ok',
      count: collision.saleItems,
      sample: collisionSample as Record<string, unknown>[],
      fix: 'Verify the sale’s purchase source and give the selling SKU its own correctly costed lot.',
    });

    // --- E: pending orders consuming inventory (unsettled depletion) ---
    const pendingFifo = db.prepare(`
      SELECT COUNT(DISTINCT o.order_id) orders, COALESCE(SUM(oi.quantity),0) units
      FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
      WHERE o.status = 'Pending' AND ${REAL_ASIN}
    `).get() as PendingFifoCount;
    checks.push({
      id: 'pending_consumes_fifo',
      label: 'Pending orders consuming inventory',
      description: 'Pending orders with a real (non-placeholder) line item are consumed by FIFO before they settle. Usually fine, but inflates COGS/depletes stock for orders that may cancel.',
      severity: 'ok',
      count: pendingFifo.orders,
      units: pendingFifo.units,
      sample: [],
    });

    // --- F: MFN valuation population ---
    // These SKUs are absent from live_inventory, so valuation must pick them up
    // from merchant_listings + open local lots instead of the FBA-only anchor.
    const hasMerchantListings = !!db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'merchant_listings'"
    ).get();
    if (hasMerchantListings) {
      const mfnValuation = db.prepare(`
        SELECT COUNT(DISTINCT ml.sku) skus,
               COALESCE(SUM(il.quantity_remaining), 0) units,
               COALESCE(SUM(il.quantity_remaining * il.buy_price), 0) valueCents
        FROM merchant_listings ml
        JOIN inventory_ledger il ON il.sku = ml.sku AND il.quantity_remaining > 0
        WHERE ml.marketplace = 'amazon'
          AND ml.sku IS NOT NULL
          AND ml.sku != ''
          AND UPPER(COALESCE(ml.fulfillment_channel, 'DEFAULT')) = 'DEFAULT'
          AND NOT EXISTS (
            SELECT 1 FROM live_inventory li
            WHERE li.sku = ml.sku
	          )
	      `).get() as MfnValuationCount;
      const mfnSample = db.prepare(`
        SELECT ml.sku, ml.asin,
               COALESCE(ml.product_name, p.name, ml.asin) productName,
               SUM(il.quantity_remaining) quantityRemaining,
               SUM(il.quantity_remaining * il.buy_price) valueCents
        FROM merchant_listings ml
        JOIN inventory_ledger il ON il.sku = ml.sku AND il.quantity_remaining > 0
        LEFT JOIN products p ON p.asin = ml.asin
        WHERE ml.marketplace = 'amazon'
          AND ml.sku IS NOT NULL
          AND ml.sku != ''
          AND UPPER(COALESCE(ml.fulfillment_channel, 'DEFAULT')) = 'DEFAULT'
          AND NOT EXISTS (
            SELECT 1 FROM live_inventory li
            WHERE li.sku = ml.sku
          )
        GROUP BY ml.sku, ml.asin
        ORDER BY valueCents DESC
        LIMIT 50
      `).all();
      checks.push({
        id: 'mfn_valuation_population',
        label: 'MFN local lots included in valuation',
        description: 'Merchant-listed Amazon SKUs absent from FBA live_inventory but backed by open local lots. Inventory valuation should include this display population as MFN.',
        severity: 'ok',
        count: mfnValuation.skus,
        units: mfnValuation.units,
        amountCents: mfnValuation.valueCents,
        sample: mfnSample as Record<string, unknown>[],
      });
    } else {
      checks.push({
        id: 'mfn_valuation_population',
        label: 'MFN local lots included in valuation',
        description: 'merchant_listings table is not present in this database; MFN valuation population cannot be audited.',
        severity: 'ok',
        count: 0,
        sample: [],
      });
    }

    // --- G: immutable incoming-receipt allocation conservation ---
    const receiptConservation = db.prepare(`
      WITH allocated AS (
        SELECT incoming_purchase_id,
               SUM(quantity_good + quantity_issue) allocatedUnits
        FROM incoming_receipt_allocations
        GROUP BY incoming_purchase_id
      )
      SELECT COUNT(*) purchases,
             COALESCE(SUM(ABS(
               ip.quantity_received
               - (ip.receipt_allocation_baseline + a.allocatedUnits)
             )), 0) units
      FROM allocated a
      JOIN incoming_purchases ip ON ip.id = a.incoming_purchase_id
      WHERE ip.quantity_received <> ip.receipt_allocation_baseline + a.allocatedUnits
         OR ip.receipt_allocation_baseline + a.allocatedUnits > ip.quantity
    `).get() as ReceiptConservationCount;
    const receiptConservationSample = db.prepare(`
      WITH allocated AS (
        SELECT incoming_purchase_id,
               SUM(quantity_good + quantity_issue) allocatedUnits
        FROM incoming_receipt_allocations
        GROUP BY incoming_purchase_id
      )
      SELECT ip.id AS incomingPurchaseId, ip.order_ref AS orderRef,
             ip.sku, ip.asin, ip.quantity,
             ip.quantity_received AS quantityReceived,
             ip.receipt_allocation_baseline AS allocationBaseline,
             a.allocatedUnits
      FROM allocated a
      JOIN incoming_purchases ip ON ip.id = a.incoming_purchase_id
      WHERE ip.quantity_received <> ip.receipt_allocation_baseline + a.allocatedUnits
         OR ip.receipt_allocation_baseline + a.allocatedUnits > ip.quantity
      ORDER BY ip.id
      LIMIT 100
    `).all();
    checks.push({
      id: 'receipt_allocation_conservation',
      label: 'Incoming receipt allocation conservation',
      description: 'Post-identity incoming purchases must equal their frozen pre-identity baseline plus immutable good + issue allocations.',
      severity: receiptConservation.purchases > 0 ? 'error' : 'ok',
      count: receiptConservation.purchases,
      units: receiptConservation.units,
      sample: receiptConservationSample as Record<string, unknown>[],
      fix: 'Do not edit receipt or lot quantities. Review the immutable receipt keys and source request before any operator correction.',
    });

    // --- G: immutable incoming-receipt identity references ---
    const receiptOrphans = db.prepare(`
      SELECT COUNT(*) allocations
      FROM incoming_receipt_allocations ira
      LEFT JOIN incoming_purchases ip ON ip.id = ira.incoming_purchase_id
      LEFT JOIN inventory_ledger il ON il.id = ira.inventory_ledger_id
      LEFT JOIN receiving_issues ri ON ri.id = ira.receiving_issue_id
      WHERE ip.id IS NULL
         OR (ira.inventory_ledger_id IS NOT NULL AND il.id IS NULL)
         OR (ira.receiving_issue_id IS NOT NULL AND ri.id IS NULL)
    `).get() as AllocationCount;
    const receiptDuplicateKeys = db.prepare(`
      SELECT COUNT(*) duplicateKeys FROM (
        SELECT receipt_key
        FROM incoming_receipt_allocations
        GROUP BY receipt_key
        HAVING COUNT(*) > 1
      )
    `).get() as DuplicateKeyCount;
    const receiptIdentitySample = db.prepare(`
      SELECT ira.id AS allocationId, ira.receipt_key AS receiptKey,
             ira.incoming_purchase_id AS incomingPurchaseId,
             ira.inventory_ledger_id AS inventoryLedgerId,
             ira.receiving_issue_id AS receivingIssueId
      FROM incoming_receipt_allocations ira
      LEFT JOIN incoming_purchases ip ON ip.id = ira.incoming_purchase_id
      LEFT JOIN inventory_ledger il ON il.id = ira.inventory_ledger_id
      LEFT JOIN receiving_issues ri ON ri.id = ira.receiving_issue_id
      WHERE ip.id IS NULL
         OR (ira.inventory_ledger_id IS NOT NULL AND il.id IS NULL)
         OR (ira.receiving_issue_id IS NOT NULL AND ri.id IS NULL)
      ORDER BY ira.id
      LIMIT 100
    `).all();
    const receiptIdentityFailures = receiptOrphans.allocations + receiptDuplicateKeys.duplicateKeys;
    checks.push({
      id: 'receipt_identity_integrity',
      label: 'Incoming receipt identity integrity',
      description: 'Receipt keys must be unique and every immutable allocation must reference its real purchase, lot, and issue.',
      severity: receiptIdentityFailures > 0 ? 'error' : 'ok',
      count: receiptIdentityFailures,
      sample: receiptIdentitySample as Record<string, unknown>[],
      fix: 'Treat as a source-identity defect. Do not reconstruct links from SKU/ASIN similarity.',
    });

    // --- G: receiving issue cost basis availability ---
    if (
      columnExists(db, 'receiving_issues', 'incoming_purchase_id')
      && columnExists(db, 'receiving_issues', 'inventory_ledger_id')
      && columnExists(db, 'receiving_issues', 'quantity')
      && columnExists(db, 'receiving_issues', 'sku')
      && columnExists(db, 'receiving_issues', 'asin')
      && columnExists(db, 'receiving_issues', 'issue_type')
      && columnExists(db, 'receiving_issues', 'status')
      && columnExists(db, 'incoming_purchases', 'unit_cost_cents')
    ) {
      // A report-time snapshot (removed_unit_cost_cents) also counts as a
      // valid basis source — it survives even if the lot is later deleted.
      const snapshotClause = columnExists(db, 'receiving_issues', 'removed_unit_cost_cents')
        ? 'AND ri.removed_unit_cost_cents IS NULL'
        : '';
      const issueCostBasis = db.prepare(`
        SELECT COUNT(*) issues, COALESCE(SUM(ri.quantity), 0) units
        FROM receiving_issues ri
        LEFT JOIN incoming_purchases ip ON ip.id = ri.incoming_purchase_id
        LEFT JOIN inventory_ledger il ON il.id = ri.inventory_ledger_id
        WHERE ip.unit_cost_cents IS NULL
          AND il.buy_price IS NULL
          ${snapshotClause}
      `).get() as ReceivingIssueCostBasisCount;
      const issueCostBasisSample = db.prepare(`
        SELECT ri.id AS issueId, ri.incoming_purchase_id AS incomingPurchaseId,
               ri.inventory_ledger_id AS inventoryLedgerId, ri.sku, ri.asin,
               ri.quantity, ri.issue_type AS issueType, ri.status
        FROM receiving_issues ri
        LEFT JOIN incoming_purchases ip ON ip.id = ri.incoming_purchase_id
        LEFT JOIN inventory_ledger il ON il.id = ri.inventory_ledger_id
        WHERE ip.unit_cost_cents IS NULL
          AND il.buy_price IS NULL
          ${snapshotClause}
        ORDER BY ri.id
        LIMIT 100
      `).all();
      checks.push({
        id: 'receiving_issue_cost_basis',
        label: 'Receiving issues have a cost basis',
        description: 'Every receiving issue must resolve against either incoming-purchase unit cost or linked lot buy price. Missing basis can silently understate write-offs.',
        severity: issueCostBasis.issues > 0 ? 'error' : 'ok',
        count: issueCostBasis.issues,
        units: issueCostBasis.units,
        sample: issueCostBasisSample as Record<string, unknown>[],
        fix: 'Review the issue source and attach the correct hard purchase or lot link before resolving money-impacting outcomes.',
      });
    } else {
      checks.push({
        id: 'receiving_issue_cost_basis',
        label: 'Receiving issues have a cost basis',
        description: 'Receiving issue cost-basis audit is unavailable because this database has an older/minimal receiving schema.',
        severity: 'ok',
        count: 0,
        sample: [],
      });
    }

    // --- H: buy-list import receipt totals equal linked inventory rows ---
    // Lot-shrunk receiving issues (MFN batch "report issue") legitimately
    // remove units + basis from import-linked lots; add those back so the
    // immutable receipt still reconciles exactly.
    const hasLotShrunk = columnExists(db, 'receiving_issues', 'lot_shrunk');
    const shrunkCte = hasLotShrunk ? `
      shrunkTotals AS (
        SELECT il.listing_batch_import_id importId,
               COALESCE(SUM(ri.quantity), 0) units,
               COALESCE(SUM(ri.quantity * il.buy_price), 0) costCents,
               COALESCE(SUM(ri.quantity * COALESCE(il.list_price_cents, 0)), 0) listValueCents
        FROM receiving_issues ri
        JOIN inventory_ledger il ON il.id = ri.inventory_ledger_id
        WHERE ri.lot_shrunk = 1 AND il.listing_batch_import_id IS NOT NULL
        GROUP BY il.listing_batch_import_id
      ),` : '';
    const shrunkJoin = hasLotShrunk ? 'LEFT JOIN shrunkTotals st ON st.importId = lbi.id' : '';
    const shrunkUnits = hasLotShrunk ? 'COALESCE(st.units, 0)' : '0';
    const shrunkCost = hasLotShrunk ? 'COALESCE(st.costCents, 0)' : '0';
    const shrunkListValue = hasLotShrunk ? 'COALESCE(st.listValueCents, 0)' : '0';
    const importConservationSample = db.prepare(`
      WITH ${shrunkCte} lotTotals AS (
        SELECT listing_batch_import_id importId,
               COUNT(*) rowsImported,
               COALESCE(SUM(quantity), 0) totalUnits,
               COALESCE(SUM(quantity * buy_price), 0) totalCostCents,
               COALESCE(SUM(quantity * COALESCE(list_price_cents, 0)), 0) totalListValueCents
        FROM inventory_ledger
        WHERE listing_batch_import_id IS NOT NULL
        GROUP BY listing_batch_import_id
      ),
      itemTotals AS (
        SELECT listing_batch_import_id importId,
               COUNT(*) rowsImported,
               COALESCE(SUM(quantity), 0) totalUnits,
               COALESCE(SUM(quantity * buy_price_cents), 0) totalCostCents
        FROM listing_batch_items
        WHERE listing_batch_import_id IS NOT NULL
        GROUP BY listing_batch_import_id
      )
      SELECT lbi.id AS importId, lbi.batch_id AS batchId, b.channel,
             lbi.rows_imported AS expectedRows,
             COALESCE(lt.rowsImported, 0) AS lotRows,
             lbi.total_units AS expectedUnits,
             COALESCE(lt.totalUnits, 0) AS lotUnits,
             lbi.total_cost_cents AS expectedCostCents,
             COALESCE(lt.totalCostCents, 0) AS lotCostCents,
             lbi.total_list_value_cents AS expectedListValueCents,
             COALESCE(lt.totalListValueCents, 0) AS lotListValueCents,
             COALESCE(it.rowsImported, 0) AS itemRows,
             COALESCE(it.totalUnits, 0) AS itemUnits,
             COALESCE(it.totalCostCents, 0) AS itemCostCents,
             ${shrunkUnits} AS shrunkIssueUnits,
             ${shrunkCost} AS shrunkIssueCostCents
      FROM listing_batch_imports lbi
      JOIN listing_batches b ON b.id = lbi.batch_id
      LEFT JOIN lotTotals lt ON lt.importId = lbi.id
      LEFT JOIN itemTotals it ON it.importId = lbi.id
      ${shrunkJoin}
      WHERE lbi.rows_imported <> COALESCE(lt.rowsImported, 0)
         OR lbi.total_units <> COALESCE(lt.totalUnits, 0) + ${shrunkUnits}
         OR lbi.total_cost_cents <> COALESCE(lt.totalCostCents, 0) + ${shrunkCost}
         OR lbi.total_list_value_cents <> COALESCE(lt.totalListValueCents, 0) + ${shrunkListValue}
         OR (
           b.channel = 'FBA' AND (
             lbi.rows_imported <> COALESCE(it.rowsImported, 0)
             OR lbi.total_units <> COALESCE(it.totalUnits, 0)
             OR lbi.total_cost_cents <> COALESCE(it.totalCostCents, 0)
           )
         )
         OR (b.channel = 'MFN' AND COALESCE(it.rowsImported, 0) <> 0)
      ORDER BY lbi.id
    `).all() as Record<string, unknown>[];
    checks.push({
      id: 'buylist_import_conservation',
      label: 'Buy-list import conservation',
      description: 'Every immutable buy-list receipt must reconcile exactly to its linked ledger lots and, for FBA, batch items.',
      severity: importConservationSample.length > 0 ? 'error' : 'ok',
      count: importConservationSample.length,
      sample: importConservationSample.slice(0, 100),
      fix: 'Review the import receipt and linked source rows. Never duplicate or delete lots to force a match.',
    });

    // --- I: buy-list rows cannot point to missing import identities ---
    const orphanImportLots = db.prepare(`
      SELECT COUNT(*) rows
      FROM inventory_ledger il
      LEFT JOIN listing_batch_imports lbi ON lbi.id = il.listing_batch_import_id
      WHERE il.listing_batch_import_id IS NOT NULL AND lbi.id IS NULL
    `).get() as RowCount;
    const orphanImportItems = db.prepare(`
      SELECT COUNT(*) rows
      FROM listing_batch_items item
      LEFT JOIN listing_batch_imports lbi ON lbi.id = item.listing_batch_import_id
      WHERE item.listing_batch_import_id IS NOT NULL AND lbi.id IS NULL
    `).get() as RowCount;
    const duplicateImportKeys = db.prepare(`
      SELECT COUNT(*) duplicateKeys FROM (
        SELECT batch_id, content_hash
        FROM listing_batch_imports
        GROUP BY batch_id, content_hash
        HAVING COUNT(*) > 1
      )
    `).get() as DuplicateKeyCount;
    const importIdentityFailures =
      orphanImportLots.rows + orphanImportItems.rows + duplicateImportKeys.duplicateKeys;
    const importIdentitySample = db.prepare(`
      SELECT 'lot' AS rowType, il.id AS rowId,
             il.listing_batch_import_id AS importId, il.sku
      FROM inventory_ledger il
      LEFT JOIN listing_batch_imports lbi ON lbi.id = il.listing_batch_import_id
      WHERE il.listing_batch_import_id IS NOT NULL AND lbi.id IS NULL
      UNION ALL
      SELECT 'batch_item' AS rowType, item.id AS rowId,
             item.listing_batch_import_id AS importId, item.sku
      FROM listing_batch_items item
      LEFT JOIN listing_batch_imports lbi ON lbi.id = item.listing_batch_import_id
      WHERE item.listing_batch_import_id IS NOT NULL AND lbi.id IS NULL
      LIMIT 100
    `).all();
    checks.push({
      id: 'buylist_import_identity',
      label: 'Buy-list import identity integrity',
      description: 'Import keys must be unique and every import-created lot/item must reference its immutable import receipt.',
      severity: importIdentityFailures > 0 ? 'error' : 'ok',
      count: importIdentityFailures,
      sample: importIdentitySample as Record<string, unknown>[],
      fix: 'Treat as a source-identity defect; do not infer a replacement import from matching SKU or batch.',
    });

    // --- J: warning-only queue for legacy incoming rows needing review ---
    const legacyIncoming = db.prepare(`
      SELECT COUNT(*) purchases FROM incoming_purchases ip
      WHERE ip.status IN ('on_order', 'partial')
        AND (
          EXISTS (
            SELECT 1 FROM inventory_ledger il
            WHERE (ip.sku IS NOT NULL AND il.sku = ip.sku)
               OR (ip.sku IS NULL AND ip.asin IS NOT NULL AND il.asin = ip.asin)
          )
          OR EXISTS (
            SELECT 1 FROM order_items oi
            WHERE (ip.sku IS NOT NULL AND oi.sku = ip.sku)
               OR (ip.sku IS NULL AND ip.asin IS NOT NULL AND oi.asin = ip.asin)
          )
        )
    `).get() as PurchaseCount;
    const legacyIncomingSample = db.prepare(`
      SELECT ip.id AS incomingPurchaseId, ip.order_ref AS orderRef,
             ip.sku, ip.asin, ip.quantity,
             ip.quantity_received AS quantityReceived,
             (
               SELECT COUNT(*) FROM inventory_ledger il
               WHERE (ip.sku IS NOT NULL AND il.sku = ip.sku)
                  OR (ip.sku IS NULL AND ip.asin IS NOT NULL AND il.asin = ip.asin)
             ) AS candidateLots,
             (
               SELECT COUNT(*) FROM order_items oi
               WHERE (ip.sku IS NOT NULL AND oi.sku = ip.sku)
                  OR (ip.sku IS NULL AND ip.asin IS NOT NULL AND oi.asin = ip.asin)
             ) AS candidateSales
      FROM incoming_purchases ip
      WHERE ip.status IN ('on_order', 'partial')
        AND (
          EXISTS (
            SELECT 1 FROM inventory_ledger il
            WHERE (ip.sku IS NOT NULL AND il.sku = ip.sku)
               OR (ip.sku IS NULL AND ip.asin IS NOT NULL AND il.asin = ip.asin)
          )
          OR EXISTS (
            SELECT 1 FROM order_items oi
            WHERE (ip.sku IS NOT NULL AND oi.sku = ip.sku)
               OR (ip.sku IS NULL AND ip.asin IS NOT NULL AND oi.asin = ip.asin)
          )
        )
      ORDER BY ip.id
      LIMIT 100
    `).all();
    checks.push({
      id: 'legacy_incoming_reconciliation',
      label: 'Legacy incoming rows needing reconciliation review',
      description: 'Open incoming rows with possible lot or sale evidence. These are review candidates only; exact single-lot matches still require operator review before receipt identity is linked.',
      severity: legacyIncoming.purchases > 0 ? 'warn' : 'ok',
      count: legacyIncoming.purchases,
      sample: legacyIncomingSample as Record<string, unknown>[],
      fix: 'Use Incoming review controls. Bulk-link only checked high-confidence rows; handle all other candidates one row at a time.',
    });

    // --- J2: MFN/local receive rows that likely skipped buy-sheet reconciliation ---
    if (
      columnExists(db, 'inventory_ledger', 'asin')
      && columnExists(db, 'inventory_ledger', 'sku')
      && columnExists(db, 'inventory_ledger', 'quantity_received')
      && columnExists(db, 'inventory_ledger', 'received_at')
      && columnExists(db, 'incoming_purchases', 'asin')
      && columnExists(db, 'incoming_purchases', 'quantity')
      && columnExists(db, 'incoming_purchases', 'quantity_received')
      && columnExists(db, 'incoming_purchases', 'status')
      && columnExists(db, 'incoming_purchases', 'inventory_ledger_id')
    ) {
      const receivedLotOpenIncoming = db.prepare(`
        SELECT COUNT(*) AS rows,
               COALESCE(SUM(ip.quantity - ip.quantity_received), 0) AS units
        FROM inventory_ledger il
        JOIN incoming_purchases ip
          ON ip.asin = il.asin
        WHERE COALESCE(il.asin, '') <> ''
          AND (COALESCE(il.quantity_received, 0) > 0 OR il.received_at IS NOT NULL)
          AND ip.status IN ('on_order', 'partial')
          AND ip.quantity > ip.quantity_received
          AND NOT (
            COALESCE(ip.inventory_ledger_id = il.id, 0)
            OR EXISTS (
              SELECT 1 FROM incoming_receipt_allocations ira
              WHERE ira.incoming_purchase_id = ip.id
                AND ira.inventory_ledger_id = il.id
            )
          )
      `).get() as ReceivedLotOpenIncomingCount;
      const receivedLotOpenIncomingSample = db.prepare(`
        SELECT il.id AS inventoryLedgerId,
               il.sku,
               il.asin,
               il.quantity_received AS lotQuantityReceived,
               il.received_at AS lotReceivedAt,
               il.date_purchased AS lotDatePurchased,
               ip.id AS incomingPurchaseId,
               ip.order_ref AS orderRef,
               ip.quantity,
               ip.quantity_received AS incomingQuantityReceived,
               ip.ordered_at AS incomingOrderedAt,
               ip.status
        FROM inventory_ledger il
        JOIN incoming_purchases ip
          ON ip.asin = il.asin
        WHERE COALESCE(il.asin, '') <> ''
          AND (COALESCE(il.quantity_received, 0) > 0 OR il.received_at IS NOT NULL)
          AND ip.status IN ('on_order', 'partial')
          AND ip.quantity > ip.quantity_received
          AND NOT (
            COALESCE(ip.inventory_ledger_id = il.id, 0)
            OR EXISTS (
              SELECT 1 FROM incoming_receipt_allocations ira
              WHERE ira.incoming_purchase_id = ip.id
                AND ira.inventory_ledger_id = il.id
            )
          )
        ORDER BY ip.ordered_at ASC, ip.id ASC, il.id ASC
        LIMIT 100
      `).all();
      checks.push({
        id: 'received_local_lot_open_incoming',
        label: 'Received local lots with open same-ASIN incoming orders',
        description: 'A locally received lot shares an ASIN with an open buy-sheet order but is not linked through incoming receipt identity. This usually means the MFN batch receive skipped operator-confirmed reconciliation.',
        severity: receivedLotOpenIncoming.rows > 0 ? 'warn' : 'ok',
        count: receivedLotOpenIncoming.rows,
        units: receivedLotOpenIncoming.units,
        sample: receivedLotOpenIncomingSample as Record<string, unknown>[],
        fix: 'Use Incoming reconciliation to link the already-created lot to the buy-sheet row. Do not receive the order again.',
      });
    } else {
      checks.push({
        id: 'received_local_lot_open_incoming',
        label: 'Received local lots with open same-ASIN incoming orders',
        description: 'Audit unavailable because this database has an older/minimal incoming or inventory schema.',
        severity: 'ok',
        count: 0,
        sample: [],
      });
    }

    // --- K: MFN batches must not remain sending after the BUYABLE verification window ---
    const staleMfnSending = db.prepare(`
      SELECT COUNT(DISTINCT b.id) rows
      FROM listing_batches b
      WHERE b.channel = 'MFN'
        AND b.status = 'sending'
        AND b.sent_at IS NOT NULL
        AND julianday(b.sent_at) <= julianday('now') - (2.0 / 24.0)
        AND EXISTS (
          SELECT 1
          FROM listing_batch_items item
          WHERE item.batch_id = b.id
            AND COALESCE(item.listing_status, '') <> 'ACTIVE'
        )
    `).get() as RowCount;
    const staleMfnSendingSample = db.prepare(`
      SELECT b.id AS batchId, b.sent_at AS sentAt,
             item.id AS itemId, item.sku, item.listing_status AS listingStatus
      FROM listing_batches b
      JOIN listing_batch_items item ON item.batch_id = b.id
      WHERE b.channel = 'MFN'
        AND b.status = 'sending'
        AND b.sent_at IS NOT NULL
        AND julianday(b.sent_at) <= julianday('now') - (2.0 / 24.0)
        AND COALESCE(item.listing_status, '') <> 'ACTIVE'
      ORDER BY b.sent_at, b.id, item.id
      LIMIT 100
    `).all();
    checks.push({
      id: 'mfn_stale_sending_batches',
      label: 'MFN sending batches past BUYABLE verification timeout',
      description: 'MFN batches past the two-hour verification window must fail with unverified SKUs, never advance to ready without BUYABLE evidence.',
      severity: staleMfnSending.rows > 0 ? 'error' : 'ok',
      count: staleMfnSending.rows,
      sample: staleMfnSendingSample as Record<string, unknown>[],
      fix: 'Poll batch status or manually transition the MFN batch to failed for operator review. Do not mark it ready without BUYABLE evidence.',
    });

    // --- L: MFN shipping templates stored locally must resolve to synced Amazon templates ---
    if (tableExists(db, 'settings') && columnExists(db, 'inventory_ledger', 'merchant_shipping_group_name')) {
      const templateCacheRow = db.prepare(`
        SELECT value FROM settings WHERE key = 'amazon_shipping_templates'
      `).get() as { value: string } | undefined;
      const templateCache = parseAmazonShippingTemplateCache(templateCacheRow?.value);
      const localTemplateRows = db.prepare(`
        SELECT
          il.sku,
          il.asin,
          il.merchant_shipping_group_name AS template,
          SUM(CASE WHEN il.quantity_remaining > 0 THEN il.quantity_remaining ELSE 0 END) AS remainingQty
        FROM inventory_ledger il
        WHERE COALESCE(TRIM(il.merchant_shipping_group_name), '') <> ''
        GROUP BY il.sku, il.asin, il.merchant_shipping_group_name
      `).all() as Record<string, unknown>[];
      const staleTemplateRows = localTemplateRows
        .filter((row) => !resolveAmazonShippingTemplateName(String(row.template ?? ''), templateCache.templates));
      checks.push({
        id: 'mfn_stale_shipping_templates',
        label: 'MFN lots with stale shipping templates',
        description: 'MFN activation and new listing pushes require locally stored shipping templates to match the synced Amazon template list before merchant_shipping_group is sent.',
        severity: staleTemplateRows.length > 0 ? 'warn' : 'ok',
        count: staleTemplateRows.length,
        sample: staleTemplateRows.slice(0, 100),
        fix: 'Sync Amazon shipping templates in Settings, then update stale MFN lot template selections before pushing those SKUs.',
      });
    }

    // --- M: settlement period transaction coverage ---
    if (tableExists(db, 'settlement_periods') && tableExists(db, 'settlement_transactions')) {
      const settlementCoverageCount = { periods: countFlaggedSettlementCoveragePeriods(db, { excludeVerified: true }) };
      const settlementCoverageSample = getFlaggedSettlementCoveragePeriods(db, { limit: 100, excludeVerified: true });
      checks.push({
        id: 'settlement_transaction_coverage',
        label: 'Settlement period transaction coverage',
        description: 'Every stored settlement period within Amazon\'s ~90-day report window must have settlement transaction rows; multi-day periods with fewer rows than elapsed days are implausibly sparse. Older holes are permanently unfetchable and excluded.',
        severity: settlementCoverageCount.periods > 0 ? 'error' : 'ok',
        count: settlementCoverageCount.periods,
        sample: settlementCoverageSample.map((row) => ({ ...row })),
        fix: 'Re-fetch the affected settlement report through the settlement ingestion path. Do not hand-write settlement transaction rows.',
      });
    }

    // --- N: confirmed returns that FIFO could not restore to a recorded lot ---
    // A persisted inventory_restore_error means Amazon confirmed a SELLABLE
    // return but the deterministic FIFO replay found no lot capacity for it —
    // almost always an understated lot quantity (the sale was cost-carried
    // overflow). Inventory counts are silently wrong until the lot is fixed,
    // and the sync worker logs fifo_reconciliation_failed every tick.
    if (columnExists(db, 'refunds', 'inventory_restore_error')) {
      const restoreMismatch = db.prepare(`
        SELECT COUNT(*) AS rows FROM refunds
        WHERE inventory_restore_error IS NOT NULL
      `).get() as RowCount;
      const restoreMismatchSample = db.prepare(`
        SELECT id, order_id AS orderId, sku, asin, quantity, refund_date AS refundDate,
               inventory_restored_quantity AS restoredQuantity,
               inventory_restore_error AS error
        FROM refunds
        WHERE inventory_restore_error IS NOT NULL
        ORDER BY refund_date DESC
        LIMIT 100
      `).all();
      checks.push({
        id: 'return_restore_mismatches',
        label: 'Confirmed returns not restored to inventory',
        description: 'Amazon-confirmed SELLABLE returns whose units could not be restored to any recorded FIFO lot. Local stock is understated and the returns sync fails closed until resolved.',
        severity: restoreMismatch.rows > 0 ? 'error' : 'ok',
        count: restoreMismatch.rows,
        sample: restoreMismatchSample as Record<string, unknown>[],
        fix: 'Verify the true purchased quantity for the SKU’s lot (usually understated), correct inventory_ledger.quantity with operator sign-off, then re-run scoped FIFO for that SKU.',
      });
    }

    // --- O: customer-returns sync wedged (attempts keep failing after last success) ---
    // syncFbaCustomerReturns fails closed on unresolved report rows (ambiguous /
    // quantity-mismatch / restore-mismatch). Good rows still apply, but the
    // success stamp stops advancing — so a stuck stamp with newer attempts means
    // every daily run is erroring and real failures are being masked.
    if (tableExists(db, 'settings')) {
      const syncStamp = (key: string): string | null => {
        const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
        return row?.value || null;
      };
      const lastSuccess = syncStamp('customer_returns_last_sync');
      const lastAttempt = syncStamp('customer_returns_last_sync_attempted_at');
      const WEDGE_HOURS = 72; // 3 missed daily cycles
      const wedged = !!(
        lastAttempt
        && lastSuccess
        && new Date(lastAttempt).getTime() > new Date(lastSuccess).getTime()
        && Date.now() - new Date(lastSuccess).getTime() > WEDGE_HOURS * 3600000
      );
      checks.push({
        id: 'customer_returns_sync_wedged',
        label: 'Customer-returns sync wedged',
        description: 'The FBA customer-returns sync keeps attempting but has not succeeded in over 72 hours. It fails closed on unresolved report rows (ambiguous, quantity-mismatch, or unrestorable returns); until those rows are resolved, new failures are masked behind the standing one.',
        severity: wedged ? 'error' : 'ok',
        count: wedged ? 1 : 0,
        sample: wedged
          ? [{ lastSuccess, lastAttempt }]
          : [],
        fix: 'Check the sync worker log for the customer-return integrity failure counts, resolve the listed rows (see the return-restore check above; ambiguous/quantity-mismatch rows need manual refund-row review), then let the next daily run stamp success.',
      });
    }

    // --- Headline: COGS coverage % over all shipped, non-canceled real units ---
    const coverage = db.prepare(`
      SELECT
        COALESCE(SUM(oi.quantity),0) totalUnits,
        COALESCE(SUM(CASE WHEN oi.cogs_per_unit > 0 THEN oi.quantity ELSE 0 END),0) coveredUnits
      FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
      WHERE ${NOT_CANCELED} AND ${REAL_ASIN} AND ${COGS_RELEVANT}
    `).get() as CogsCoverageCount;
    const cogsCoveragePct = coverage.totalUnits > 0
      ? (coverage.coveredUnits / coverage.totalUnits) * 100
      : 100;

    const worst: Severity = checks.some(c => c.severity === 'error')
      ? 'error'
      : checks.some(c => c.severity === 'warn') ? 'warn' : 'ok';

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      overall: worst,
      summary: {
        cogsCoveragePct,
        totalUnits: coverage.totalUnits,
        coveredUnits: coverage.coveredUnits,
        zeroCogsUnits: zeroCogs.units,
        zeroCogsRevenueCents: zeroCogs.revenueCents,
      },
      checks,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
