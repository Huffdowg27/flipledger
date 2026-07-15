/**
 * POST /api/data/merchant-inventory/backfill-images
 *
 * Fetches product images from Amazon's Catalog API for merchant listings that
 * have no image yet, storing them on the `products` row (keyed by ASIN). Runs
 * in caller-set chunks; the client loops until `remaining` hits 0.
 *
 * Body (optional): { limit?: number }  — ASINs to process this call (default 100).
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { backfillMerchantListingImages } from '@/lib/sp-api/catalog';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getAmazonCredentials(): SPAPICredentials | null {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;
    if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;
    return {
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      refreshToken: settings.refreshToken,
      marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
    };
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const creds = getAmazonCredentials();
  if (!creds) return NextResponse.json({ error: 'SP-API credentials not configured' }, { status: 400 });

  let limit = 100;
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.limit) limit = Math.max(1, Math.min(200, parseInt(String(body.limit), 10) || 100));
  } catch { /* no body — use default */ }

  try {
    const result = await backfillMerchantListingImages(creds, limit);
    return NextResponse.json(result);
  } catch (err) {
    console.error('Backfill images error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
