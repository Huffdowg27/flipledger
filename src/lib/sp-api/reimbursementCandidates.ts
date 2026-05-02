/**
 * Reimbursement Candidate detection.
 *
 * Pulls the FBA Inventory Adjustments report
 * (`GET_FBA_INVENTORY_ADJUSTMENTS_DATA`), which lists every adjustment
 * Amazon makes to your warehoused inventory — lost, damaged, found,
 * miscount, etc. We filter to negative-quantity events with reasons that
 * are eligible for seller reimbursement, then cross-check against the
 * existing `reimbursements` table to find ones that haven't been paid
 * out yet. Those are the "to-file" candidates the user can submit
 * claims for in Seller Central.
 *
 * Amazon's reimbursement window is generally 60 days from the date of
 * the adjustment (longer for some categories like customer returns —
 * up to 18 months). We compute `eligible_until = adjustment_date + 60d`
 * as a conservative deadline.
 */
import { getAccessToken, getEndpoint } from './auth';
import { downloadReport } from './reports';
import Database from 'better-sqlite3';
import path from 'path';
import type { SPAPICredentials } from './types';

const REIMBURSEMENT_WINDOW_DAYS = 60;

// In the GET_LEDGER_DETAIL_VIEW_DATA report, "reason" is typically a
// single-letter code (M=Missing/Lost, F=Found, Q=quantity error, etc.) —
// undocumented and inconsistent. The disposition column is more useful: it
// tells us if the unit ended up SELLABLE or in a damage state.
//
// Our heuristic: any adjustment with quantity < 0 is a candidate. The
// disposition narrows the cause (WAREHOUSE_DAMAGED, DISTRIBUTOR_DAMAGED,
// CUSTOMER_DAMAGED, etc.). User can dismiss false positives in the UI.
const REIMBURSABLE_DISPOSITIONS = [
  'WAREHOUSE_DAMAGED',
  'DISTRIBUTOR_DAMAGED',
  'CARRIER_DAMAGED',
  'DEFECTIVE',
  'SELLABLE',          // Lost-but-sellable (M-coded losses) — most reimbursable bucket
];

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function isReimbursable(quantity: number, disposition: string | null): boolean {
  if (quantity >= 0) return false; // positive = found/added, not a loss
  if (!disposition) return true;    // missing disposition — assume reimbursable, let user dismiss
  return REIMBURSABLE_DISPOSITIONS.includes(disposition);
}

interface AdjustmentRow {
  adjustmentDate: string;
  fnsku: string | null;
  sku: string | null;
  asin: string | null;
  productName: string | null;
  fcId: string | null;
  quantity: number;
  reason: string;
  disposition: string | null;
}

