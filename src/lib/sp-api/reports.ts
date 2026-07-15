/**
 * SP-API Reports API client.
 * Downloads settlement reports — Amazon's final word on all financial data.
 * This is where MFN shipping label costs live.
 */

import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import { replaceSettlementReport } from './settlementParser';
import Database from 'better-sqlite3';
import path from 'path';
import {
  parseSettlementPeriodMetadata,
  upsertSettlementPeriod,
} from '../settlement-periods';
import type { SettlementReportListItem } from './settlement-report-resolution';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * List available settlement reports.
 */
export async function getSettlementReports(
  credentials: SPAPICredentials,
  startDate: string,
): Promise<SettlementReportListItem[]> {
  const params: Record<string, string> = {
    reportTypes: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
    processingStatuses: 'DONE',
    createdSince: startDate,
    pageSize: '100',
  };

  const response = await spApiRequest(credentials, '/reports/2021-06-30/reports', params);
  return response.reports || [];
}

export async function getSettlementReport(
  credentials: SPAPICredentials,
  reportId: string,
  retries = 1,
): Promise<SettlementReportListItem> {
  const report = await spApiRequest(
    credentials,
    `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
    undefined,
    retries,
  );
  return {
    reportId: String(report.reportId || reportId),
    reportDocumentId: report.reportDocumentId ? String(report.reportDocumentId) : undefined,
    dataStartTime: report.dataStartTime,
    dataEndTime: report.dataEndTime,
    createdTime: report.createdTime,
    processingStatus: report.processingStatus,
  };
}

/**
 * Download a report's content by document ID.
 */
export async function downloadReport(
  credentials: SPAPICredentials,
  reportDocumentId: string,
  retries = 3,
): Promise<string> {
  const docResponse = await spApiRequest(
    credentials,
    `/reports/2021-06-30/documents/${reportDocumentId}`,
    undefined,
    retries,
  );

  const downloadUrl = docResponse.url;
  if (!downloadUrl) throw new Error('No download URL in report document response');

  const reportResponse = await fetch(downloadUrl);
  if (!reportResponse.ok) {
    throw new Error(`Failed to download report: ${reportResponse.status}`);
  }

  // Some SP-API reports are returned gzip-compressed (indicated by
  // `compressionAlgorithm: GZIP` in the document response). Customer returns
  // happens to be uncompressed; ledger detail and most others are compressed.
  if (docResponse.compressionAlgorithm === 'GZIP') {
    const buf = Buffer.from(await reportResponse.arrayBuffer());
    const zlib = await import('zlib');
    return zlib.gunzipSync(buf).toString('utf-8');
  }

  return reportResponse.text();
}

/**
 * Download and ingest exactly one settlement report by report/settlement id.
 * This intentionally disables SP-API retries so an HTTP 429 or other failure
 * stops after the first attempt.
 */
export async function syncSingleSettlementReport(
  credentials: SPAPICredentials,
  settlementId: string,
): Promise<{ settlementId: string; reportDocumentId: string; rowsPersisted: number; shippingCostsUpdated: number }> {
  return syncSettlementReportByReportId(credentials, {
    reportId: settlementId,
    expectedSettlementId: settlementId,
  });
}

export async function syncSettlementReportByReportId(
  credentials: SPAPICredentials,
  input: {
    reportId: string;
    expectedSettlementId?: string | null;
    reportDocumentId?: string;
  },
): Promise<{
  settlementId: string;
  reportId: string;
  reportDocumentId: string;
  rowsPersisted: number;
  shippingCostsUpdated: number;
}> {
  const report = input.reportDocumentId
    ? { reportId: input.reportId, reportDocumentId: input.reportDocumentId }
    : await getSettlementReport(credentials, input.reportId, 1);
  const reportDocumentId = String(report.reportDocumentId || '');
  if (!reportDocumentId) {
    throw new Error(`Settlement report ${input.reportId} has no reportDocumentId`);
  }

  const content = await downloadReport(credentials, reportDocumentId, 1);
  const metadata = parseSettlementPeriodMetadata(content);
  if (!metadata) {
    throw new Error(`Settlement report ${input.reportId} did not contain settlement period metadata`);
  }
  if (input.expectedSettlementId && metadata.settlementId !== input.expectedSettlementId) {
    throw new Error(`Settlement report metadata id ${metadata.settlementId} did not match requested ${input.expectedSettlementId}`);
  }

  const shippingCostsUpdated = parseSettlementReport(content);
  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS rowsPersisted
      FROM settlement_transactions
      WHERE settlement_id = ?
    `).get(metadata.settlementId) as { rowsPersisted: number };
    return {
      settlementId: metadata.settlementId,
      reportId: input.reportId,
      reportDocumentId,
      rowsPersisted: row.rowsPersisted,
      shippingCostsUpdated,
    };
  } finally {
    db.close();
  }
}

