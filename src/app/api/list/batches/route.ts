/**
 * Batches collection API.
 *
 * GET  /api/list/batches        - list all batches, newest first
 * POST /api/list/batches        - create a new batch
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET() {
  const db = getDb();
  try {
    const batches = db.prepare(`
      SELECT
        b.id,
        b.name,
        b.status,
        b.channel,
        b.marketplace,
        b.inbound_plan_id as inboundPlanId,
        b.created_at as createdAt,
        b.updated_at as updatedAt,
        COALESCE(SUM(i.quantity), 0) as totalUnits,
        COUNT(DISTINCT i.id) as skuCount,
        COALESCE(SUM(i.list_price_cents * i.quantity), 0) as expectedRevenue,
        COALESCE(SUM(i.buy_price_cents * i.quantity), 0) as totalCost,
        COALESCE(SUM(i.estimated_fee_cents * i.quantity), 0) as estimatedFees
      FROM listing_batches b
      LEFT JOIN listing_batch_items i ON i.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `).all();

    return NextResponse.json({ batches });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}

/** Read a single listing_* setting value or return a default. */
function readSetting(db: Database.Database, key: string, fallback: string = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    name,
    channel = 'FBA',
    shipFromName,
    shipFromAddressLine1,
    shipFromCity,
    shipFromState,
    shipFromPostalCode,
    shipFromCountryCode,
    shipFromPhone,
    notes,
  } = body;

  if (!name) {
    return NextResponse.json({ error: 'Batch name is required' }, { status: 400 });
  }
  if (channel !== 'FBA' && channel !== 'MFN') {
    return NextResponse.json({ error: 'channel must be FBA or MFN' }, { status: 400 });
  }

  const db = getDb();
  try {
    // Fill in ship-from defaults from settings if the caller didn't supply them.
    const resolvedShipFrom = {
      name: shipFromName || readSetting(db, 'listing_ship_from_name') || null,
      addressLine1: shipFromAddressLine1 || readSetting(db, 'listing_ship_from_address_line1') || null,
      city: shipFromCity || readSetting(db, 'listing_ship_from_city') || null,
      state: shipFromState || readSetting(db, 'listing_ship_from_state') || null,
      postalCode: shipFromPostalCode || readSetting(db, 'listing_ship_from_postal_code') || null,
      countryCode: shipFromCountryCode || readSetting(db, 'listing_ship_from_country_code') || 'US',
      phone: shipFromPhone || readSetting(db, 'listing_ship_from_phone') || null,
    };

    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO listing_batches (
        name, status, channel, marketplace,
        ship_from_name, ship_from_address_line1, ship_from_city, ship_from_state,
        ship_from_postal_code, ship_from_country_code, ship_from_phone, notes,
        created_at, updated_at
      ) VALUES (?, 'draft', ?, 'amazon', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      channel,
      resolvedShipFrom.name,
      resolvedShipFrom.addressLine1,
      resolvedShipFrom.city,
      resolvedShipFrom.state,
      resolvedShipFrom.postalCode,
      resolvedShipFrom.countryCode,
      resolvedShipFrom.phone,
      notes || null,
      now,
      now
    );

    return NextResponse.json({ id: result.lastInsertRowid, success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
