/**
 * SP-API FBA Inventory API client.
 * Pulls current FBA inventory levels into live_inventory table.
 *
 * Note: The bulk /summaries endpoint sometimes returns 0 quantities.
 * We batch by sellerSkus (max 50 per request) to get accurate data.
 */

import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export async function syncFBAInventory(
  credentials: SPAPICredentials
): Promise<{ itemsProcessed: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let itemsProcessed = 0;

  try {
    // Step 1: Get all known SKUs from orders/products/existing inventory
    const knownSkus = new Set(
      db.prepare(`
        SELECT DISTINCT sku FROM order_items WHERE sku IS NOT NULL AND sku != ''
        UNION
        SELECT DISTINCT sku FROM products WHERE sku IS NOT NULL AND sku != '' AND marketplace = 'amazon'
        UNION
        SELECT DISTINCT sku FROM live_inventory WHERE marketplace = 'amazon' AND sku IS NOT NULL AND sku != ''
      `).all().map((r: any) => r.sku).filter(Boolean)
    );

    // Step 2: Discover new SKUs from the bulk inventory endpoint
    // (quantities from bulk are unreliable, but it gives us the full SKU list)
    let nextDiscoverToken: string | undefined;
    do {
      try {
        const params: Record<string, string> = {
          granularityType: 'Marketplace',
          granularityId: credentials.marketplaceId,
          marketplaceIds: credentials.marketplaceId,
        };
        if (nextDiscoverToken) params.nextToken = nextDiscoverToken;
        const discoverRes = await spApiRequest(credentials, '/fba/inventory/v1/summaries', params);
        const discovered = discoverRes?.payload?.inventorySummaries || [];
        for (const item of discovered) {
          if (item.sellerSku) knownSkus.add(item.sellerSku);
        }
        nextDiscoverToken = discoverRes?.payload?.nextToken;
      } catch { break; }
    } while (nextDiscoverToken);

    const skus = Array.from(knownSkus);

    const now = new Date().toISOString();

    // Batch in groups of 50 (API limit for sellerSkus param)
    for (let i = 0; i < skus.length; i += 50) {
      const batch = skus.slice(i, i + 50);

      try {
        const response = await spApiRequest(
          credentials,
          '/fba/inventory/v1/summaries',
          {
            details: 'true',
            granularityType: 'Marketplace',
            granularityId: credentials.marketplaceId,
            marketplaceIds: credentials.marketplaceId,
            sellerSkus: batch.join(','),
          }
        );

        const summaries = response?.payload?.inventorySummaries || [];

        for (const item of summaries) {
          const asin = item.asin;
          const sku = item.sellerSku;
          const name = item.productName;
          const d = item.inventoryDetails || {};
          const fulfillable = d.fulfillableQuantity || 0;
          const inboundWorking = d.inboundWorkingQuantity || 0;
          const inboundShipped = d.inboundShippedQuantity || 0;
          const inboundReceiving = d.inboundReceivingQuantity || 0;
          const inbound = inboundWorking + inboundShipped + inboundReceiving;
          const reservedTotal = d.reservedQuantity?.totalReservedQuantity || 0;
          const reservedCustomer = d.reservedQuantity?.pendingCustomerOrderQuantity || 0;
          const reservedTransfer = d.reservedQuantity?.pendingTransshipmentQuantity || 0;
          const reservedProcessing = d.reservedQuantity?.fcProcessingQuantity || 0;
          const unfulfillable = d.unfulfillableQuantity?.totalUnfulfillableQuantity || 0;

          db.prepare(`
            INSERT INTO live_inventory (asin, sku, marketplace, fulfillable_qty, inbound_qty, reserved_qty, unfulfillable_qty,
              inbound_working, inbound_shipped, inbound_receiving,
              reserved_customer_order, reserved_fc_transfer, reserved_fc_processing,
              product_name, last_updated)
            VALUES (?, ?, 'amazon', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(asin, sku, marketplace) DO UPDATE SET
              fulfillable_qty = excluded.fulfillable_qty,
              inbound_qty = excluded.inbound_qty,
              reserved_qty = excluded.reserved_qty,
              unfulfillable_qty = excluded.unfulfillable_qty,
              inbound_working = excluded.inbound_working,
              inbound_shipped = excluded.inbound_shipped,
              inbound_receiving = excluded.inbound_receiving,
              reserved_customer_order = excluded.reserved_customer_order,
              reserved_fc_transfer = excluded.reserved_fc_transfer,
              reserved_fc_processing = excluded.reserved_fc_processing,
              product_name = COALESCE(excluded.product_name, live_inventory.product_name),
              last_updated = excluded.last_updated
          `).run(asin, sku, fulfillable, inbound, reservedTotal, unfulfillable,
            inboundWorking, inboundShipped, inboundReceiving,
            reservedCustomer, reservedTransfer, reservedProcessing, name, now);

          // Update product info
          if (name) {
            db.prepare(`
              INSERT INTO products (asin, sku, name, marketplace, created_at, updated_at)
              VALUES (?, ?, ?, 'amazon', ?, ?)
              ON CONFLICT DO UPDATE SET
                name = COALESCE(excluded.name, products.name),
                updated_at = excluded.updated_at
            `).run(asin, sku, name, now, now);
          }

          itemsProcessed++;
        }
      } catch (err: any) {
        errors.push(`Inventory batch ${i}-${i + 50}: ${err.message}`);
      }
    }
  } finally {
    db.close();
  }

  return { itemsProcessed, errors };
}
