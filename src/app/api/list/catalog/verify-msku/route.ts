/**
 * GET /api/list/catalog/verify-msku?asin=B0CJCM4LV4&sku=LV_01FAFLIP_...
 *
 * Verifies that a specific MSKU exists in Seller Central for the given ASIN.
 * Used by the manual MSKU entry path in Find-It / replenishment flow.
 *
 * Returns the listing details (status, fnsku, channel, stock) if found,
 * or 404 if the SKU does not exist in Seller Central.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { getSellerId, getListing } from '@/lib/sp-api/listingsItems';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  if (!s.clientId || !s.clientSecret || !s.refreshToken) return null;
  return {
    clientId: s.clientId,
    clientSecret: s.clientSecret,
    refreshToken: s.refreshToken,
    marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
  };
}

export async function GET(request: NextRequest) {
  const asin = request.nextUrl.searchParams.get('asin')?.trim().toUpperCase();
  const sku = request.nextUrl.searchParams.get('sku')?.trim();

  if (!asin || !/^B[0-9A-Z]{9}$/.test(asin)) {
    return NextResponse.json({ error: 'Invalid or missing ASIN' }, { status: 400 });
  }
  if (!sku) {
    return NextResponse.json({ error: 'Missing sku param' }, { status: 400 });
  }

  const db = getDb();
  try {
    const creds = getAmazonCredentials(db);
    db.close();

    if (!creds) {
      return NextResponse.json({ error: 'Amazon credentials not configured' }, { status: 503 });
    }

    const sellerId = await getSellerId(creds);
    const listing = await getListing(creds, sellerId, sku);

    if (!listing) {
      return NextResponse.json({ error: `SKU "${sku}" not found in Seller Central` }, { status: 404 });
    }

    const summary = listing.summaries?.[0] || listing.summary || {};
    const listingAsin: string = summary.asin || '';

    // If the listing exists but is for a different ASIN, reject it.
    if (listingAsin && listingAsin !== asin) {
      return NextResponse.json({
        error: `SKU "${sku}" exists in Seller Central but is attached to ASIN ${listingAsin}, not ${asin}`,
      }, { status: 409 });
    }

    const statusArr: string[] = summary.status || [];
    const listingStatus = statusArr.includes('ACTIVE') ? 'ACTIVE'
      : statusArr.includes('DISCOVERABLE') ? 'DISCOVERABLE'
      : statusArr.includes('SUPPRESSED') ? 'SUPPRESSED'
      : statusArr.includes('INCOMPLETE') ? 'INCOMPLETE'
      : statusArr.includes('INACTIVE') ? 'INACTIVE'
      : statusArr[0] || 'UNKNOWN';

    const availability = (listing.fulfillmentAvailability || [])[0];
    const channelCode: string = availability?.fulfillmentChannelCode || 'DEFAULT';
    const fulfillmentChannel: 'FBA' | 'MFN' = channelCode === 'AMAZON_NA' || channelCode === 'AMAZON' ? 'FBA' : 'MFN';
    const fbaStock = fulfillmentChannel === 'FBA' ? (availability?.quantity ?? 0) : 0;

    return NextResponse.json({
      sku,
      fnsku: summary.fnSku || null,
      asin: listingAsin || asin,
      listingStatus,
      fulfillmentChannel,
      conditionType: summary.conditionType || 'new_new',
      fbaStock,
      listPriceCents: 0,
      itemName: summary.itemName || null,
      source: 'AMAZON_INVENTORY' as const,
      lastSynced: new Date().toISOString(),
    });
  } catch (err) {
    try { db.close(); } catch {}
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
