import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

export const dynamic = 'force-dynamic';

const DB_PATH = path.join(process.cwd(), 'data', 'flipledger.db');
const EXTENSION_KEY_SETTING = 'extensionApiKey';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-FlipLedger-Extension-Key, Authorization',
};

type LookupInput = {
  orderId: string;
  sku?: string | null;
};

type OrderItemRow = {
  orderId: string;
  marketplace: string | null;
  status: string | null;
  fulfillmentChannel: string | null;
  purchaseDate: string | null;
  itemId: number;
  asin: string | null;
  sku: string | null;
  quantity: number;
  productName: string | null;
  imageUrl: string | null;
};

type BinRow = {
  id: number;
  bin_location: string | null;
  sku: string | null;
  asin: string | null;
};

type ContextItem = {
  orderId: string;
  sku: string | null;
  asin: string | null;
  quantity: number;
  productName: string | null;
  imageUrl: string | null;
  savedBin: string | null;
  displayBin: string | null;
  binSource: 'sku' | 'asin' | null;
  inventoryLotId: number | null;
};

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return NextResponse.json(data, {
    ...init,
    headers,
  });
}

function getDb(readonly = true) {
  const db = new Database(DB_PATH, { readonly });
  db.pragma('journal_mode = WAL');
  return db;
}

function normalizeKey(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, '').trim().toUpperCase();
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getSubmittedKey(request: NextRequest): string {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  return request.headers.get('x-flipledger-extension-key')?.trim() || bearer.trim();
}

function getConfiguredKey(db: Database.Database): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(EXTENSION_KEY_SETTING) as { value?: string } | undefined;
  return row?.value?.trim() ?? '';
}

function requireExtensionKey(request: NextRequest, db: Database.Database) {
  const configuredKey = getConfiguredKey(db);
  if (!configuredKey) {
    return json(
      { error: 'Flip Ledger extension key is not configured. Add one in Settings.' },
      { status: 401 }
    );
  }

  const submittedKey = getSubmittedKey(request);
  if (!submittedKey || submittedKey !== configuredKey) {
    return json({ error: 'Invalid Flip Ledger extension key.' }, { status: 401 });
  }

  return null;
}

function composeDisplayBin(savedBin: string | null, asin: string | null): string | null {
  const bin = savedBin?.trim();
  if (!bin) return null;
  const cleanAsin = asin?.trim();
  if (!cleanAsin) return bin;
  return bin.toUpperCase().includes(cleanAsin.toUpperCase()) ? bin : `${bin}-${cleanAsin}`;
}

function findBinForItem(db: Database.Database, item: OrderItemRow): {
  savedBin: string | null;
  displayBin: string | null;
  binSource: 'sku' | 'asin' | null;
  inventoryLotId: number | null;
} {
  const sku = item.sku?.trim();
  const asin = item.asin?.trim();

  let row: BinRow | undefined;
  let source: 'sku' | 'asin' | null = null;

  if (sku) {
    row = db.prepare(`
      SELECT id, sku, asin, bin_location
      FROM inventory_ledger
      WHERE sku = ?
        AND bin_location IS NOT NULL
        AND TRIM(bin_location) != ''
      ORDER BY
        CASE WHEN quantity_remaining > 0 THEN 0 ELSE 1 END,
        COALESCE(received_at, date_purchased, created_at) DESC,
        id DESC
      LIMIT 1
    `).get(sku) as BinRow | undefined;
    if (row) source = 'sku';
  }

  if (!row && asin) {
    row = db.prepare(`
      SELECT id, sku, asin, bin_location
      FROM inventory_ledger
      WHERE asin = ?
        AND bin_location IS NOT NULL
        AND TRIM(bin_location) != ''
      ORDER BY
        CASE WHEN quantity_remaining > 0 THEN 0 ELSE 1 END,
        COALESCE(received_at, date_purchased, created_at) DESC,
        id DESC
      LIMIT 1
    `).get(asin) as BinRow | undefined;
    if (row) source = 'asin';
  }

  const savedBin = row?.bin_location?.trim() || null;
  return {
    savedBin,
    displayBin: composeDisplayBin(savedBin, asin ?? null),
    binSource: source,
    inventoryLotId: row?.id ?? null,
  };
}

function toContextItem(db: Database.Database, item: OrderItemRow): ContextItem {
  const bin = findBinForItem(db, item);
  return {
    orderId: item.orderId,
    sku: item.sku,
    asin: item.asin,
    quantity: item.quantity,
    productName: item.productName,
    imageUrl: item.imageUrl,
    ...bin,
  };
}