/**
 * Metadata-only extractor: reads settlement-id, start-date, end-date, deposit-date
 * from the first parseable data row of a settlement report TSV.
 * Writes ONLY to settlement_periods. Touches no financial data.
 * All dates are normalized to "YYYY-MM-DD HH:MM:SS UTC" before storage.
 *
 * Returns the settlement_id that was upserted, or null if columns were absent.
 */
export function extractAndStoreSettlementPeriod(content: string): string | null {
  const db = getDb();
  try {
    const metadata = parseSettlementPeriodMetadata(content);
    if (!metadata) return null;
    upsertSettlementPeriod(db, metadata);
    return metadata.settlementId;
  } finally {
    db.close();
  }
}

/**
 * Given a requested start date, return the effective settlement period start
 * to use for reconciled mode.
 *
 * Tie-break order (ascending priority):
 *   1. earliest start_date >= requestedStart
 *   2. shortest duration (end_date - start_date) when start_dates tie
 *   3. earliest end_date when durations tie
 *   4. lowest settlement_id (lexicographic) for deterministic behavior
 *
 * Returns null when no periods exist or none start on/after requestedStart.
 */
export function getEffectiveReconcileStart(
  db: ReturnType<typeof import('better-sqlite3')>,
  requestedStart: string
): { settlement_id: string; start_date: string; end_date: string } | null {
  // SQLite stores dates as "YYYY-MM-DD HH:MM:SS UTC"; substring comparison is
  // safe for ISO-formatted dates once the bad row is fixed.
  const row = db.prepare(`
    SELECT settlement_id, start_date, end_date
    FROM settlement_periods
    WHERE substr(start_date, 1, 10) >= substr(?, 1, 10)
    ORDER BY
      substr(start_date, 1, 19),                          -- 1. earliest start
      (julianday(substr(end_date,1,19)) -
       julianday(substr(start_date,1,19))),               -- 2. shortest duration
      substr(end_date, 1, 19),                            -- 3. earliest end
      settlement_id                                       -- 4. lowest id
    LIMIT 1
  `).get(requestedStart) as { settlement_id: string; start_date: string; end_date: string } | undefined;

  return row ?? null;
}

/**
 * Backfill settlement_periods from historical reports.
 * Downloads each report and calls extractAndStoreSettlementPeriod — touches
 * NO financial tables (orders, fee_details, reimbursements, reserve_balance_history).
 */
export async function backfillSettlementPeriods(
  credentials: SPAPICredentials,
  startDate: string
): Promise<{ processed: number; upserted: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let processed = 0;
  let upserted = 0;
  let skipped = 0;

  try {
    const reports = await getSettlementReports(credentials, startDate);
    console.log(`[Settlement Backfill] Found ${reports.length} reports since ${startDate}`);

    for (const report of reports) {
      try {
        if (!report.reportDocumentId) { skipped++; continue; }

        const content = await downloadReport(credentials, report.reportDocumentId);
        processed++;

        const sid = extractAndStoreSettlementPeriod(content);
        if (sid) {
          upserted++;
          console.log(`[Settlement Backfill] Stored period for settlement_id=${sid}`);
        } else {
          skipped++;
          console.warn(`[Settlement Backfill] No metadata extracted from report ${report.reportId}`);
        }

        // Rate-limit between downloads
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        errors.push(`Report ${report.reportId}: ${err}`);
      }
    }
  } catch (err) {
    errors.push(`Report listing: ${err}`);
  }

  return { processed, upserted, skipped, errors };
}

/**
 * Sync settlement reports — downloads all available reports and extracts
 * shipping label costs + any other data we're missing from Financial Events.
 */
