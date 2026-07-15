/**
 * GET /api/extension/asin-context?asin=B0XXXXXXXX
 *
 * Per-ASIN inventory context for the RevSeller → Airtable browser extension:
 * the "do I already own this / should I buy more" card shown while sourcing.
 *
 * Read-only. Auth mirrors /api/extension/veeqo-context: the extension sends
 * X-FlipLedger-Extension-Key (or Bearer) matching settings.extensionApiKey.
 * CORS is open because the key is the gate — same pattern as veeqo-context.
 *
 * Blocks returned (all money integer cents):
 *  - onHand:    MFN local lots remaining (with bins) + FBA live inventory +
 *               active merchant listing qty/price
 *  - incoming:  buy-sheet units ordered but not yet received
 *  - purchases: recent inventory_ledger lots + lifetime units + weighted
 *               average unit cost
 *  - sales:     units sold 30/90 days, average sale price, last sale date
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

export const dynamic = 'force-dynamic';

const EXTENSION_KEY_SETTING = 'extensionApiKey';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-FlipLedger-Extension-Key, Authorization',
};

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return NextResponse.json(data, { ...init, headers });
}

function getDb() {
  // Resolved per-call (not module scope) so the path always tracks the
  // current working directory — required by the fixture-based tests.
  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

function getSubmittedKey(request: NextRequest): string {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  return request.headers.get('x-flipledger-extension-key')?.trim() || bearer.trim();
}

function requireExtensionKey(request: NextRequest, db: Database.Database) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get(EXTENSION_KEY_SETTING) as { value?: string } | undefined;
  const configuredKey = row?.value?.trim() ?? '';
  if (!configuredKey) {
    return json(
      { error: 'FlipLedger extension key is not configured. Add one in Settings.' },
      { status: 401 }
    );
  }
  const submittedKey = getSubmittedKey(request);
  if (!submittedKey || submittedKey !== configuredKey) {
    return json({ error: 'Invalid FlipLedger extension key.' }, { status: 401 });
  }
  return null;
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest) {
  const asin = (request.nextUrl.searchParams.get('asin') ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    return json({ error: 'Provide ?asin= as a 10-character ASIN.' }, { status: 400 });
  }

  const db = getDb();
  try {
    const authError = requireExtensionKey(request, db);
    if (authError) return authError;

    const product = db.prepare(`
      SELECT name, image_url AS imageUrl, upc
      FROM products WHERE asin = ?
      ORDER BY (image_url IS NULL), (name IS NULL) LIMIT 1
    `).get(asin) as { name: string | null; imageUrl: string | null; upc: string | null } | undefined;

    // MFN local lots with stock remaining
    const mfnLots = db.prepare(`
      SELECT sku, bin_location AS bin, quantity_remaining AS remaining, buy_price AS buyPriceCents
      FROM inventory_ledger
      WHERE asin = ? AND quantity_remaining > 0
      ORDER BY date_purchased DESC
    `).all(asin) as { sku: string | null; bin: string | null; remaining: number; buyPriceCents: number }[];
    const mfnUnits = mfnLots.reduce((sum, lot) => sum + lot.remaining, 0);

    // FBA live inventory (summed across SKUs)
    const fba = db.prepare(`
      SELECT
        COALESCE(SUM(fulfillable_qty), 0) AS fulfillable,
        COALESCE(SUM(inbound_qty), 0)     AS inbound,
        COALESCE(SUM(reserved_qty), 0)    AS reserved
      FROM live_inventory WHERE asin = ?
    `).get(asin) as { fulfillable: number; inbound: number; reserved: number };

    // Active merchant (MFN) listings
    const listings = db.prepare(`
      SELECT sku, status, quantity, list_price_cents AS listPriceCents
      FROM merchant_listings
      WHERE asin = ? AND marketplace = 'amazon'
      ORDER BY (status = 'Active') DESC, quantity DESC
      LIMIT 10
    `).all(asin) as { sku: string; status: string | null; quantity: number | null; listPriceCents: number | null }[];

    // Incoming: ordered on the buy sheet, not yet (fully) received
    const incoming = db.prepare(`
      SELECT
        COUNT(*) AS orders,
        COALESCE(SUM(MAX(quantity - quantity_received, 0)), 0) AS units
      FROM incoming_purchases
      WHERE asin = ? AND status IN ('on_order', 'partial')
    `).get(asin) as { orders: number; units: number };

    // Purchase history: recent lots + lifetime weighted average cost
    const recentPurchases = db.prepare(`
      SELECT date_purchased AS date, sku, quantity, quantity_remaining AS remaining,
             buy_price AS unitCostCents
      FROM inventory_ledger
      WHERE asin = ?
      ORDER BY date_purchased DESC, id DESC
      LIMIT 10
    `).all(asin) as { date: string; sku: string | null; quantity: number; remaining: number; unitCostCents: number }[];
    const lifetime = db.prepare(`
      SELECT
        COALESCE(SUM(quantity), 0) AS units,
        COALESCE(SUM(quantity * buy_price), 0) AS spendCents
      FROM inventory_ledger WHERE asin = ?
    `).get(asin) as { units: number; spendCents: number };
    const avgUnitCostCents = lifetime.units > 0 ? Math.round(lifetime.spendCents / lifetime.units) : null;

    // Sales velocity from non-canceled orders
    // Sold price is the TOTAL the customer paid = item price + shipping charged
    // (MFN buyers pay shipping; FBA shipping_charged is 0). shippingCents is
    // returned alongside so the card can show the split if wanted.
    const sales = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN o.purchase_date >= datetime('now', '-30 days') THEN oi.quantity END), 0) AS units30,
        COALESCE(SUM(CASE WHEN o.purchase_date >= datetime('now', '-90 days') THEN oi.quantity END), 0) AS units90,
        MAX(o.purchase_date) AS lastSaleDate,
        COALESCE(SUM(CASE WHEN o.purchase_date >= datetime('now', '-90 days') THEN oi.total_price + COALESCE(oi.shipping_charged, 0) END), 0) AS revenue90Cents,
        COALESCE(SUM(CASE WHEN o.purchase_date >= datetime('now', '-90 days') THEN COALESCE(oi.shipping_charged, 0) END), 0) AS shipping90Cents,
        COALESCE(SUM(CASE WHEN o.purchase_date >= datetime('now', '-90 days') THEN oi.quantity END), 0) AS revUnits90
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      WHERE oi.asin = ? AND o.status NOT IN ('Canceled', 'Cancelled')
    `).get(asin) as { units30: number; units90: number; lastSaleDate: string | null; revenue90Cents: number; shipping90Cents: number; revUnits90: number };
    const avgSalePriceCents = sales.revUnits90 > 0 ? Math.round(sales.revenue90Cents / sales.revUnits90) : null;
    const avgShippingCents = sales.revUnits90 > 0 ? Math.round(sales.shipping90Cents / sales.revUnits90) : null;

    return json({
      asin,
      product: product ?? null,
      onHand: {
        mfnUnits,
        mfnLots: mfnLots.slice(0, 10),
        fbaFulfillable: fba.fulfillable,
        fbaInbound: fba.inbound,
        fbaReserved: fba.reserved,
        listings,
      },
      incoming: { units: incoming.units, orders: incoming.orders },
      purchases: {
        lifetimeUnits: lifetime.units,
        lifetimeSpendCents: lifetime.spendCents,
        avgUnitCostCents,
        recent: recentPurchases,
      },
      sales: {
        units30: sales.units30,
        units90: sales.units90,
        avgSalePriceCents,
        avgShippingCents,
        lastSaleDate: sales.lastSaleDate,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
