/**
 * SP-API FBA Customer Returns sync.
 *
 * Amazon's Financial Events API (what we already use for refunds) does NOT
 * include the customer's return reason — it's purely a money-flow API. Every
 * refund in our `refunds` table is hardcoded with `reason = 'CUSTOMER_RETURN'`
 * because there's nothing else to read from that response.
 *
 * This module closes that gap by pulling the dedicated FBA Customer Returns
 * report (`GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA`), which Amazon exposes
 * through the Reports API. Each row in that report has the real reason code
 * (DEFECTIVE, UNWANTED_ITEM, APPAREL_TOO_SMALL, NO_REASON_GIVEN, etc.) plus
 * the detailed disposition (SELLABLE, CUSTOMER_DAMAGED, ...).
 *
 * We request the report for a date range, poll until Amazon finishes
 * generating it, download the TSV, and UPDATE the `reason` column on matching
 * rows in our existing `refunds` table (matched by order_id + sku). The
 * existing `CUSTOMER_RETURN` placeholder is kept as the fallback for rows we
 * can't match (MFN returns, rows outside the reporting window, etc.).
 *
 * Limitations:
 *   - FBA only. MFN returns don't appear in this report — they have no API at
 *     all. For MFN we leave the placeholder in place.
 *   - Report generation is async and slow (30-120 seconds). This is why the
 *     sync uses a poll loop with a cap.
 *   - The report is date-range based, not incremental. Re-running it for a
 *     range just refreshes the reasons for refunds in that range.
 */
import { getAccessToken, getEndpoint } from './auth';
import { downloadReport } from './reports';
import Database from 'better-sqlite3';
import path from 'path';
import type { SPAPICredentials } from './types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export interface CustomerReturnRow {
  returnDate: string;
  orderId: string;
  sku: string;
  asin: string;
  fnsku: string | null;
  productName: string | null;
  quantity: number;
  fulfillmentCenterId: string | null;
  detailedDisposition: string | null;   // SELLABLE, CUSTOMER_DAMAGED, DEFECTIVE, CARRIER_DAMAGED, ...
  reason: string;                       // DEFECTIVE, UNWANTED_ITEM, APPAREL_TOO_SMALL, ...
  status: string | null;                // 'Reimbursed' or blank
  licensePlateNumber: string | null;
  customerComments: string | null;
}

/**
 * Request a customer returns report for a date range.
 * POST /reports/2021-06-30/reports
 *
 * Returns a reportId that we then poll with getReport() until Amazon finishes
 * generating it.
 */