export async function syncSettlementReports(
  credentials: SPAPICredentials,
  startDate: string
): Promise<{ reportsProcessed: number; shippingCostsUpdated: number; errors: string[] }> {
  const errors: string[] = [];
  let reportsProcessed = 0;
  let shippingCostsUpdated = 0;

  try {
    const reports = await getSettlementReports(credentials, startDate);
    console.log(`[Sync] Found ${reports.length} settlement reports`);

    for (const report of reports) {
      try {
        if (!report.reportDocumentId) continue;

        const content = await downloadReport(credentials, report.reportDocumentId);
        const updated = parseSettlementReport(content);
        shippingCostsUpdated += updated;
        reportsProcessed++;

        // Rate limit
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        errors.push(`Report ${report.reportId}: ${err}`);
      }
    }
  } catch (err) {
    errors.push(`Settlement reports listing: ${err}`);
  }

  return { reportsProcessed, shippingCostsUpdated, errors };
}

/**
 * Parse a settlement report TSV.
 * Extracts: settlement period metadata (settlement-id, start/end date, deposit-date),
 * shipping label costs, service fees, reserve balance rows, and reimbursements.
 */
function parseSettlementReport(content: string): number {
  const db = getDb();
  let updated = 0;

  try {
    const lines = content.split('\n');
    if (lines.length < 2) return 0;

    const settlementPeriod = parseSettlementPeriodMetadata(content);
    if (settlementPeriod) {
      upsertSettlementPeriod(db, settlementPeriod);
    }

    // Per-transaction settlement lines (the settlement-accurate backbone for
    // Profit First / returns reconciliation) are persisted AFTER this loop via
    // the shared, tested `replaceSettlementReport` helper — see the end of this
    // function. The duplicate inline create/track/delete/insert logic was
    // removed so production and the test harness share one implementation.

    // Parse header to find column indices
    const headers = lines[0].split('\t').map(h => h.trim().replace(/"/g, ''));
    const colIndex = (name: string) => headers.indexOf(name);

    const orderIdIdx = colIndex('order-id');
    const transactionTypeIdx = colIndex('transaction-type');
    const amountTypeIdx = colIndex('amount-type');
    const amountDescriptionIdx = colIndex('amount-description');
    const amountIdx = colIndex('amount');
    const postedDateColIdx = colIndex('posted-date') >= 0 ? colIndex('posted-date') : colIndex('posted-date-time');

    if (orderIdIdx === -1 || amountIdx === -1) {
      // Try V1 format columns
      const altOrderIdx = colIndex('order id');
      if (altOrderIdx === -1) return 0;
    }

    // Multiplicity tracker for service-fee rows within THIS report. Amazon
    // legitimately charges identical fees (same type/amount/day) several times —
    // e.g. two $0.84 removal fees for the same removal order on one day. A pure
    // (type, amount, date) existence check collapses those and undercounts
    // expenses, so we count occurrences and top the DB up to match.
    const serviceFeeSeen = new Map<string, number>();

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t').map(c => c.trim().replace(/"/g, ''));
      if (cols.length < Math.max(orderIdIdx, amountIdx) + 1) continue;

      const orderId = cols[orderIdIdx];
      const transactionType = transactionTypeIdx >= 0 ? cols[transactionTypeIdx] : '';
      const amountType = amountTypeIdx >= 0 ? cols[amountTypeIdx] : '';
      const amountDescription = amountDescriptionIdx >= 0 ? cols[amountDescriptionIdx] : '';
      // Same blank-amount rule as parseSettlementLines (the settlement-line
      // backbone): a blank amount cell is not a financial transaction — skip it
      // so both passes agree and the unused row never reaches posted-date
      // fallback. Explicit "0"/"0.00" is preserved; non-numeric is rejected.
      const rawAmount = cols[amountIdx] ?? '';
      if (rawAmount.trim() === '') continue;
      const amount = parseFloat(rawAmount);

      if (isNaN(amount)) continue;

      // Get posted date from settlement report
      const postedDate = postedDateColIdx >= 0 && cols[postedDateColIdx] ? cols[postedDateColIdx] : new Date().toISOString();

      // Service fees have no order ID — don't skip them
      if (!orderId && transactionType !== 'other-transaction' && transactionType !== 'Liquidations') continue;

      // Shipping label costs
      if (transactionType === 'other-transaction' && amountDescription === 'Shipping label purchase' && amount < 0) {
        const costCents = Math.abs(Math.round(amount * 100));
        const result = db.prepare(`
          UPDATE order_items SET shipping_cost = ? WHERE order_id = ? AND shipping_cost = 0
        `).run(costCents, orderId);
        if (result.changes > 0) updated++;
      }

      // Reserve balance — Amazon's Deferred Disbursement +7 hold. Captured
      // separately so we can show "Available vs Held" cash flow on the
      // dashboard. Each settlement report includes a "Current Reserve Amount"
      // (held now) and "Previous Reserve Amount Balance" (was held last cycle).
      if (transactionType === 'other-transaction'
          && (amountDescription === 'Current Reserve Amount' || amountDescription === 'Previous Reserve Amount Balance')) {
        const reserveCents = Math.round(amount * 100);
        let reserveDate = postedDate || new Date().toISOString();
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(reserveDate)) {
          const [dd, mm, yyyy] = reserveDate.split('.');
          reserveDate = `${yyyy}-${mm}-${dd}`;
        }
        // Upsert: each settlement should have one Current + one Previous row.
        // Match on (marketplace, posted_date) and update whichever field this row is.
        const existing = db.prepare(`
          SELECT id FROM reserve_balance_history
          WHERE marketplace = 'amazon' AND posted_date = ?
        `).get(reserveDate) as { id?: number } | undefined;

        if (existing?.id) {
          if (amountDescription === 'Current Reserve Amount') {
            db.prepare('UPDATE reserve_balance_history SET current_reserve_cents = ?, raw_data = ? WHERE id = ?').run(reserveCents, JSON.stringify({ amountDescription, amount }), existing.id);
          } else {
            db.prepare('UPDATE reserve_balance_history SET previous_reserve_cents = ?, raw_data = ? WHERE id = ?').run(reserveCents, JSON.stringify({ amountDescription, amount }), existing.id);
          }
        } else {
          db.prepare(`
            INSERT INTO reserve_balance_history (marketplace, posted_date, current_reserve_cents, previous_reserve_cents, raw_data, created_at)
            VALUES ('amazon', ?, ?, ?, ?, datetime('now'))
          `).run(
            reserveDate,
            amountDescription === 'Current Reserve Amount' ? reserveCents : 0,
            amountDescription === 'Previous Reserve Amount Balance' ? reserveCents : 0,
            JSON.stringify({ amountDescription, amount })
          );
        }
        continue;
      }

      // Service fees from settlement (storage, subscriptions, inbound, etc.)
      // These have proper posted dates that match when they were actually charged
      // transaction-type = 'other-transaction', amount-type varies ('other-transaction', 'FBA Inventory Reimbursement', etc.)
      if (transactionType === 'other-transaction' && amount !== 0
          && amountDescription !== 'Shipping label purchase'
          && amountDescription !== 'Payable to Amazon'
          && amountDescription !== 'Successful charge'
          && amountDescription !== 'Current Reserve Amount'
          && amountDescription !== 'Previous Reserve Amount Balance') {
        const feeCents = Math.round(amount * 100);
        const feeType = amountDescription.replace(/\s+/g, '');
        const feeCategory =
          amountDescription.includes('Storage') || amountDescription.includes('storage') ? 'FBA Inventory and Inbound Service Fees' :
          amountDescription.includes('Subscription') || amountDescription.includes('subscription') ? 'FBA Inventory and Inbound Service Fees' :
          amountDescription.includes('Inbound') || amountDescription.includes('inbound') ? 'FBA Inventory and Inbound Service Fees' :
          amountDescription.includes('Removal') || amountDescription.includes('Disposal') ? 'FBA Inventory and Inbound Service Fees' :
          amountDescription.includes('Advertising') || amountDescription.includes('Cost of Advertising') ? 'Advertising' :
          'Other Fees';

        // Use settlement posted date, not API fetch time
        // Handle multiple date formats: YYYY-MM-DD, DD.MM.YYYY, ISO
        let feeDate = postedDate || new Date().toISOString();
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(feeDate)) {
          // DD.MM.YYYY → YYYY-MM-DD
          const [dd, mm, yyyy] = feeDate.split('.');
          feeDate = `${yyyy}-${mm}-${dd}`;
        }

        // Reimbursements go to the reimbursements table, not fee_details
        if (amountType === 'FBA Inventory Reimbursement' && feeCents > 0) {
          // Skip if the canonical FBA Reimbursements Report already has this
          // entry (same date + amount). Settlement rows have no sku/asin so
          // we match on date+amount only — canonical numeric IDs win.
          const canonical = db.prepare(`
            SELECT 1 FROM reimbursements
            WHERE marketplace = 'amazon'
              AND reimbursement_id GLOB '[0-9]*'
              AND date(reimbursement_date) = date(?)
              AND amount = ?
            LIMIT 1
          `).get(feeDate, feeCents);

          if (!canonical) {
            const reimbId = `SETTLEMENT-${amountDescription.replace(/\s+/g, '-')}-${feeDate}-${feeCents}`;
            db.prepare(`
              INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
              VALUES (?, ?, NULL, NULL, ?, ?, 1, 'Approved', 'amazon', datetime('now'))
            `).run(reimbId, feeDate, amountDescription, feeCents);
            const changes = db.prepare('SELECT changes() AS changes').get() as { changes: number };
            if (changes.changes > 0) updated++;
          }
          continue;
        }

        // Dedup with multiplicity: compare how many identical rows (type+amount+day)
        // this report contains so far vs how many the DB already holds, and insert
        // only the difference. Re-parsing the same report stays a no-op.
        const seenKey = `${feeType}|${feeCents}|${String(feeDate).slice(0, 10)}`;
        const seen = (serviceFeeSeen.get(seenKey) || 0) + 1;
        serviceFeeSeen.set(seenKey, seen);

        const existingCount = (db.prepare(`
          SELECT COUNT(*) as cnt FROM fee_details fd
          JOIN financial_events fe ON fd.financial_event_id = fe.id
          WHERE fe.event_type = 'SettlementServiceFee'
            AND fd.fee_type = ? AND fd.amount = ? AND date(fd.posted_date) = date(?)
        `).get(feeType, feeCents, feeDate) as { cnt: number }).cnt;

        if (existingCount < seen) {
          // Duplicate rows share one anchor financial_events row — the unique
          // index (event_type, order_id, asin, sku, posted_date, total_amount)
          // cannot hold two identical events, so multiplicity lives in
          // fee_details (which has no unique index).
          const anchor = db.prepare(`
            SELECT id FROM financial_events
            WHERE event_type = 'SettlementServiceFee' AND order_id IS NULL
              AND total_amount = ? AND posted_date = ?
            LIMIT 1
          `).get(feeCents, feeDate) as { id?: number } | undefined;

          let eventId = anchor?.id;
          if (!eventId) {
            const eventResult = db.prepare(`
              INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
              VALUES ('SettlementServiceFee', ?, NULL, NULL, NULL, 'amazon', ?, ?, datetime('now'))
            `).run(feeDate, feeCents, JSON.stringify({ description: amountDescription, settlement: true }));
            eventId = Number(eventResult.lastInsertRowid);
          }

          db.prepare(`
            INSERT INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
            VALUES (?, NULL, NULL, ?, ?, ?, ?)
          `).run(eventId, feeType, feeCategory, feeCents, feeDate);
          updated++;
        }
      }

      // Capture fees for orders missing fee_details (Commission, FBA fees, etc.)
      if (transactionType === 'Order' && amountType === 'ItemFees' && amount < 0 && orderId) {
        const existing = db.prepare(
          'SELECT 1 FROM fee_details WHERE order_id = ? AND fee_type = ? LIMIT 1'
        ).get(orderId, amountDescription);
        if (!existing) {
          const feeCents = Math.round(amount * 100);
          const feeCategory = amountDescription === 'Commission' ? 'Selling Fees' :
            amountDescription.includes('FBA') ? 'FBA Transaction Fees' :
            amountDescription.includes('Variable') ? 'Selling Fees' : 'Other Fees';
          db.prepare(`
            INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
            VALUES (0, ?, NULL, ?, ?, ?, datetime('now'))
          `).run(orderId, amountDescription, feeCategory, feeCents);
          updated++;
        }
      }
    }

    // Settlement-line backbone: replace this settlement's stored transaction
    // lines in ONE atomic, tested operation, only after the report loop above
    // has finished its side effects. A report that resolves a valid settlement
    // with zero valid amount rows throws here and leaves the prior rows intact
    // (see replaceSettlementReport / replaceSettlementLines in settlementParser).
    replaceSettlementReport(db, content);
  } finally {
    db.close();
  }

  return updated;
}
