/**
 * GET /api/sync/shipping-templates
 *
 * Returns the seller's Amazon MFN shipping template list.
 * Read-only — no Amazon writes, no schema changes.
 *
 * The templates are account-specific: they live inside the PRODUCT type
 * definition schema as merchant_shipping_group enum values with display names.
 * FlipLedger caches both the enum key and display name so old local key values
 * can be resolved to the exact template name sent in Listings Items payloads.
 *
 * Cache strategy: result stored in settings table under key
 * `amazon_shipping_templates` as a JSON blob with `fetchedAt` embedded.
 * TTL: 24 hours. Pass ?refresh=true to bypass cache.
 *
 * Returns: { templates, marketplaceId, fetchedAt, cached }
 */

import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { getSellerId } from '@/lib/sp-api/listingsItems';
import { fetchShippingTemplates } from '@/lib/sp-api/shippingTemplates';
import type { SPAPICredentials } from '@/lib/sp-api/types';

const CACHE_KEY = 'amazon_shipping_templates';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getDb(readonly = false) {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

function getCredentials(db: InstanceType<typeof Database>): SPAPICredentials | null {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  if (!s.clientId || !s.clientSecret || !s.refreshToken) return null;
  return {
    clientId:      s.clientId,
    clientSecret:  s.clientSecret,
    refreshToken:  s.refreshToken,
    marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
  };
}

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get('refresh') === 'true';

  // 1. Check cache
  if (!forceRefresh) {
    const db = getDb(true);
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CACHE_KEY) as { value: string } | undefined;
      if (row?.value) {
        let cached: any;
        try { cached = JSON.parse(row.value); } catch { /* invalid cache — ignore */ }
        if (cached?.fetchedAt) {
          const age = Date.now() - new Date(cached.fetchedAt).getTime();
          if (age < CACHE_TTL_MS) {
            return NextResponse.json({
              templates: cached.templates,
              marketplaceId: cached.marketplaceId,
              fetchedAt: cached.fetchedAt,
              cached: true,
            });
          }
        }
      }
    } finally {
      db.close();
    }
  }

  // 2. Load credentials
  const db = getDb(true);
  let creds: SPAPICredentials | null;
  try {
    creds = getCredentials(db);
  } finally {
    db.close();
  }

  if (!creds) {
    return NextResponse.json(
      { error: 'Missing SP-API credentials. Go to Settings and enter your Client ID, Client Secret, and Refresh Token.' },
      { status: 400 }
    );
  }

  // 3. Resolve seller ID and fetch templates
  let sellerId: string;
  try {
    sellerId = await getSellerId(creds);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not resolve seller ID: ${err}` },
      { status: 500 }
    );
  }

  let templates: { key: string; name: string }[];
  try {
    templates = await fetchShippingTemplates(creds, sellerId);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch shipping templates: ${err}` },
      { status: 500 }
    );
  }

  const fetchedAt = new Date().toISOString();
  const marketplaceId = creds.marketplaceId;

  // 4. Write to cache
  const payload = JSON.stringify({ templates, marketplaceId, fetchedAt });
  const dbWrite = getDb(false);
  try {
    dbWrite.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
    ).run(CACHE_KEY, payload);
  } finally {
    dbWrite.close();
  }

  return NextResponse.json({ templates, marketplaceId, fetchedAt, cached: false });
}