export async function createCustomerReturnsReport(
  credentials: SPAPICredentials,
  startDate: string,  // ISO, e.g. "2026-01-01T00:00:00Z"
  endDate: string
): Promise<{ reportId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const body = {
    reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
    marketplaceIds: [credentials.marketplaceId],
    dataStartTime: startDate,
    dataEndTime: endDate,
  };

  const response = await fetch(`${endpoint}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API createReport ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  if (!data?.reportId) {
    throw new Error(`createReport: missing reportId in response: ${JSON.stringify(data)}`);
  }
  return { reportId: data.reportId };
}

/**
 * Poll a report's status until it's DONE (or we hit the timeout).
 * GET /reports/2021-06-30/reports/{reportId}
 *
 * Returns the final report object, which has `reportDocumentId` when status
 * is DONE. If processing fails or times out, throws.
 */
export async function waitForReport(
  credentials: SPAPICredentials,
  reportId: string,
  maxWaitMs: number = 240_000
): Promise<{ reportDocumentId: string; processingStatus: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const accessToken = await getAccessToken(credentials);
    const response = await fetch(
      `${endpoint}/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
      {
        headers: {
          'x-amz-access-token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`SP-API getReport ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const status: string = data.processingStatus;

    if (status === 'DONE') {
      if (!data.reportDocumentId) {
        throw new Error('Report DONE but no reportDocumentId');
      }
      return { reportDocumentId: data.reportDocumentId, processingStatus: status };
    }
    if (status === 'CANCELLED' || status === 'FATAL') {
      throw new Error(`Report generation ${status}: ${JSON.stringify(data)}`);
    }

    // Still IN_QUEUE or IN_PROGRESS — wait and try again
    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error(`Report ${reportId} did not complete within ${maxWaitMs}ms`);
}

/**
 * Parse the TSV body of a customer returns report.
 *
 * Columns (confirmed in Amazon docs, tab-separated, header row first):
 *   return-date, order-id, sku, asin, fnsku, product-name, quantity,
 *   fulfillment-center-id, detailed-disposition, reason, status,
 *   license-plate-number, customer-comments
 *
 * Column names with hyphens have to be looked up from the header row, not
 * hardcoded — Amazon sometimes adds/removes columns across report versions.
 */
export function parseCustomerReturnsReport(tsv: string): CustomerReturnRow[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const headerCols = lines[0].split('\t').map((h) => h.trim());
  const colIdx = (name: string) => headerCols.indexOf(name);

  const iReturnDate = colIdx('return-date');
  const iOrderId = colIdx('order-id');
  const iSku = colIdx('sku');
  const iAsin = colIdx('asin');
  const iFnsku = colIdx('fnsku');
  const iProductName = colIdx('product-name');
  const iQuantity = colIdx('quantity');
  const iFcId = colIdx('fulfillment-center-id');
  const iDisposition = colIdx('detailed-disposition');
  const iReason = colIdx('reason');
  const iStatus = colIdx('status');
  const iLpn = colIdx('license-plate-number');
  const iComments = colIdx('customer-comments');

  // Sanity: we absolutely need order-id and reason.
  if (iOrderId < 0 || iReason < 0) {
    throw new Error(
      `Customer returns report header missing required columns: ${headerCols.join(', ')}`
    );
  }

  const rows: CustomerReturnRow[] = [];
  for (let lineIdx = 1; lineIdx < lines.length; lineIdx++) {
    const cols = lines[lineIdx].split('\t');
    rows.push({
      returnDate: iReturnDate >= 0 ? cols[iReturnDate] || '' : '',
      orderId: cols[iOrderId] || '',
      sku: iSku >= 0 ? cols[iSku] || '' : '',
      asin: iAsin >= 0 ? cols[iAsin] || '' : '',
      fnsku: iFnsku >= 0 ? cols[iFnsku] || null : null,
      productName: iProductName >= 0 ? cols[iProductName] || null : null,
      quantity: iQuantity >= 0 ? parseInt(cols[iQuantity] || '0', 10) : 0,
      fulfillmentCenterId: iFcId >= 0 ? cols[iFcId] || null : null,
      detailedDisposition: iDisposition >= 0 ? cols[iDisposition] || null : null,
      reason: cols[iReason] || 'CUSTOMER_RETURN',
      status: iStatus >= 0 ? cols[iStatus] || null : null,
      licensePlateNumber: iLpn >= 0 ? cols[iLpn] || null : null,
      customerComments: iComments >= 0 ? cols[iComments] || null : null,
    });
  }

  return rows;
}

/**
 * Full sync: request the report, wait, download, parse, UPDATE our refunds
 * rows' `reason` column. Returns counts for the sync_log / API response.
 *
 * Match strategy:
 *   - Primary: (order_id + sku) — exact, since refunds are unique per SKU per order
 *   - Fallback: (order_id + asin) — when the refund was synced without a sku
 *   - Fallback: order_id only — if there's exactly one refund row for the order
 *
 * Match dates don't need to line up — the report's return-date may be a few
 * days off from our refund_date (posted_date of the adjustment event).
 */
export async function syncFbaCustomerReturns(
  credentials: SPAPICredentials,
  startDate: string,
  endDate: string
): Promise<{
  reportRows: number;
  refundsMatched: number;
  refundsUpdated: number;
  unmatched: number;
  reasonBreakdown: Record<string, number>;
}> {
  // 1. Request the report
  const { reportId } = await createCustomerReturnsReport(credentials, startDate, endDate);
  console.log(`[CustomerReturns] Created report ${reportId}`);

  // 2. Wait until Amazon finishes generating it
  const { reportDocumentId } = await waitForReport(credentials, reportId);
  console.log(`[CustomerReturns] Report ready, document ${reportDocumentId}`);

  // 3. Download and parse
  const tsv = await downloadReport(credentials, reportDocumentId);
  const rows = parseCustomerReturnsReport(tsv);
  console.log(`[CustomerReturns] Parsed ${rows.length} return rows`);

  // 4. UPDATE matching refunds
  const db = getDb();
  let refundsMatched = 0;
  let refundsUpdated = 0;
  let unmatched = 0;
  const reasonBreakdown: Record<string, number> = {};

  try {
    const findBySkuStmt = db.prepare(
      `SELECT id, reason FROM refunds WHERE order_id = ? AND sku = ? AND marketplace = 'amazon'`
    );
    const findByAsinStmt = db.prepare(
      `SELECT id, reason FROM refunds WHERE order_id = ? AND asin = ? AND marketplace = 'amazon' AND asin != ''`
    );
    const findByOrderOnlyStmt = db.prepare(
      `SELECT id, reason FROM refunds WHERE order_id = ? AND marketplace = 'amazon'`
    );
    const updateStmt = db.prepare(
      `UPDATE refunds SET reason = ? WHERE id = ?`
    );

    const tx = db.transaction(() => {
      for (const row of rows) {
        if (!row.orderId) continue;

        // Tally the reason regardless of whether we match — useful diagnostic
        reasonBreakdown[row.reason] = (reasonBreakdown[row.reason] || 0) + 1;

        // Try SKU first (exact match)
        let matches = row.sku
          ? (findBySkuStmt.all(row.orderId, row.sku) as { id: number; reason: string }[])
          : [];

        // Fall back to ASIN
        if (matches.length === 0 && row.asin) {
          matches = findByAsinStmt.all(row.orderId, row.asin) as { id: number; reason: string }[];
        }

        // Last resort: only match if there's exactly one refund for the order
        if (matches.length === 0) {
          const candidates = findByOrderOnlyStmt.all(row.orderId) as { id: number; reason: string }[];
          if (candidates.length === 1) matches = candidates;
        }

        if (matches.length === 0) {
          unmatched++;
          continue;
        }

        refundsMatched += matches.length;
        for (const m of matches) {
          // Only UPDATE if the reason would actually change — keeps transaction small on re-runs
          if (m.reason !== row.reason) {
            updateStmt.run(row.reason, m.id);
            refundsUpdated++;
          }
        }
      }
    });
    tx();
  } finally {
    db.close();
  }

  return {
    reportRows: rows.length,
    refundsMatched,
    refundsUpdated,
    unmatched,
    reasonBreakdown,
  };
}
