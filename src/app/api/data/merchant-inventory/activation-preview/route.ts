import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { loadMfnActivationInventory } from '@/lib/mfnActivationInventory';
import {
  loadAmazonShippingTemplateCache,
  resolveAmazonShippingTemplateName,
  shippingTemplateValidationError,
} from '@/lib/amazonShippingTemplates';

// Update to match the exact shipping template name in Seller Central.
const DEFAULT_MFN_SHIPPING_TEMPLATE = 'DEFAULT MFN USE THIS ONE';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

// POST /api/data/merchant-inventory/activation-preview
//
// Dry-run preview of what would be sent to Amazon for the given SKUs.
// DB-only: no SP-API calls, no Amazon writes, no DB writes.
//
// Push eligibility (can_push) requires ALL of:
//   - sku is non-empty
//   - merchant_listings row exists for the SKU
//   - proposed qty > 0 (ledger remaining; received count not required)
//   - proposed price > 0
//
// Soft warnings (do NOT block push):
//   - Not explicitly received / not inspected in FlipLedger. Receiving and
//     inspection are tracked in Airtable, so these are informational only.
//   - Local Amazon status is stale/inactive. The SP-API PATCH sends qty +
//     price regardless; activation-push mirrors status back to Active on
//     ACCEPTED.
//   - Shipping template is pushed to Amazon as merchant_shipping_group when it
//     resolves to the synced Amazon template list.
//
// Input:  { skus: string[], shippingTemplate?: string }
// Output: { dryRun: true, amazonWriteMade: false, rows: ActivationPreviewRow[], shippingTemplate, timestamp }

interface ActivationPreviewRow {
  sku: string;
  asin: string | null;
  product_name: string | null;
  current_qty: number | null;
  current_price_cents: number | null;
  current_status: string | null;
  proposed_qty: number;
  qty_source: 'remaining' | 'none';
  proposed_price_cents: number | null;
  proposed_shipping_template: string;
  il_id: number | null;
  warnings: string[];
  can_push: boolean;
}

type DbRow = Record<string, unknown>;

export async function POST(request: NextRequest) {
  let body: { skus?: unknown; shippingTemplate?: unknown };
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
  if (skus.length > 200) {
    return NextResponse.json({ error: 'Too many SKUs (max 200 per preview)' }, { status: 400 });
  }

  const explicitShippingTemplate =
    typeof body.shippingTemplate === 'string' && body.shippingTemplate.trim()
      ? body.shippingTemplate.trim()
      : '';
  const shippingTemplate = explicitShippingTemplate || DEFAULT_MFN_SHIPPING_TEMPLATE;

  const db = getDb();
  try {
    const placeholders = skus.map(() => '?').join(',');

    // Current Amazon listing state for each SKU
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

    const mlBySku = new Map<string, DbRow>();
    for (const row of mlRows) mlBySku.set(String(row.sku), row);

    const inventoryBySku = loadMfnActivationInventory(db, skus);
    const templateCache = loadAmazonShippingTemplateCache(db);

    const rows: ActivationPreviewRow[] = skus.map(sku => {
      const ml = mlBySku.get(sku) ?? null;
      const inventory = inventoryBySku.get(sku) ?? null;
      const il = inventory?.referenceLot ?? null;
      const warnings: string[] = [];

      // --- Eligibility checks (ordered by severity) ---

      if (!ml) {
        warnings.push('No Amazon listing found — SKU is not in Seller Central');
      }

      const currentStatus = ml ? String(ml.current_status ?? '') || null : null;
      const statusPushable = currentStatus === 'Active';
      if (ml && !statusPushable) {
        warnings.push('Local Amazon status is stale/inactive — push will attempt quantity/price update because SKU exists.');
      }

      // Price: use locally-set receive price first; fall back to current Amazon price
      const ilPriceCents = il?.il_list_price_cents != null ? Number(il.il_list_price_cents) : null;
      const mlPriceCents = ml?.current_price_cents != null ? Number(ml.current_price_cents) : null;
      const proposedPriceCents = ilPriceCents ?? mlPriceCents;

      if (proposedPriceCents == null || proposedPriceCents <= 0) {
        warnings.push('No list price set — not eligible to push');
      }

      // Qty: ledger remaining drives the push. Receiving/inspection are
      // tracked in Airtable, not gated here (see can_push below).
      const qtyReceived  = il ? (Number(il.quantity_received) || 0) : 0;
      const proposedQty = Math.max(0, inventory?.sellableQuantity ?? 0);

      if (proposedQty <= 0) {
        warnings.push('Quantity is 0 — not eligible to push');
      } else if (qtyReceived === 0) {
        warnings.push('Using ledger remaining quantity (not explicitly received in FlipLedger).');
      }

      // Inspection: informational only — done in Airtable, not gated here.
      const inspectedAt = il?.inspected_at != null ? String(il.inspected_at).trim() : '';
      if (il && !inspectedAt) {
        warnings.push('Not inspected in FlipLedger (inspection tracked in Airtable).');
      }

      // Shipping template: per-push selection takes priority; otherwise use the
      // per-lot value, then the route default. Stored keys are accepted for
      // compatibility, but the Listings payload sends Amazon's template name.
      const lotTemplate = il?.merchant_shipping_group_name != null
        ? String(il.merchant_shipping_group_name).trim()
        : '';
      const requestedTemplate = explicitShippingTemplate || lotTemplate || DEFAULT_MFN_SHIPPING_TEMPLATE;
      const templateError = shippingTemplateValidationError(requestedTemplate, templateCache.templates);
      const proposedShippingTemplate =
        resolveAmazonShippingTemplateName(requestedTemplate, templateCache.templates)
        ?? requestedTemplate;
      if (templateError) {
        warnings.push(templateError);
      } else {
        warnings.push(`Will push Amazon shipping template: ${proposedShippingTemplate}`);
      }

      const qty_source: 'remaining' | 'none' =
        proposedQty > 0 ? 'remaining' : 'none';

      // can_push: real blockers only — a matched Amazon listing, a positive
      // ledger quantity, and a price. Receiving/inspection are NOT gated here;
      // those are tracked in Airtable and would otherwise block every row
      // since FlipLedger's quantity_received/inspected_at stay NULL. Stale
      // local merchant_listings.status is downgraded to a warning — Seller
      // Central may show the SKU as Active while the local row hasn't synced
      // yet. The SP-API PATCH sends qty + price + merchant_shipping_group
      // regardless of local status; activation-push mirrors merchant_listings
      // to Active after an ACCEPTED response.
      const can_push =
        !!sku &&
        !!ml &&
        proposedQty > 0 &&
        proposedPriceCents != null &&
        proposedPriceCents > 0 &&
        !templateError;

      const asin = ml
        ? String(ml.asin ?? '')
        : il ? String(il.asin ?? '') : null;

      return {
        sku,
        asin: asin || null,
        product_name: ml?.product_name != null ? String(ml.product_name) : null,
        current_qty: ml?.current_qty != null ? Number(ml.current_qty) : null,
        current_price_cents: mlPriceCents,
        current_status: currentStatus,
        proposed_qty: proposedQty,
        qty_source,
        proposed_price_cents: proposedPriceCents,
        proposed_shipping_template: proposedShippingTemplate,
        il_id: il ? Number(il.il_id) : null,
        warnings,
        can_push,
      };
    });

    return NextResponse.json({
      dryRun: true,
      amazonWriteMade: false,
      rows,
      shippingTemplate,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[activation-preview] error:', error);
    return NextResponse.json({ error: 'Preview failed' }, { status: 500 });
  } finally {
    db.close();
  }
}
