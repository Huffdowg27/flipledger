import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

// Update to match the exact shipping template name in Seller Central.
const DEFAULT_MFN_SHIPPING_TEMPLATE = 'DEFAULT MFN USE THIS ONE';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

// POST /api/data/merchant-inventory/activation-preview
//
// Dry-run preview of what would be sent to Amazon for the given SKUs.
// DB-only: no SP-API calls, no Amazon writes, no DB writes.
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
  qty_source: 'received' | 'remaining' | 'none';
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

  const shippingTemplate =
    typeof body.shippingTemplate === 'string' && body.shippingTemplate.trim()
      ? body.shippingTemplate.trim()
      : DEFAULT_MFN_SHIPPING_TEMPLATE;

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

    // Most recent local lot with remaining quantity per SKU.
    // ORDER BY date_purchased DESC so the first row per SKU is the latest lot.
    const ilRows = db.prepare(`
      SELECT
        il.sku,
        il.id                AS il_id,
        il.asin,
        il.list_price_cents  AS il_list_price_cents,
        il.quantity_received,
        il.quantity_remaining
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

    const rows: ActivationPreviewRow[] = skus.map(sku => {
      const ml = mlBySku.get(sku) ?? null;
      const il = ilBySku.get(sku) ?? null;
      const warnings: string[] = [];

      if (!ml) {
        warnings.push('No Amazon listing found — SKU is not in Seller Central');
      }

      const currentStatus = ml ? String(ml.current_status ?? '') || null : null;
      if (currentStatus === 'Inactive' || currentStatus === 'Incomplete') {
        warnings.push(`Listing is ${currentStatus} on Amazon — may need reactivation separately`);
      }

      // Price: use locally-set receive price first; fall back to current Amazon price
      const ilPriceCents = il?.il_list_price_cents != null ? Number(il.il_list_price_cents) : null;
      const mlPriceCents = ml?.current_price_cents != null ? Number(ml.current_price_cents) : null;
      const proposedPriceCents = ilPriceCents ?? mlPriceCents;

      if (proposedPriceCents == null || proposedPriceCents <= 0) {
        warnings.push('No list price set — price will be blank in upload');
      }

      // Qty: physical received count trumps ledger remaining
      const qtyReceived  = il ? (Number(il.quantity_received) || 0) : 0;
      const qtyRemaining = il ? (Number(il.quantity_remaining) || 0) : 0;
      const proposedQty  = qtyReceived > 0 ? qtyReceived : qtyRemaining;

      if (qtyReceived === 0 && qtyRemaining > 0) {
        warnings.push('Using ledger quantity fallback — item has not been explicitly received. Verify count before pushing.');
      }

      if (proposedQty <= 0) {
        warnings.push('Quantity is 0 — row cannot be pushed');
      }

      if (!shippingTemplate) {
        warnings.push('Shipping template not configured');
      }

      const asin = ml
        ? String(ml.asin ?? '')
        : il ? String(il.asin ?? '') : null;

      const can_push =
        !!ml &&
        proposedQty > 0 &&
        proposedPriceCents != null &&
        proposedPriceCents > 0;

      const qty_source: 'received' | 'remaining' | 'none' =
        qtyReceived > 0 ? 'received' : qtyRemaining > 0 ? 'remaining' : 'none';

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
        proposed_shipping_template: shippingTemplate,
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
