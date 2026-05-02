/**
 * Walmart Marketplace Inventory API client.
 * Pulls WFS inventory + inbound shipments.
 */

import { walmartApiRequest } from './auth';
import type { WalmartCredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export async function syncWalmartInventory(
  credentials: WalmartCredentials,
): Promise<{ itemsProcessed: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let itemsProcessed = 0;
  const now = new Date().toISOString();

  try {
    // ─── Part 1: WFS on-hand inventory ─────────────────────────────
    let offset = 0;
    do {
      let response: any;
      try {
        response = await walmartApiRequest(credentials, '/fulfillment/inventory', { limit: '50', offset: String(offset) });
      } catch (err: any) {
        errors.push(`WFS inventory error: ${err.message}`);
        break;
      }

      const items = response?.payload?.inventory || [];
      const totalCount = response?.headers?.totalCount || 0;
      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        try {
          const sku = item.sku || '';
          const node = item.shipNodes?.[0] || {};
          const availToSell = node.availToSellQty || 0;
          const onHand = node.onHandQty || 0;
          const reserved = Math.max(0, onHand - availToSell);

          db.prepare(`
            INSERT INTO live_inventory (asin, sku, marketplace, fulfillable_qty, inbound_qty, reserved_qty, unfulfillable_qty, product_name, last_updated)
            VALUES (?, ?, 'walmart', ?, 0, ?, 0, ?, ?)
            ON CONFLICT(asin, sku, marketplace) DO UPDATE SET
              fulfillable_qty = excluded.fulfillable_qty,
              reserved_qty = excluded.reserved_qty,
              product_name = COALESCE(excluded.product_name, live_inventory.product_name),
              last_updated = excluded.last_updated
          `).run(sku, sku, availToSell, reserved, '', now);
          itemsProcessed++;
        } catch (err: any) {
          errors.push(`WFS item ${item.sku}: ${err.message}`);
        }
      }

      offset += items.length;
      if (offset >= totalCount) break;
    } while (true);

    // ─── Part 2: Inbound shipments (in transit to WFS) ─────────────
    // Reset inbound counts before re-syncing
    db.prepare("UPDATE live_inventory SET inbound_qty = 0 WHERE marketplace = 'walmart'").run();

    for (const status of ['AWAITING_DELIVERY', 'RECEIVING', 'IN_TRANSIT']) {
      let shipOffset = 0;
      do {
        let shipResponse: any;
        try {
          shipResponse = await walmartApiRequest(credentials, '/fulfillment/inbound-shipments', { limit: '50', offset: String(shipOffset), status });
        } catch { break; }

        const shipments = shipResponse?.payload || [];
        if (shipments.length === 0) break;

        for (const shipment of shipments) {
          try {
            const itemsRes = await walmartApiRequest(credentials, '/fulfillment/inbound-shipment-items', { shipmentId: shipment.shipmentId, limit: '500' });
            for (const item of (itemsRes?.payload || [])) {
              const sku = item.sku;
              const inboundQty = (item.itemQty || 0) - (item.receivedQty || 0);
              if (inboundQty <= 0 || !sku) continue;

              const existing = db.prepare("SELECT id FROM live_inventory WHERE sku = ? AND marketplace = 'walmart'").get(sku) as any;
              if (existing) {
                db.prepare('UPDATE live_inventory SET inbound_qty = inbound_qty + ?, last_updated = ? WHERE id = ?').run(inboundQty, now, existing.id);
              } else {
                db.prepare("INSERT OR IGNORE INTO live_inventory (asin, sku, marketplace, fulfillable_qty, inbound_qty, reserved_qty, unfulfillable_qty, product_name, last_updated) VALUES (?, ?, 'walmart', 0, ?, 0, 0, ?, ?)").run(sku, sku, inboundQty, item.itemDesc || '', now);
              }
              itemsProcessed++;
            }
          } catch (err: any) {
            errors.push(`Inbound shipment ${shipment.shipmentId}: ${err.message}`);
          }
        }

        shipOffset += shipments.length;
        if (shipments.length < 50) break;
      } while (true);
    }
  } finally {
    db.close();
  }

  return { itemsProcessed, errors };
}
