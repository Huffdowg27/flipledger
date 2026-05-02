import { NextResponse } from 'next/server';
import { spApiRequest } from '@/lib/sp-api/auth';
import Database from 'better-sqlite3';
import path from 'path';

function getCredentials() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  return {
    clientId: settings.clientId || '',
    clientSecret: settings.clientSecret || '',
    refreshToken: settings.refreshToken || '',
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

export async function GET() {
  const credentials = getCredentials();
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');

  try {
    // First check if we already have a storage fee report
    const existingReports = await spApiRequest(credentials, '/reports/2021-06-30/reports', {
      reportTypes: 'GET_FBA_STORAGE_FEE_CHARGES_DATA',
      processingStatuses: 'DONE',
      pageSize: '10',
    });

    let reportDocId: string | null = null;
    const reports = existingReports.reports || [];

    if (reports.length > 0) {
      reportDocId = reports[0].reportDocumentId;
      console.log(`[StorageFees] Found existing report: ${reports[0].reportId}`);
    } else {
      // Request a new report
      console.log('[StorageFees] Requesting new storage fee report...');
      const createResponse = await spApiRequest(credentials, '/reports/2021-06-30/reports', undefined, 3, false);
      // Need POST — spApiRequest only does GET. Use fetch directly.
      const { getAccessToken, getEndpoint } = await import('@/lib/sp-api/auth');
      const token = await getAccessToken(credentials);
      const endpoint = getEndpoint(credentials.marketplaceId);

      const createRes = await fetch(`${endpoint}/reports/2021-06-30/reports`, {
        method: 'POST',
        headers: {
          'x-amz-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reportType: 'GET_FBA_STORAGE_FEE_CHARGES_DATA',
          marketplaceIds: [credentials.marketplaceId],
        }),
      });

      if (!createRes.ok) {
        const err = await createRes.text();
        return NextResponse.json({ error: `Failed to request report: ${err}` });
      }

      const createData = await createRes.json();
      const reportId = createData.reportId;
      console.log(`[StorageFees] Report requested: ${reportId}`);

      // Poll for completion
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10s
        const status = await spApiRequest(credentials, `/reports/2021-06-30/reports/${reportId}`);
        console.log(`[StorageFees] Status: ${status.processingStatus}`);
        if (status.processingStatus === 'DONE') {
          reportDocId = status.reportDocumentId;
          break;
        }
        if (status.processingStatus === 'FATAL' || status.processingStatus === 'CANCELLED') {
          return NextResponse.json({ error: `Report failed: ${status.processingStatus}` });
        }
      }
    }

    if (!reportDocId) {
      return NextResponse.json({ error: 'Report not ready after 5 minutes' });
    }

    // Download the report
    const docResponse = await spApiRequest(credentials, `/reports/2021-06-30/documents/${reportDocId}`);
    const reportResponse = await fetch(docResponse.url);
    const content = await reportResponse.text();

    // Parse the storage fee report
    const lines = content.split('\n');
    const headers = lines[0].split('\t').map((h: string) => h.trim());

    const asinIdx = headers.indexOf('asin');
    const skuIdx = headers.indexOf('fnsku') !== -1 ? headers.indexOf('fnsku') : headers.indexOf('sku');
    const feeIdx = headers.findIndex(h => h.includes('estimated_monthly_storage_fee') || h.includes('monthly-storage-fee') || h.includes('est_base_msf'));
    const categoryIdx = headers.indexOf('product_size_tier') !== -1 ? headers.indexOf('product_size_tier') : headers.indexOf('product-size-tier');

    console.log(`[StorageFees] Headers: ${headers.join(', ')}`);
    console.log(`[StorageFees] Total lines: ${lines.length}`);

    // Store per-ASIN storage fees
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Create storage_fees table if not exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS storage_fees_per_asin (
        asin TEXT PRIMARY KEY,
        monthly_fee INTEGER NOT NULL,
        size_tier TEXT,
        updated_at TEXT NOT NULL
      )
    `);

    let imported = 0;
    const now = new Date().toISOString();
    const volumeIdx = headers.indexOf('item_volume');
    const avgQtyIdx = headers.indexOf('average_quantity_on_hand');
    const monthIdx = headers.indexOf('month_of_charge');

    // First pass: aggregate fees per ASIN across all fulfillment centers
    const asinFees: Record<string, { fee: number; volume: number; avgQty: number; sizeTier: string; month: string }> = {};

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t').map((c: string) => c.trim().replace(/'/g, ''));
      if (cols.length < Math.max(asinIdx, feeIdx) + 1) continue;

      const asin = cols[asinIdx];
      const fee = parseFloat(cols[feeIdx] || '0');
      const volume = volumeIdx >= 0 ? parseFloat(cols[volumeIdx] || '0') : 0;
      const avgQty = avgQtyIdx >= 0 ? parseFloat(cols[avgQtyIdx] || '0') : 0;
      const sizeTier = categoryIdx >= 0 ? cols[categoryIdx] : '';
      const month = monthIdx >= 0 ? cols[monthIdx] : '';

      if (asin) {
        if (!asinFees[asin]) {
          asinFees[asin] = { fee: 0, volume: 0, avgQty: 0, sizeTier, month };
        }
        asinFees[asin].fee += fee;
        asinFees[asin].volume = Math.max(asinFees[asin].volume, volume); // volume per unit is constant
        asinFees[asin].avgQty += avgQty; // sum qty across FCs
      }
    }

    // Second pass: insert aggregated data
    for (const [asin, data] of Object.entries(asinFees)) {
      if (data.fee > 0 || data.avgQty > 0) {
        const feeCents = Math.round(data.fee * 100);
        db.prepare(`
          INSERT INTO storage_fees_per_asin (asin, monthly_fee, size_tier, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(asin) DO UPDATE SET
            monthly_fee = excluded.monthly_fee,
            size_tier = excluded.size_tier,
            updated_at = excluded.updated_at
        `).run(asin, feeCents, data.sizeTier, now);
        imported++;
      }
    }

    db.close();

    return NextResponse.json({
      success: true,
      reportLines: lines.length,
      headers,
      imported,
      sampleLines: lines.slice(0, 5),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) });
  }
}