export async function createInventoryAdjustmentsReport(
  credentials: SPAPICredentials,
  startDate: string,
  endDate: string
): Promise<{ reportId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  // GET_LEDGER_DETAIL_VIEW_DATA is the canonical inventory-adjustment report
  // post-2023. The eventType column tells us why each row exists (Adjustments,
  // Receipts, CustomerReturns, etc.). We filter to Adjustments-type rows
  // downstream. No reportOptions — we want the raw event stream, not the
  // aggregated view (aggregation rolls multiple adjustments into single rows
  // and loses the per-event detail we need).
  const body = {
    reportType: 'GET_LEDGER_DETAIL_VIEW_DATA',
    marketplaceIds: [credentials.marketplaceId],
    dataStartTime: startDate,
    dataEndTime: endDate,
  };

  const response = await fetch(`${endpoint}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`createReport ${response.status}: ${errorBody}`);
  }
  const data = await response.json();
  if (!data?.reportId) throw new Error(`createReport: missing reportId in response`);
  return { reportId: data.reportId };
}

export async function waitForAdjustmentsReport(
  credentials: SPAPICredentials,
  reportId: string,
  maxWaitMs = 240_000
): Promise<{ reportDocumentId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const accessToken = await getAccessToken(credentials);
    const r = await fetch(`${endpoint}/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`, {
      headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    });
    if (!r.ok) throw new Error(`getReport ${r.status}: ${await r.text()}`);
    const d = await r.json();
    if (d.processingStatus === 'DONE') {
      if (!d.reportDocumentId) throw new Error('Report DONE but no reportDocumentId');
      return { reportDocumentId: d.reportDocumentId };
    }
    if (d.processingStatus === 'CANCELLED' || d.processingStatus === 'FATAL') {
      throw new Error(`Report ${d.processingStatus}: ${JSON.stringify(d)}`);
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error(`Report ${reportId} did not complete within ${maxWaitMs}ms`);
}

/**
 * Parse the GET_LEDGER_DETAIL_VIEW_DATA report. Columns (per Amazon docs):
 *   Date, FNSKU, ASIN, MSKU, Title, Event Type, Reference ID,
 *   Quantity, Fulfillment Center, Disposition, Reason, Country
 *
 * Note: Amazon wraps every cell in double quotes. Strip them before
 * comparing.
 *
 * We only care about rows where Event Type is "Adjustments" (the
 * eventType column groups by Receipts / Shipments / CustomerReturns /
 * Adjustments / etc.). Adjustments cover lost/found/damaged events.
 */
function unquote(s: string): string {
  if (!s) return '';
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

export function parseAdjustmentsReport(tsv: string): AdjustmentRow[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split('\t').map((h) => unquote(h));
  const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const iDate = idx('Date');
  const iFnsku = idx('FNSKU');
  const iSku = idx('MSKU');
  const iAsin = idx('ASIN');
  const iProduct = idx('Title');
  const iFc = idx('Fulfillment Center');
  const iQty = idx('Quantity');
  const iReason = idx('Reason');
  const iDisp = idx('Disposition');
  const iEvent = idx('Event Type');

  const rows: AdjustmentRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t').map(unquote);
    const eventType = iEvent >= 0 ? cols[iEvent] || '' : '';
    // Only adjustment-type events represent reimbursable losses
    if (eventType.toLowerCase() !== 'adjustments') continue;

    const reason = iReason >= 0 ? cols[iReason] || '' : '';
    if (!reason) continue;

    // Date in the report is M/D/YYYY (e.g. "05/01/2026"); normalize to YYYY-MM-DD
    let normalizedDate = '';
    if (iDate >= 0 && cols[iDate]) {
      const raw = cols[iDate];
      const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) {
        normalizedDate = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      } else {
        normalizedDate = raw;
      }
    }

    rows.push({
      adjustmentDate: normalizedDate,
      fnsku: iFnsku >= 0 ? cols[iFnsku] || null : null,
      sku: iSku >= 0 ? cols[iSku] || null : null,
      asin: iAsin >= 0 ? cols[iAsin] || null : null,
      productName: iProduct >= 0 ? cols[iProduct] || null : null,
      fcId: iFc >= 0 ? cols[iFc] || null : null,
      quantity: parseInt(cols[iQty] || '0', 10) || 0,
      reason,
      disposition: iDisp >= 0 ? cols[iDisp] || null : null,
    });
  }
  return rows;
}

/**
 * Match a candidate against existing reimbursements. A candidate is
 * "matched" (already paid out) if there's a reimbursement row with the
 * same ASIN/FNSKU within ±14 days of the adjustment date.
 */
function findExistingReimbursement(
  db: Database.Database,
  candidate: AdjustmentRow
): number | null {
  // The reimbursements table has asin and sku but no fnsku column. Match by
  // (asin OR sku) within ±14 days of adjustment.
  const date = candidate.adjustmentDate;
  const asin = candidate.asin || '';
  const sku = candidate.sku || '';
  if (!asin && !sku) return null;
  const row = db
    .prepare(
      `
      SELECT id FROM reimbursements
      WHERE marketplace = 'amazon'
        AND ABS(julianday(reimbursement_date) - julianday(?)) <= 14
        AND ((? != '' AND asin = ?) OR (? != '' AND sku = ?))
      LIMIT 1
    `
    )
    .get(date, asin, asin, sku, sku) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Top-level orchestrator. Pulls the report for a date range, filters,
 * inserts new candidates, marks already-reimbursed ones, returns counts.
 */
export async function syncReimbursementCandidates(
  credentials: SPAPICredentials,
  startDate: string,
  endDate: string
): Promise<{
  reportRows: number;
  reimbursableRows: number;
  newCandidates: number;
  alreadyReimbursed: number;
  totalEstimatedValueCents: number;
}> {
  const { reportId } = await createInventoryAdjustmentsReport(credentials, startDate, endDate);
  const { reportDocumentId } = await waitForAdjustmentsReport(credentials, reportId);
  const tsv = await downloadReport(credentials, reportDocumentId);

  // Dump raw TSV to a debug file for inspection. Overwritten on each sync.
  try {
    const fs = await import('fs');
    const debugPath = path.join(process.cwd(), 'data', 'debug-ledger-detail.tsv');
    fs.writeFileSync(debugPath, tsv);
    console.log(`[reimbursementCandidates] Raw TSV dumped to ${debugPath} (${tsv.length} bytes, ${tsv.split(/\r?\n/).length} lines)`);
  } catch (err) {
    console.warn(`[reimbursementCandidates] Failed to dump debug TSV: ${err}`);
  }

  const rows = parseAdjustmentsReport(tsv);

  // Filter to reimbursable losses (negative quantity, eligible disposition)
  const reimbursable = rows.filter((r) => isReimbursable(r.quantity, r.disposition));

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO reimbursement_candidates (
      adjustment_date, asin, sku, fnsku, product_name, fulfillment_center_id,
      reason, disposition, quantity, estimated_value_cents, eligible_until,
      status, matched_reimbursement_id, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(adjustment_date, COALESCE(fnsku,''), COALESCE(asin,''), reason, quantity)
    DO UPDATE SET
      product_name = excluded.product_name,
      fulfillment_center_id = excluded.fulfillment_center_id,
      disposition = excluded.disposition,
      estimated_value_cents = excluded.estimated_value_cents,
      eligible_until = excluded.eligible_until,
      matched_reimbursement_id = excluded.matched_reimbursement_id,
      status = CASE
        WHEN excluded.matched_reimbursement_id IS NOT NULL THEN 'matched'
        WHEN reimbursement_candidates.status IN ('filed', 'received', 'dismissed') THEN reimbursement_candidates.status
        ELSE excluded.status
      END,
      updated_at = datetime('now')
  `);

  // Amazon's FBA reimbursement policy pays "the lower of (a) your 18-month
  // average net retail sales price, or (b) Amazon's market evaluation."
  // We use the seller's average sale price (last 18 months) as our estimate
  // — that's much closer to what Amazon will actually pay than the COGS.
  // Falls back to last-known list price, then buy_price, then 0.
  const getValue = db.prepare(`
    SELECT
      (
        SELECT AVG(oi.price_per_unit)
        FROM order_items oi
        INNER JOIN orders o ON o.order_id = oi.order_id
        WHERE oi.asin = ?
          AND o.purchase_date >= date('now', '-18 months')
      ) as avg_sale_price,
      (
        SELECT list_price FROM live_inventory
        WHERE asin = ? AND list_price > 0
        ORDER BY id DESC LIMIT 1
      ) as list_price,
      (
        SELECT buy_price FROM inventory_ledger
        WHERE (sku = ? AND ? != '') OR (asin = ? AND ? != '')
        ORDER BY id DESC LIMIT 1
      ) as buy_price
  `);

  let newCandidates = 0;
  let alreadyReimbursed = 0;
  let totalValueCents = 0;

  const tx = db.transaction((items: AdjustmentRow[]) => {
    for (const item of items) {
      const matchedId = findExistingReimbursement(db, item);
      if (matchedId) alreadyReimbursed++;

      const valueRow = getValue.get(
        item.asin || '',                               // avg_sale_price: by ASIN
        item.asin || '',                               // list_price: by ASIN
        item.sku || '', item.sku || '',                // buy_price: by SKU
        item.asin || '', item.asin || ''               // buy_price fallback: by ASIN
      ) as { avg_sale_price: number | null; list_price: number | null; buy_price: number | null } | undefined;

      // Pick the best per-unit value: avg sale price > list price > buy price
      const perUnitCents = Math.round(
        valueRow?.avg_sale_price ||
        valueRow?.list_price ||
        valueRow?.buy_price ||
        0
      );
      const estimatedValue = Math.abs(item.quantity) * perUnitCents;
      if (matchedId === null) totalValueCents += estimatedValue;

      const eligibleUntil = new Date(
        new Date(item.adjustmentDate).getTime() + REIMBURSEMENT_WINDOW_DAYS * 86400000
      )
        .toISOString()
        .slice(0, 10);

      const result = insert.run(
        item.adjustmentDate,
        item.asin,
        item.sku,
        item.fnsku,
        item.productName,
        item.fcId,
        item.reason,
        item.disposition,
        item.quantity,
        estimatedValue,
        eligibleUntil,
        matchedId ? 'matched' : 'pending',
        matchedId
      );
      if (result.changes === 1 && !matchedId) newCandidates++;
    }
  });
  tx(reimbursable);

  // Auto-expire candidates past their eligible_until date
  db.prepare(`
    UPDATE reimbursement_candidates
    SET status = 'expired', updated_at = datetime('now')
    WHERE status = 'pending' AND date(eligible_until) < date('now')
  `).run();

  db.close();
  return {
    reportRows: rows.length,
    reimbursableRows: reimbursable.length,
    newCandidates,
    alreadyReimbursed,
    totalEstimatedValueCents: totalValueCents,
  };
}
