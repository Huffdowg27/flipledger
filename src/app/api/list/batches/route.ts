/**
 * Batches collection API.
 *
 * GET  /api/list/batches        - list all batches, newest first
 * POST /api/list/batches        - create a new batch
 */
import { NextRequest, NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import { openFlipLedgerDb } from '@/lib/sqlite';

function getDb() {
  return openFlipLedgerDb();
}

// A batch wedged in 'sending' means the send request died mid-flight (deploy /
// PM2 restart) or listing verification never finished while nobody had the
// batch page open to poll. The send flow's worst-case legitimate runtime is
// ~25 min (FNSKU wait + prep + inbound-plan retries), so anything older than
// this is dead — not in flight.
const STALE_SENDING_MS = 60 * 60 * 1000;

export async function GET() {
  const db = getDb();
  try {
    // Self-healing sweep: fail stale 'sending' batches so they stop looking
    // in-flight forever. 'failed' is recoverable — Cancel & Edit resets the
    // batch to draft with items and any Amazon-side listings intact.
    const now = new Date().toISOString();
    const staleCutoff = new Date(Date.now() - STALE_SENDING_MS).toISOString();
    db.prepare(`
      UPDATE listing_batches SET
        status = 'failed',
        send_error = 'Send was interrupted or timed out (in sending for over an hour). Use Cancel & Edit to reset to draft and re-send — listings already created on Amazon are preserved.',
        updated_at = ?
      WHERE status = 'sending'
        AND COALESCE(sent_at, updated_at, created_at) < ?
    `).run(now, staleCutoff);

    // Batch totals come from two sources depending on channel:
    //   - FBA batches aggregate listing_batch_items (rows the FBA flow writes there)
    //   - MFN batches aggregate inventory_ledger lots tagged with batch_id by
    //     /api/data/inventory-lots/create-mfn-local-lot
    // No FBA batch will have inventory_ledger.batch_id rows, and no MFN batch
    // will have listing_batch_items rows, so COALESCE picks the populated side
    // without double-counting.
    const batches = db.prepare(`
      SELECT
        b.id,
        b.name,
        b.status,
        b.channel,
        b.marketplace,
        b.inbound_plan_id as inboundPlanId,
        b.closed_at as closedAt,
        b.created_at as createdAt,
        b.updated_at as updatedAt,
        COALESCE(fba.totalUnits, mfn.totalUnits, 0) as totalUnits,
        COALESCE(fba.skuCount, mfn.skuCount, 0) as skuCount,
        COALESCE(fba.expectedRevenue, mfn.expectedRevenue, 0) as expectedRevenue,
        COALESCE(fba.totalCost, mfn.totalCost, 0) as totalCost,
        COALESCE(fba.estimatedFees, 0) as estimatedFees,
        COALESCE(fba.estimatedShip, 0) as estimatedShip
      FROM listing_batches b
      LEFT JOIN (
        SELECT
          batch_id,
          SUM(quantity) as totalUnits,
          COUNT(DISTINCT id) as skuCount,
          SUM(list_price_cents * quantity) as expectedRevenue,
          SUM(buy_price_cents * quantity) as totalCost,
          SUM(estimated_fee_cents * quantity) as estimatedFees,
          SUM(estimated_ship_cents * quantity) as estimatedShip
        FROM listing_batch_items
        GROUP BY batch_id
      ) fba ON fba.batch_id = b.id
      LEFT JOIN (
        SELECT
          batch_id,
          SUM(quantity) as totalUnits,
          COUNT(DISTINCT id) as skuCount,
          SUM(COALESCE(list_price_cents, 0) * quantity) as expectedRevenue,
          SUM(buy_price * quantity) as totalCost
        FROM inventory_ledger
        WHERE batch_id IS NOT NULL
        GROUP BY batch_id
      ) mfn ON mfn.batch_id = b.id
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
