import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { getSellerId } from '@/lib/sp-api/listingsItems';
import { patchMfnListing } from '@/lib/sp-api/mfnActivation';
import type { SPAPICredentials } from '@/lib/sp-api/types';

const DEFAULT_MFN_SHIPPING_TEMPLATE = 'DEFAULT MFN USE THIS ONE';

function getDb(readonly = false) {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly });
  db.pragma('journal_mode = WAL');
  return db;
}

function getCredentials(): SPAPICredentials {
  const db = getDb(true);
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const s: Record<string, string> = {};
    for (const r of rows) s[r.key] = r.value;
    return {
      clientId:      s.clientId      || '',
      clientSecret:  s.clientSecret  || '',
      refreshToken:  s.refreshToken  || '',
      marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
    };
  } finally {
    db.close();
  }
}

type DbRow = Record<string, unknown>;

// Output shape for one SKU
export interface PushResult {
  sku: string;
  asin: string | null;
  product_name: string | null;
  proposed_qty: number;
  proposed_price_cents: number | null;
  proposed_shipping_template: string;
  il_id: number | null;
  eligible: boolean;
  skipped_reason: string | null;
  sp_status: 'ACCEPTED' | 'INVALID' | 'VALID' | 'ERROR' | 'SKIPPED' | 'DRY_RUN';
  sp_submission_id: string | null;
  sp_issues: Array<{ code: string; message: string; severity: string }>;
  error_message: string | null;
  log_id: number | null;
}

