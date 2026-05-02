/**
 * Walmart Marketplace Reconciliation Report API client.
 * Reports are ZIP files containing CSV with exact fees per order.
 */

import { getAccessToken } from './auth';
import type { WalmartCredentials } from './types';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import { execSync, } from 'child_process';
import fs from 'fs';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function toCents(amount: number | string | undefined): number {
  if (amount === undefined || amount === null || amount === '') return 0;
  return Math.round(Number(amount) * 100);
}

/**
 * Get list of available reconciliation report dates.
 */
export async function getAvailableReconDates(
  credentials: WalmartCredentials,
): Promise<string[]> {
  const token = await getAccessToken(credentials);
  const response = await fetch(
    'https://marketplace.walmartapis.com/v3/report/reconreport/availableReconFiles',
    {
      headers: {
        'WM_SEC.ACCESS_TOKEN': token,
        'WM_SVC.NAME': 'Walmart Marketplace',
        'WM_QOS.CORRELATION_ID': uuidv4(),
        'Accept': 'application/json',
      },
    },
  );
  if (!response.ok) return [];
  const data = await response.json();
  return data?.availableApReportDates || [];
}

/**
 * Download and parse a reconciliation report for a specific date.
 * The API returns a ZIP file containing a CSV.
 */
export async function syncReconReport(
  credentials: WalmartCredentials,
  reportDate: string,
): Promise<{ recordsFetched: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let recordsFetched = 0;

  try {
    const token = await getAccessToken(credentials);

    // Download ZIP
    const response = await fetch(
      `https://marketplace.walmartapis.com/v3/report/reconreport/reconFile?reportDate=${reportDate}&reportVersion=v1`,
      {
        headers: {
          'WM_SEC.ACCESS_TOKEN': token,
          'WM_SVC.NAME': 'Walmart Marketplace',
          'WM_QOS.CORRELATION_ID': uuidv4(),
          'Accept': 'application/octet-stream',
        },
      },
    );

    if (!response.ok) {
      errors.push(`Recon report ${reportDate}: HTTP ${response.status}`);
      return { recordsFetched, errors };
    }

    // Save ZIP and extract
    const buffer = Buffer.from(await response.arrayBuffer());
    const tmpZip = `/tmp/walmart_recon_${reportDate}.zip`;
    const tmpDir = `/tmp/walmart_recon_${reportDate}`;
    fs.writeFileSync(tmpZip, buffer);
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`cd ${tmpDir} && unzip -o ${tmpZip}`, { stdio: 'pipe' });

    // Find the CSV
    const csvFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.csv'));
    if (csvFiles.length === 0) {
      errors.push(`Recon report ${reportDate}: No CSV in ZIP`);
      return { recordsFetched, errors };
    }

    const csvContent = fs.readFileSync(path.join(tmpDir, csvFiles[0]), 'utf-8');
    const lines = csvContent.split('\n').filter(l => l.trim());
    if (lines.length < 3) return { recordsFetched, errors };

    // Parse CSV: row 0 = headers, row 1 = "Number of Lines...", row 2+ = data or PaymentSummary
    const headers = lines[0].split(',').map(h => h.trim());
    const now = new Date().toISOString();

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length < headers.length) continue;

      const entry: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        entry[headers[j]] = (values[j] || '').trim();
      }

      // Skip metadata rows
      if (!entry['Purchase Order #'] || !entry['Amount Type']) continue;
      if (entry['Transaction Type'] === 'PaymentSummary') continue;

      try {
        processReconEntry(db, entry, now);
        recordsFetched++;
      } catch (err: any) {
        errors.push(`Recon entry: ${err.message}`);
      }
    }

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.unlinkSync(tmpZip);

  } catch (err: any) {
    errors.push(`Recon report ${reportDate}: ${err.message}`);
  } finally {
    db.close();
  }

  return { recordsFetched, errors };
}

