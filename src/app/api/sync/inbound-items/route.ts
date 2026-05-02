import { NextResponse } from 'next/server';
import { spApiRequest } from '@/lib/sp-api/auth';
import Database from 'better-sqlite3';
import path from 'path';

function getCredentials() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  return {
    clientId: settings.clientId || '',
    clientSecret: settings.clientSecret || '',
    refreshToken: settings.refreshToken || '',
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

export async function GET() {
  const credentials = getCredentials();
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  try {
    // Get all shipment IDs and their inbound transport costs
    const shipments = db.prepare(`
      SELECT
        json_extract(raw_data, '$.AmazonOrderId') as shipment_id,
        ABS(json_extract(raw_data, '$.FeeList[0].FeeAmount.CurrencyAmount')) as cost
      FROM financial_events
      WHERE event_type = 'ServiceFeeEvent'
      AND raw_data LIKE '%InboundTransportation%'
      AND json_extract(raw_data, '$.AmazonOrderId') LIKE 'FBA%'
      GROUP BY json_extract(raw_data, '$.AmazonOrderId')
    `).all() as { shipment_id: string; cost: number }[];

    console.log(`[InboundItems] Found ${shipments.length} shipments to look up`);

    // Create table for per-SKU inbound costs
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_cost_per_sku (
        sku TEXT NOT NULL,
        asin TEXT,
        shipment_id TEXT NOT NULL,
        inbound_cost_per_unit INTEGER NOT NULL,
        units INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (sku, shipment_id)
      )
    `);

    let shipmentsProcessed = 0;
    let skusUpdated = 0;
    const errors: string[] = [];

    for (const shipment of shipments) {
      try {
        // Look up shipment items via FBA Inbound API
        const response = await spApiRequest(
          credentials,
          `/fba/inbound/v0/shipments/${shipment.shipment_id}/items`
        );

        const items = response.payload?.ItemData || [];
        if (items.length === 0) continue;

        // Calculate total units in shipment
        const totalUnits = items.reduce((sum: number, item: any) => sum + (item.QuantityShipped || 0), 0);
        if (totalUnits === 0) continue;

        // Allocate inbound cost per unit
        const costPerUnit = Math.round((shipment.cost * 100) / totalUnits); // cents

        const now = new Date().toISOString();
        for (const item of items) {
          const sku = item.SellerSKU;
          const asin = item.ASIN || item.FulfillmentNetworkSKU;
          const qty = item.QuantityShipped || 0;
          if (!sku || qty === 0) continue;

          db.prepare(`
            INSERT INTO inbound_cost_per_sku (sku, asin, shipment_id, inbound_cost_per_unit, units, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(sku, shipment_id) DO UPDATE SET
              inbound_cost_per_unit = excluded.inbound_cost_per_unit,
              units = excluded.units,
              updated_at = excluded.updated_at
          `).run(sku, asin, shipment.shipment_id, costPerUnit, qty, now);
          skusUpdated++;
        }

        shipmentsProcessed++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        errors.push(`Shipment ${shipment.shipment_id}: ${err}`);
      }
    }

    db.close();

    return NextResponse.json({
      shipmentsProcessed,
      skusUpdated,
      totalShipments: shipments.length,
      errors,
    });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) });
  }
}
