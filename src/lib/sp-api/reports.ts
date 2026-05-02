/**
 * SP-API Reports API client.
 * Downloads settlement reports — Amazon's final word on all financial data.
 * This is where MFN shipping label costs live.
 */

import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

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
): Promise<any[]> {
  const params: Record<string, string> = {
    reportTypes: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
    processingStatuses: 'DONE',
    createdSince: startDate,
    pageSize: '100',
  };

  const response = await spApiRequest(credentials, '/reports/2021-06-30/reports', params);
  return response.reports || [];
}

/**
 * Download a report's content by document ID.
 */
export async function downloadReport(
  credentials: SPAPICredentials,
  reportDocumentId: string
): Promise<string> {
  const docResponse = await spApiRequest(
    credentials,
    `/reports/2021-06-30/documents/${reportDocumentId}`
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
 * Parse a settlement report TSV and extract shipping label costs.
 * Settlement reports are tab-separated with headers in the first row.
 */
function parseSettlementReport(content: string): number {
  const db = getDb();
  let updated = 0;

  try {
    const lines = content.split('\n');
    if (lines.length < 2) return 0;

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
      const altAmountIdx = colIndex('total');
      if (altOrderIdx === -1) return 0;
    }

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t').map(c => c.trim().replace(/"/g, ''));
      if (cols.length < Math.max(orderIdIdx, amountIdx) + 1) continue;

      const orderId = cols[orderIdIdx];
      const transactionType = transactionTypeIdx >= 0 ? cols[transactionTypeIdx] : '';
      const amountType = amountTypeIdx >= 0 ? cols[amountTypeIdx] : '';
      const amountDescription = amountDescriptionIdx >= 0 ? cols[amountDescriptionIdx] : '';
      const amount = parseFloat(cols[amountIdx] || '0');

      if (isNaN(amount)) continue;
      // Service fees have no order ID — don't skip them
      if (!orderId && transactionType !== 'other-transaction' && transactionType !== 'Liquidations') continue;

      // Get posted date from settlement report
      const postedDate = postedDateColIdx >= 0 && cols[postedDateColIdx] ? cols[postedDateColIdx] : new Date().toISOString();

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
            if (db.prepare('SELECT changes()').get() as any > 0) updated++;
          }
          continue;
        }

        // Check if we already have this service fee (by type + amount + date)
        const existing = db.prepare(`
          SELECT 1 FROM fee_details fd
          JOIN financial_events fe ON fd.financial_event_id = fe.id
          WHERE fe.event_type = 'SettlementServiceFee'
            AND fd.fee_type = ? AND fd.amount = ? AND date(fd.posted_date) = date(?)
          LIMIT 1
        `).get(feeType, feeCents, feeDate);

        if (!existing) {
          const eventResult = db.prepare(`
            INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
            VALUES ('SettlementServiceFee', ?, NULL, NULL, NULL, 'amazon', ?, ?, datetime('now'))
          `).run(feeDate, feeCents, JSON.stringify({ description: amountDescription, settlement: true }));

          if (eventResult.changes > 0) {
            db.prepare(`
              INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
              VALUES (?, NULL, NULL, ?, ?, ?, ?)
            `).run(Number(eventResult.lastInsertRowid), feeType, feeCategory, feeCents, feeDate);
            updated++;
          }
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
  } finally {
    db.close();
  }

  return updated;
}
