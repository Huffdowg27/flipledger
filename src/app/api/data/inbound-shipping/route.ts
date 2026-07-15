import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { isIsoCalendarDate, parseMarketplaceFilter } from '@/lib/request-filters';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const rawStartDate = searchParams.get('startDate');
  const rawEndDate = searchParams.get('endDate');
  if (
    (rawStartDate !== null && !isIsoCalendarDate(rawStartDate))
    || (rawEndDate !== null && !isIsoCalendarDate(rawEndDate))
    || (rawStartDate !== null && rawEndDate !== null && rawStartDate > rawEndDate)
  ) return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  let startDate: string;
  if (rawStartDate) startDate = rawStartDate;
  else {
    const rawDays = searchParams.get('days') || '30';
    if (!/^\d+$/.test(rawDays) || Number(rawDays) < 1 || Number(rawDays) > 3650) {
      return NextResponse.json({ error: 'Invalid days' }, { status: 400 });
    }
    const days = Number(rawDays);
    startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  }
  const endDate = rawEndDate || new Date().toISOString().split('T')[0];
  const endDateNext = new Date(new Date(endDate).getTime() + 86400000).toISOString().split('T')[0];

  const marketplaceResult = parseMarketplaceFilter(searchParams.get('marketplace'));
  if (!marketplaceResult.ok) {
    return NextResponse.json({ error: 'Invalid marketplace' }, { status: 400 });
  }
  const marketplace = marketplaceResult.marketplace;
  const marketplaceClause = marketplace ? 'AND marketplace = ?' : '';
  const shipmentParams = marketplace ? [startDate, endDateNext, marketplace] : [startDate, endDateNext];

  const db = getDb();
  try {
    const shipments = db.prepare(`
      SELECT
        shipment_id as shipmentId,
        date_shipped as dateShipped,
        carrier,
        tracking,
        boxes,
        weight,
        cost,
        total_units as totalUnits,
        status,
        marketplace
      FROM inbound_shipments
      WHERE date_shipped >= ? AND date_shipped < ? ${marketplaceClause}
      ORDER BY date_shipped DESC
    `).all(...shipmentParams) as any[];

    const getItems = db.prepare(`
      SELECT isi.asin, isi.sku, isi.quantity, COALESCE(p.name, isi.asin) as productName
      FROM inbound_shipment_items isi
      LEFT JOIN products p ON isi.asin = p.asin
      WHERE isi.shipment_id = ?
    `);

    const items = shipments.map((shipment) => ({
      ...shipment,
      items: getItems.all(shipment.shipmentId) as any[],
    }));

    const totalShipments = items.length;
    const totalUnits = items.reduce((s, i) => s + i.totalUnits, 0);

    // Get inbound shipping costs from fee_details (FBA transport + convenience fees)
    const costData = db.prepare(`
      SELECT COALESCE(SUM(ABS(amount)), 0) as total
      FROM fee_details
      WHERE fee_type IN ('FBAInboundTransportationFee', 'FBAInboundConvenienceFee', 'FBAInboundTransportationProgramFee')
        AND date(posted_date) >= ? AND date(posted_date) < ?
    `).get(startDate, endDateNext) as any;

    const totalCost = costData?.total || 0;

    db.close();

    return NextResponse.json({
      items,
      totals: { totalShipments, totalCost, totalUnits },
    });
  } catch (error) {
    db.close();
    console.error('Inbound Shipping API error:', error);
    return NextResponse.json({ error: 'Failed to load inbound shipping data' }, { status: 500 });
  }
}