// POST /api/data/merchant-inventory/activation-push
//
// Pushes qty, price, and shipping template for eligible MFN SKUs to Amazon.
// Eligibility mirrors activation-preview: Active status + received + inspected
// + price > 0 + shipping template set.
//
// dryRun=true  → eligibility check only; no SP-API calls; no DB writes.
// dryRun=false → calls PATCH on each eligible SKU; logs every attempt.
//
// Input:  { skus: string[], dryRun?: boolean }
// Output: { dryRun, amazonWriteMade, results: PushResult[], timestamp }
export async function POST(request: NextRequest) {
  let body: { skus?: unknown; dryRun?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const skus = Array.isArray(body.skus)
    ? body.skus.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  if (skus.length === 0) {
    return NextResponse.json({ error: 'skus array is required and must not be empty' }, { status: 400 });
  }
  if (skus.length > 50) {
    return NextResponse.json({ error: 'Too many SKUs (max 50 per push)' }, { status: 400 });
  }

  const dryRun = body.dryRun === true;

  // Credentials guard — checked before any DB or API work
  const creds = getCredentials();
  if (!dryRun && (!creds.clientId || !creds.clientSecret || !creds.refreshToken)) {
    return NextResponse.json(
      { error: 'Missing SP-API credentials. Go to Settings and enter your Client ID, Client Secret, and Refresh Token.' },
      { status: 400 }
    );
  }

  const db = getDb(false);
  try {
    const placeholders = skus.map(() => '?').join(',');

    const mlRows = db.prepare(`
      SELECT
        ml.sku,
        ml.asin,
        ml.quantity                        AS current_qty,
        ml.list_price_cents                AS current_price_cents,
        ml.status                          AS current_status,
        COALESCE(p.name, ml.item_name)     AS product_name
      FROM merchant_listings ml
      LEFT JOIN products p ON p.asin = ml.asin
      WHERE ml.sku IN (${placeholders}) AND ml.marketplace = 'amazon'
    `).all(...skus) as DbRow[];

    const ilRows = db.prepare(`
      SELECT
        il.sku,
        il.id                              AS il_id,
        il.asin,
        il.list_price_cents                AS il_list_price_cents,
        il.quantity_received,
        il.quantity_remaining,
        il.inspected_at,
        il.merchant_shipping_group_name
      FROM inventory_ledger il
      WHERE il.sku IN (${placeholders}) AND il.quantity_remaining > 0
      ORDER BY il.date_purchased DESC
    `).all(...skus) as DbRow[];

    const mlBySku = new Map<string, DbRow>();
    for (const row of mlRows) mlBySku.set(String(row.sku), row);

    const ilBySku = new Map<string, DbRow>();
    for (const row of ilRows) {
      if (!ilBySku.has(String(row.sku))) ilBySku.set(String(row.sku), row);
    }

    // Determine eligibility — identical gate to activation-preview
    const eligibilityMap = skus.map(sku => {
      const ml = mlBySku.get(sku) ?? null;
      const il = ilBySku.get(sku) ?? null;
      const reasons: string[] = [];

      if (!ml) reasons.push('No Amazon listing found');
      const currentStatus = ml ? String(ml.current_status ?? '') || null : null;
      if (ml && currentStatus !== 'Active') reasons.push(`Listing is ${currentStatus ?? 'unknown'} — must be Active`);

      const ilPriceCents = il?.il_list_price_cents != null ? Number(il.il_list_price_cents) : null;
      const mlPriceCents = ml?.current_price_cents  != null ? Number(ml.current_price_cents)  : null;
      const proposedPriceCents = ilPriceCents ?? mlPriceCents;
      if (proposedPriceCents == null || proposedPriceCents <= 0) reasons.push('No list price set');

      const qtyReceived  = il ? (Number(il.quantity_received)  || 0) : 0;
      const qtyRemaining = il ? (Number(il.quantity_remaining) || 0) : 0;
      if (qtyReceived <= 0) reasons.push('Not explicitly received (quantity_received = 0)');

      const inspectedAt = il?.inspected_at != null ? String(il.inspected_at).trim() : '';
      if (il && !inspectedAt) reasons.push('Item not inspected');

      const lotTemplate = il?.merchant_shipping_group_name != null
        ? String(il.merchant_shipping_group_name).trim()
        : '';
      const proposedShippingTemplate = lotTemplate || DEFAULT_MFN_SHIPPING_TEMPLATE;
      if (!proposedShippingTemplate) reasons.push('Shipping template not configured');

      const proposedQty = qtyReceived > 0 ? qtyReceived : qtyRemaining;
      const asin = ml ? String(ml.asin ?? '') : il ? String(il.asin ?? '') : null;

      return {
        sku,
        asin: asin || null,
        product_name: ml?.product_name != null ? String(ml.product_name) : null,
        proposed_qty: proposedQty,
        proposed_price_cents: proposedPriceCents,
        proposed_shipping_template: proposedShippingTemplate,
        il_id: il ? Number(il.il_id) : null,
        eligible: reasons.length === 0,
        skipped_reason: reasons.length > 0 ? reasons.join('; ') : null,
      };
    });

    // Dry-run: return eligibility without any SP-API or DB writes
    if (dryRun) {
      const results: PushResult[] = eligibilityMap.map(e => ({
        ...e,
        sp_status: 'DRY_RUN',
        sp_submission_id: null,
        sp_issues: [],
        error_message: null,
        log_id: null,
      }));
      return NextResponse.json({
        dryRun: true,
        amazonWriteMade: false,
        results,
        timestamp: new Date().toISOString(),
      });
    }

    // Live push — call SP-API for each eligible SKU then log all attempts
    const sellerId = await getSellerId(creds);
    const results: PushResult[] = [];
    const now = new Date().toISOString();

    for (const item of eligibilityMap) {
      if (!item.eligible) {
        // Log skipped rows so the audit trail is complete
        const logId = db.prepare(`
          INSERT INTO mfn_push_log
            (pushed_at, sku, asin, il_id, proposed_qty, proposed_price_cents,
             proposed_shipping_template, sp_api_status, sp_api_submission_id,
             sp_api_issues, error_message, dry_run)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'SKIPPED', NULL, '[]', ?, 0)
        `).run(
          now, item.sku, item.asin, item.il_id,
          item.proposed_qty, item.proposed_price_cents,
          item.proposed_shipping_template, item.skipped_reason
        ).lastInsertRowid;

        results.push({
          ...item,
          sp_status: 'SKIPPED',
          sp_submission_id: null,
          sp_issues: [],
          error_message: item.skipped_reason,
          log_id: Number(logId),
        });
        continue;
      }

      // Attempt the SP-API PATCH
      let spResult: Awaited<ReturnType<typeof patchMfnListing>> | null = null;
      let errorMessage: string | null = null;

      try {
        spResult = await patchMfnListing(creds, sellerId, {
          sku: item.sku,
          quantity: item.proposed_qty,
          listPriceCents: item.proposed_price_cents!,
          merchantShippingGroupName: item.proposed_shipping_template,
        });
      } catch (err) {
        errorMessage = String(err);
      }

      const spStatus = spResult?.status ?? 'ERROR';
      const spSubmissionId = spResult?.submissionId ?? null;
      const spIssues = spResult?.issues ?? [];

      const logId = db.prepare(`
        INSERT INTO mfn_push_log
          (pushed_at, sku, asin, il_id, proposed_qty, proposed_price_cents,
           proposed_shipping_template, sp_api_status, sp_api_submission_id,
           sp_api_issues, error_message, dry_run)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        now, item.sku, item.asin, item.il_id,
        item.proposed_qty, item.proposed_price_cents,
        item.proposed_shipping_template,
        spStatus, spSubmissionId,
        JSON.stringify(spIssues),
        errorMessage
      ).lastInsertRowid;

      results.push({
        ...item,
        sp_status: spStatus as PushResult['sp_status'],
        sp_submission_id: spSubmissionId,
        sp_issues: spIssues,
        error_message: errorMessage,
        log_id: Number(logId),
      });
    }

    const anyWriteMade = results.some(r => r.sp_status !== 'SKIPPED' && r.sp_status !== 'DRY_RUN');

    return NextResponse.json({
      dryRun: false,
      amazonWriteMade: anyWriteMade,
      results,
      timestamp: now,
    });
  } catch (error) {
    console.error('[activation-push] error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  } finally {
    db.close();
  }
}
