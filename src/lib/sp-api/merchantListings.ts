/**
 * SP-API MFN listings sync.
 *
 * Pulls GET_FLAT_FILE_OPEN_LISTINGS_DATA — a snapshot of every open listing
 * in the seller's account. Upserts into merchant_listings, which is the
 * source of truth for live Seller Central listing status and quantity.
 *
 * Read-only from Amazon's perspective: no listing updates, no quantity writes.
 *
 * Pattern mirrors reimbursementsReport.ts: create report → poll → download
 * → parse TSV → upsert.
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

function toCents(s: string): number | null {
  if (!s || !s.trim()) return null;
  const cleaned = s.replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export interface MerchantListingRow {
  sku: string;
  asin: string;
  productName: string | null;
  condition: string | null;
  listPriceCents: number | null;
  quantity: number;
  status: string | null;
}

export async function createMerchantListingsReport(
  credentials: SPAPICredentials
): Promise<{ reportId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  // GET_FLAT_FILE_OPEN_LISTINGS_DATA is a current-state snapshot report:
  // no dataStartTime/dataEndTime needed or supported.
  const body = {
    reportType: 'GET_FLAT_FILE_OPEN_LISTINGS_DATA',
    marketplaceIds: [credentials.marketplaceId],
  };

  const r = await fetch(`${endpoint}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`createMerchantListingsReport ${r.status}: ${await r.text()}`);
  const d = await r.json();
  if (!d?.reportId) throw new Error('createMerchantListingsReport: missing reportId');
  return { reportId: d.reportId };
}

export async function waitForMerchantListingsReport(
  credentials: SPAPICredentials,
  reportId: string,
  maxWaitMs = 300_000
): Promise<{ reportDocumentId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const accessToken = await getAccessToken(credentials);
    const r = await fetch(
      `${endpoint}/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
      { headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' } }
    );
    if (!r.ok) throw new Error(`waitForMerchantListingsReport ${r.status}: ${await r.text()}`);
    const d = await r.json();

    if (d.processingStatus === 'DONE') {
      if (!d.reportDocumentId) throw new Error('Report DONE but no reportDocumentId');
      return { reportDocumentId: d.reportDocumentId };
    }
    if (d.processingStatus === 'CANCELLED' || d.processingStatus === 'FATAL') {
      throw new Error(`Report ${d.processingStatus}: ${JSON.stringify(d)}`);
    }
    await new Promise(res => setTimeout(res, 5000));
  }
  throw new Error(`Merchant listings report ${reportId} did not complete within ${maxWaitMs}ms`);
}

export function parseMerchantListingsReport(tsv: string): MerchantListingRow[] {
  const lines = tsv.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split('\t').map(unquote);
  const idx = (name: string) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

  const iSku       = idx('sku');
  const iAsin      = idx('asin');
  const iName      = idx('product-name');
  const iCondition = idx('condition');
  const iPrice     = idx('list-price');
  const iQty       = idx('quantity');
  const iStatus    = idx('status');

  if (iSku < 0 || iAsin < 0) {
    console.warn('[merchantListings] parseMerchantListingsReport: missing sku or asin column — got headers:', headers.join(', '));
    return [];
  }

  const rows: MerchantListingRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t').map(unquote);
    const sku = cols[iSku] ?? '';
    const asin = cols[iAsin] ?? '';
    if (!sku || !asin) continue;

    rows.push({
      sku,
      asin,
      productName: iName >= 0 ? (cols[iName] || null) : null,
      condition:   iCondition >= 0 ? (cols[iCondition] || null) : null,
      listPriceCents: iPrice >= 0 ? toCents(cols[iPrice] ?? '') : null,
      quantity:    iQty >= 0 ? (parseInt(cols[iQty] ?? '0', 10) || 0) : 0,
      status:      iStatus >= 0 ? (cols[iStatus] || null) : null,
    });
  }
  return rows;
}

export async function syncMerchantListings(
  credentials: SPAPICredentials
): Promise<{ reportId: string; reportRows: number; inserted: number; updated: number }> {
  const { reportId } = await createMerchantListingsReport(credentials);
  console.log(`[merchantListings] Report created: ${reportId}`);

  const { reportDocumentId } = await waitForMerchantListingsReport(credentials, reportId);
  console.log(`[merchantListings] Report ready: doc=${reportDocumentId}`);

  const tsv = await downloadReport(credentials, reportDocumentId);
  const rows = parseMerchantListingsReport(tsv);
  console.log(`[merchantListings] Parsed ${rows.length} listing rows`);

  if (rows.length === 0) {
    console.warn('[merchantListings] Report returned 0 rows — no listings found or wrong report format');
    return { reportId, reportRows: 0, inserted: 0, updated: 0 };
  }

  const db = getDb();
  const now = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO merchant_listings (asin, sku, marketplace, status, quantity, product_name, condition, list_price_cents, last_synced, sync_report_id)
    VALUES (?, ?, 'amazon', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(asin, sku, marketplace) DO UPDATE SET
      status          = excluded.status,
      quantity        = excluded.quantity,
      product_name    = COALESCE(excluded.product_name, merchant_listings.product_name),
      condition       = COALESCE(excluded.condition, merchant_listings.condition),
      list_price_cents = COALESCE(excluded.list_price_cents, merchant_listings.list_price_cents),
      last_synced     = excluded.last_synced,
      sync_report_id  = excluded.sync_report_id
  `);

  let inserted = 0;
  let updated = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      const result = upsert.run(
        r.asin, r.sku,
        r.status, r.quantity,
        r.productName, r.condition, r.listPriceCents,
        now, reportId
      );
      if (result.changes === 1) inserted++;
      else if (result.changes === 2) updated++;
    }
  });
  tx();
  db.close();

  return { reportId, reportRows: rows.length, inserted, updated };
}
