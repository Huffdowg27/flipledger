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
  db.pragma('busy_timeout = 15000');
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
    // Step 1: Get all known SKUs from orders/products/existing inventory/COGS ledger.
    // For inventory_ledger, only include SKUs not yet in live_inventory — this is a
    // one-time discovery pass for MSKUs imported from IL that have never sold. Once
    // in live_inventory (even at 0 qty), the bulk discovery handles updates.
    const knownSkus = new Set(
      db.prepare(`
        SELECT DISTINCT sku FROM order_items WHERE sku IS NOT NULL AND sku != ''
        UNION
        SELECT DISTINCT sku FROM products WHERE sku IS NOT NULL AND sku != '' AND marketplace = 'amazon'
        UNION
        SELECT DISTINCT sku FROM live_inventory WHERE marketplace = 'amazon' AND sku IS NOT NULL AND sku != ''
        UNION
        SELECT DISTINCT il.sku FROM inventory_ledger il
        WHERE il.sku IS NOT NULL AND il.sku != ''
          AND NOT EXISTS (
            SELECT 1 FROM live_inventory li
            WHERE li.sku = il.sku AND li.marketplace = 'amazon'
          )
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

    // SKUs containing commas can't be safely joined into the sellerSkus param —
    // Amazon's parser would split on the comma and count them as multiple SKUs.
    const skus = Array.from(knownSkus).filter(s => !s.includes(','));

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

export interface FBAInventorySummary {
  sellerSku: string;
  fnSku: string | null;
  asin: string;
  fulfillableQty: number;
  inboundQty: number;
  productName: string | null;
}

/**
 * Look up FBA inventory summaries for a single ASIN using the filterASINs
 * query param. More reliable than the Listings Items filterASINs for finding
 * which seller SKUs are associated with an ASIN — includes DISCOVERABLE (OOS)
 * items. Paginates until all results are collected.
 */
export async function getInventorySummariesForASIN(
  credentials: SPAPICredentials,
  asin: string,
): Promise<FBAInventorySummary[]> {
  const results: FBAInventorySummary[] = [];
  let nextToken: string | undefined;

  do {
    const params: Record<string, string> = {
      details: 'true',
      granularityType: 'Marketplace',
      granularityId: credentials.marketplaceId,
      marketplaceIds: credentials.marketplaceId,
      filterASINs: asin,
    };
    if (nextToken) params.nextToken = nextToken;

    const res = await spApiRequest(credentials, '/fba/inventory/v1/summaries', params);
    const summaries: any[] = res?.payload?.inventorySummaries || [];

    for (const item of summaries) {
      if (!item.sellerSku) continue;
      // filterASINs is often ignored by Amazon — filter client-side.
      // Items with no ASIN or a different ASIN are excluded.
      if (item.asin !== asin) continue;
      const d = item.inventoryDetails || {};
      results.push({
        sellerSku: item.sellerSku,
        fnSku: item.fnSku || null,
        asin: item.asin,
        fulfillableQty: d.fulfillableQuantity || 0,
        inboundQty: (d.inboundWorkingQuantity || 0) + (d.inboundShippedQuantity || 0) + (d.inboundReceivingQuantity || 0),
        productName: item.productName || null,
      });
    }

    nextToken = res?.payload?.nextToken;
  } while (nextToken);

  return results;
}