function lookupOrderItems(db: Database.Database, orderId: string): OrderItemRow[] {
  return db.prepare(`
    SELECT
      o.order_id AS orderId,
      o.marketplace AS marketplace,
      o.status AS status,
      o.fulfillment_channel AS fulfillmentChannel,
      o.purchase_date AS purchaseDate,
      oi.id AS itemId,
      NULLIF(oi.asin, 'PENDING') AS asin,
      NULLIF(oi.sku, 'PENDING') AS sku,
      oi.quantity AS quantity,
      COALESCE(p.name, p2.name, NULLIF(oi.asin, 'PENDING'), NULLIF(oi.sku, 'PENDING')) AS productName,
      COALESCE(p.image_url, p2.image_url) AS imageUrl
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.order_id
    LEFT JOIN products p ON p.asin = NULLIF(oi.asin, 'PENDING')
    LEFT JOIN products p2 ON p2.asin = NULLIF(oi.sku, 'PENDING') AND p.asin IS NULL
    WHERE o.order_id = ?
    ORDER BY oi.total_price DESC, oi.id ASC
  `).all(orderId) as OrderItemRow[];
}

function runLookup(db: Database.Database, input: LookupInput) {
  const orderId = input.orderId.trim();
  const sku = input.sku?.trim() || null;

  if (!orderId) {
    return { orderId, sku, status: 'invalid_request' as const, message: 'orderId is required', items: [] };
  }

  const items = lookupOrderItems(db, orderId);
  if (items.length === 0) {
    return { orderId, sku, status: 'order_not_found' as const, message: 'Order was not found in Flip Ledger.', items: [] };
  }

  const contexts = items.map(item => toContextItem(db, item));
  if (!sku) {
    if (contexts.length === 1) {
      return { orderId, sku, status: 'matched' as const, matchStrategy: 'single_item_order', match: contexts[0], items: contexts };
    }
    return {
      orderId,
      sku,
      status: 'ambiguous' as const,
      message: 'Order has multiple items. Provide a SKU/MSKU to pick the right row.',
      items: contexts,
    };
  }

  const normalizedSku = normalizeKey(sku);
  const exact = contexts.find(item => normalizeKey(item.sku) === normalizedSku);
  if (exact) {
    return { orderId, sku, status: 'matched' as const, matchStrategy: 'order_and_sku', match: exact, items: contexts };
  }

  if (contexts.length === 1) {
    return {
      orderId,
      sku,
      status: 'matched' as const,
      matchStrategy: 'single_item_order_sku_mismatch',
      message: 'SKU did not match exactly, but the order has only one line item.',
      match: contexts[0],
      items: contexts,
    };
  }

  return {
    orderId,
    sku,
    status: 'sku_not_found' as const,
    message: 'Order was found, but the provided SKU did not match any line item.',
    items: contexts,
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest) {
  const db = getDb(true);
  try {
    const authError = requireExtensionKey(request, db);
    if (authError) return authError;

    if (request.nextUrl.searchParams.get('health') === '1') {
      return json({ ok: true, service: 'flipledger-veeqo-context' });
    }

    const orderId = cleanString(request.nextUrl.searchParams.get('orderId'));
    const sku = cleanString(request.nextUrl.searchParams.get('sku')) || null;
    return json(runLookup(db, { orderId, sku }));
  } catch (error) {
    console.error('[extension/veeqo-context] error:', error);
    return json({ error: 'Lookup failed' }, { status: 500 });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const db = getDb(true);
  try {
    const authError = requireExtensionKey(request, db);
    if (authError) return authError;

    let body: { lookups?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const lookups = Array.isArray(body.lookups)
      ? body.lookups
          .map((lookup): LookupInput | null => {
            if (!lookup || typeof lookup !== 'object') return null;
            const raw = lookup as Record<string, unknown>;
            const orderId = cleanString(raw.orderId);
            const sku = cleanString(raw.sku) || null;
            return orderId ? { orderId, sku } : null;
          })
          .filter((lookup): lookup is LookupInput => lookup != null)
      : [];

    if (lookups.length === 0) {
      return json({ error: 'lookups array is required and must not be empty' }, { status: 400 });
    }
    if (lookups.length > 100) {
      return json({ error: 'Too many lookups (max 100)' }, { status: 400 });
    }

    return json({
      results: lookups.map(lookup => runLookup(db, lookup)),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[extension/veeqo-context] error:', error);
    return json({ error: 'Lookup failed' }, { status: 500 });
  } finally {
    db.close();
  }
}
