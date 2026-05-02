/**
 * SP-API FBA Reimbursements Report sync.
 *
 * Pulls `GET_FBA_REIMBURSEMENTS_DATA` — the canonical source of every
 * reimbursement Amazon has paid out. Our existing reimbursements table
 * gets populated from Financial Events AdjustmentEvents, but those only
 * capture a subset (mostly customer-return reimbursements that flow
 * through the financial pipeline). FBA inventory reimbursements
 * (warehouse-lost, etc.) are paid through a different mechanism and
 * only appear in the Reimbursements Report.
 *
 * Storing them here:
 *   - Lets `reimbursementCandidates.ts` match candidates against actual
 *     payouts (so we don't show "pending" for stuff Amazon already paid)
 *   - Gives the user a single complete history
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

function unquote(s: string): string {
  if (!s) return '';
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

function toCents(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[$,]/g, '');
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

interface ReimbursementRow {
  approvalDate: string;        // ISO
  reimbursementId: string;
  caseId: string | null;
  amountPerUnitCents: number;
  amountTotalCents: number;
  quantityReimbursedCash: number;
  quantityReimbursedInventory: number;
  quantityReimbursedTotal: number;
  originalReimbursementId: string | null;
  originalReimbursementType: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  productName: string | null;
  condition: string | null;
  currencyUnit: string | null;
  reason: string | null;
}

export async function createReimbursementsReport(
  credentials: SPAPICredentials,
  startDate: string,
  endDate: string
): Promise<{ reportId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const body = {
    reportType: 'GET_FBA_REIMBURSEMENTS_DATA',
    marketplaceIds: [credentials.marketplaceId],
    dataStartTime: startDate,
    dataEndTime: endDate,
  };

  const r = await fetch(`${endpoint}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`createReport ${r.status}: ${await r.text()}`);
  const d = await r.json();
  if (!d?.reportId) throw new Error('createReport: missing reportId');
  return { reportId: d.reportId };
}

export async function waitForReimbursementsReport(
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

export function parseReimbursementsReport(tsv: string): ReimbursementRow[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split('\t').map(unquote);
  const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const iApproval = idx('approval-date');
  const iReimb = idx('reimbursement-id');
  const iCase = idx('case-id');
  const iAmtPerUnit = idx('amount-per-unit');
  const iAmtTotal = idx('amount-total');
  const iQtyCash = idx('quantity-reimbursed-cash');
  const iQtyInv = idx('quantity-reimbursed-inventory');
  const iQtyTotal = idx('quantity-reimbursed-total');
  const iOrigId = idx('original-reimbursement-id');
  const iOrigType = idx('original-reimbursement-type');
  const iAsin = idx('asin');
  const iFnsku = idx('fnsku');
  const iSku = idx('sku');
  const iName = idx('product-name');
  const iCondition = idx('condition');
  const iCurrency = idx('currency-unit');
  const iReason = idx('reason');

  const rows: ReimbursementRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t').map(unquote);
    const reimbId = iReimb >= 0 ? cols[iReimb] : '';
    if (!reimbId) continue;

    rows.push({
      approvalDate: iApproval >= 0 ? cols[iApproval] || '' : '',
      reimbursementId: reimbId,
      caseId: iCase >= 0 ? cols[iCase] || null : null,
      amountPerUnitCents: iAmtPerUnit >= 0 ? toCents(cols[iAmtPerUnit]) : 0,
      amountTotalCents: iAmtTotal >= 0 ? toCents(cols[iAmtTotal]) : 0,
      quantityReimbursedCash: iQtyCash >= 0 ? parseInt(cols[iQtyCash] || '0', 10) || 0 : 0,
      quantityReimbursedInventory: iQtyInv >= 0 ? parseInt(cols[iQtyInv] || '0', 10) || 0 : 0,
      quantityReimbursedTotal: iQtyTotal >= 0 ? parseInt(cols[iQtyTotal] || '0', 10) || 0 : 0,
      originalReimbursementId: iOrigId >= 0 ? cols[iOrigId] || null : null,
      originalReimbursementType: iOrigType >= 0 ? cols[iOrigType] || null : null,
      asin: iAsin >= 0 ? cols[iAsin] || null : null,
      fnsku: iFnsku >= 0 ? cols[iFnsku] || null : null,
      sku: iSku >= 0 ? cols[iSku] || null : null,
      productName: iName >= 0 ? cols[iName] || null : null,
      condition: iCondition >= 0 ? cols[iCondition] || null : null,
      currencyUnit: iCurrency >= 0 ? cols[iCurrency] || null : null,
      reason: iReason >= 0 ? cols[iReason] || null : null,
    });
  }
  return rows;
}

export async function syncReimbursementsReport(
  credentials: SPAPICredentials,
  startDate: string,
  endDate: string
): Promise<{ reportRows: number; inserted: number; updated: number; totalAmountCents: number }> {
  const { reportId } = await createReimbursementsReport(credentials, startDate, endDate);
  const { reportDocumentId } = await waitForReimbursementsReport(credentials, reportId);
  const tsv = await downloadReport(credentials, reportDocumentId);
  const rows = parseReimbursementsReport(tsv);

  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO reimbursements (
      reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Approved', 'amazon', datetime('now'))
    ON CONFLICT(reimbursement_id) DO UPDATE SET
      reimbursement_date = excluded.reimbursement_date,
      asin = excluded.asin,
      sku = excluded.sku,
      reason = excluded.reason,
      amount = excluded.amount,
      quantity = excluded.quantity
  `);

  // After upserting a canonical numeric row, sweep any prior ADJ-* or
  // SETTLEMENT-* placeholders for the same (date, amount, sku-or-asin).
  // Repoints any reimbursement_candidates FK pointers before deleting.
  const repointCandidates = db.prepare(`
    UPDATE reimbursement_candidates
    SET matched_reimbursement_id = (SELECT id FROM reimbursements WHERE reimbursement_id = ?)
    WHERE matched_reimbursement_id IN (
      SELECT id FROM reimbursements
      WHERE marketplace = 'amazon'
        AND (reimbursement_id LIKE 'ADJ-%' OR reimbursement_id LIKE 'SETTLEMENT-%')
        AND date(reimbursement_date) = date(?)
        AND amount = ?
        AND (
          (? IS NOT NULL AND sku = ?)
          OR (? IS NOT NULL AND asin = ?)
          OR (sku IS NULL AND asin IS NULL)
        )
    )
  `);
  const deleteDups = db.prepare(`
    DELETE FROM reimbursements
    WHERE marketplace = 'amazon'
      AND (reimbursement_id LIKE 'ADJ-%' OR reimbursement_id LIKE 'SETTLEMENT-%')
      AND date(reimbursement_date) = date(?)
      AND amount = ?
      AND (
        (? IS NOT NULL AND sku = ?)
        OR (? IS NOT NULL AND asin = ?)
        OR (sku IS NULL AND asin IS NULL)
      )
  `);

  let inserted = 0, updated = 0, totalAmount = 0, dupsRemoved = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      // Use approvalDate if present, fall back to today
      const date = r.approvalDate || new Date().toISOString().slice(0, 10);
      const result = upsert.run(
        r.reimbursementId,
        date,
        r.asin,
        r.sku,
        r.reason || r.originalReimbursementType || 'REIMBURSEMENT',
        r.amountTotalCents,
        r.quantityReimbursedTotal || 1
      );
      if (result.changes === 1) inserted++;
      else if (result.changes === 2) updated++;
      totalAmount += r.amountTotalCents;

      // Sweep any ADJ/SETTLEMENT placeholders this canonical row supersedes
      repointCandidates.run(
        r.reimbursementId,
        date, r.amountTotalCents,
        r.sku, r.sku, r.asin, r.asin
      );
      const sweep = deleteDups.run(
        date, r.amountTotalCents,
        r.sku, r.sku, r.asin, r.asin
      );
      dupsRemoved += sweep.changes;
    }
  });
  tx();
  if (dupsRemoved > 0) {
    console.log(`[reimbursementsReport] swept ${dupsRemoved} ADJ/SETTLEMENT placeholders superseded by canonical rows`);
  }

  db.close();
  return { reportRows: rows.length, inserted, updated, totalAmountCents: totalAmount };
}