/**
 * Sync all available recon reports from the last N days.
 */
export async function syncAllReconReports(
  credentials: WalmartCredentials,
  sinceDays: number = 90,
): Promise<{ recordsFetched: number; errors: string[] }> {
  const dates = await getAvailableReconDates(credentials);
  // Dates are in MMDDYYYY format
  const cutoff = new Date(Date.now() - sinceDays * 86400000);

  let totalFetched = 0;
  const allErrors: string[] = [];

  for (const dateStr of dates) {
    // Parse MMDDYYYY
    const month = parseInt(dateStr.substring(0, 2));
    const day = parseInt(dateStr.substring(2, 4));
    const year = parseInt(dateStr.substring(4, 8));
    const reportDate = new Date(year, month - 1, day);

    if (reportDate < cutoff) continue;

    console.log(`[Walmart Recon] Processing report ${dateStr}...`);
    const result = await syncReconReport(credentials, dateStr);
    totalFetched += result.recordsFetched;
    allErrors.push(...result.errors);
  }

  return { recordsFetched: totalFetched, errors: allErrors };
}

function processReconEntry(db: Database.Database, entry: Record<string, string>, now: string) {
  const orderId = entry['Purchase Order #'];
  const sku = entry['Partner Item Id'] || '';
  const amountType = entry['Amount Type'] || '';
  const amount = toCents(entry['Amount']);
  const postedDate = entry['Transaction Posted Timestamp'] || now;
  const commissionRate = entry['Commission Rate'] || '';
  const category = entry['Contract Category'] || '';
  const commissionSaving = toCents(entry['Commission Saving']);
  const incentiveProgram = entry['Commission Incentive Program'] || '';

  if (!orderId || amount === 0) return;

  const transactionType = entry['Transaction Type'] || '';

  // Convert posted date once for refund-event handling below
  let refundIsoDate = now;
  if (postedDate.includes('/')) {
    const parts = postedDate.split('/');
    if (parts.length === 3) {
      refundIsoDate = `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}T00:00:00Z`;
    }
  }

  // ----- Dispute Settlement: customer return reversed, Walmart credited us back -----
  // Structurally a reimbursement (income), not a fee. Amount is positive in the
  // raw recon data and must STAY positive. Goes to the reimbursements table,
  // mirroring Amazon's FBA reimbursements.
  if (transactionType === 'Dispute Settlement') {
    const txKey = entry['Transaction Key'] || `${orderId}-${refundIsoDate}-${amount}`;
    const reason = entry['Transaction Description'] || 'Dispute Settlement';

    db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('WalmartDisputeSettlement', ?, ?, ?, ?, 'walmart', ?, ?, ?)
    `).run(refundIsoDate, orderId, sku, sku, amount, JSON.stringify(entry), now);

    if (amount > 0) {
      db.prepare(`
        INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'Approved', 'walmart', ?)
      `).run(`WMT-DISPUTE-${txKey}`, refundIsoDate, sku, sku, `Dispute: ${reason}`, amount, now);
    }
    return;
  }

  // Handle Refund-type rows. Walmart sends one Refund row per amountType
  // (Product Price, Commission on Product, WFS Inventory Fee/Reimbursement,
  // etc.) for the same return. We:
  //   1. Update the refund_amount on the refunds row (Product Price only —
  //      that's the customer-facing dollar value)
  //   2. ALWAYS create a WalmartRefundEvent financial_event so we have an
  //      audit trail of every refund-related debit/credit. This is what
  //      dispute candidates use to verify a refund actually settled.
  //   3. For Commission on Product credits (positive amount = clawback returning
  //      the original referral fee to seller), mirror to fee_details so the
  //      original fee charge is offset in P&L.
  if (transactionType === 'Refund') {
    if (amountType === 'Product Price' && amount < 0) {
      db.prepare(`
        UPDATE refunds SET refund_amount = ? WHERE order_id = ? AND marketplace = 'walmart' AND refund_amount = 0
      `).run(Math.abs(amount), orderId);
    }

    // Audit trail row — preserves raw sign (negative = customer refund debit,
    // positive = clawback credit returning to seller).
    const refundFeResult = db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('WalmartRefundEvent', ?, ?, ?, ?, 'walmart', ?, ?, ?)
    `).run(refundIsoDate, orderId, sku, sku, amount, JSON.stringify(entry), now);

    // For commission clawbacks (positive amount on a Refund/Commission row),
    // mirror to fee_details so the original fee is offset in P&L.
    const refundEventId = refundFeResult.changes > 0 ? Number(refundFeResult.lastInsertRowid) : null;
    if (refundEventId && amount > 0 && amountType === 'Commission on Product') {
      db.prepare(`
        INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
        VALUES (?, ?, ?, 'WalmartReferralFeeClawback', 'Walmart Referral Fee', ?, ?)
      `).run(refundEventId, orderId, sku, amount, refundIsoDate);
    }
    return;
  }

  // Map Walmart amount types to our fee categories
  let feeType: string;
  let feeCategory: string;

  switch (amountType) {
    case 'Commission on Product':
      feeType = 'WalmartReferralFee';
      feeCategory = 'Walmart Referral Fee';
      break;
    case 'Fee/Reimbursement':
      feeType = 'WalmartFee';
      feeCategory = 'Walmart Fees';
      break;
    case 'WFS Inventory Fee/Reimbursement':
      feeType = 'WFSFee';
      feeCategory = 'WFS Fees';
      break;
    case 'Product Price':
    case 'Product tax':
    case 'Product tax withheld':
    case 'Net Payable':
    case 'Total Walmart Funded Savings':
      // Not fees — skip these
      return;
    default:
      feeType = amountType.replace(/[^a-zA-Z0-9]/g, '');
      feeCategory = 'Walmart Other';
  }

  // Convert posted date from MM/DD/YYYY to ISO
  let isoDate = now;
  if (postedDate.includes('/')) {
    const parts = postedDate.split('/');
    if (parts.length === 3) {
      isoDate = `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}T00:00:00Z`;
    }
  }

  // Preserve sign: Walmart sends negative for charges to seller, positive for
  // credits/reimbursements. Don't force-negate — credit rows must stay positive
  // (e.g. Adjustment / Fee/Reimbursement with positive amount = a credit).
  const feeAmount = amount;

  // Create financial event
  const feResult = db.prepare(`
    INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES ('WalmartReconEvent', ?, ?, ?, ?, 'walmart', ?, ?, ?)
  `).run(isoDate, orderId, sku, sku, feeAmount, JSON.stringify(entry), now);

  const eventId = feResult.changes > 0 ? Number(feResult.lastInsertRowid) : null;
  if (eventId) {
    db.prepare(`
      INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, orderId, sku, feeType, feeCategory, feeAmount, isoDate);
  }

  // Store commission savings (incentive credits) as reimbursements (they're income, not fees)
  if (commissionSaving > 0 && incentiveProgram) {
    // Track in financial_events for reporting
    db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('WalmartIncentive', ?, ?, ?, ?, 'walmart', ?, ?, ?)
    `).run(isoDate, orderId, sku, sku, commissionSaving, JSON.stringify({ incentiveProgram, commissionSaving }), now);

    // Store as reimbursement (income), NOT as fee_details
    db.prepare(`
      INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'Approved', 'walmart', ?)
    `).run(`WMT-INCENTIVE-${orderId}-${sku}`, isoDate, sku, sku, `Commission Incentive: ${incentiveProgram}`, commissionSaving, now);
  }

  // Mark order as reconciled
  db.prepare("UPDATE orders SET is_estimated = 0 WHERE order_id = ? AND marketplace = 'walmart'").run(orderId);
}

/** Parse a CSV line handling quoted fields with commas */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
