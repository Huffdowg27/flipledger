import type Database from 'better-sqlite3';

export interface MfnActivationLot {
  sku: string;
  il_id: number;
  asin: string | null;
  il_list_price_cents: number | null;
  quantity_received: number | null;
  quantity_remaining: number;
  inspected_at: string | null;
  merchant_shipping_group_name: string | null;
}

export interface MfnActivationInventory {
  referenceLot: MfnActivationLot;
  sellableQuantity: number;
}

/**
 * Load every open inventory lot for the requested MFN SKUs and aggregate the
 * current sellable quantity. The newest open lot remains the reference for
 * lot-level metadata (price, template, inspection), but never for quantity.
 */
export function loadMfnActivationInventory(
  db: Database.Database,
  skus: string[],
): Map<string, MfnActivationInventory> {
  if (skus.length === 0) return new Map();

  const placeholders = skus.map(() => '?').join(',');
  const lots = db.prepare(`
    SELECT
      il.sku,
      il.id                              AS il_id,
      il.asin,
      il.list_price_cents                AS il_list_price_cents,
      il.quantity_received,
      il.quantity_remaining,
      il.inspected_at,
      il.merchant_shipping_group_name
    FROM inventory_ledger il
    WHERE il.sku IN (${placeholders})
      AND il.quantity_remaining > 0
    ORDER BY il.date_purchased DESC, il.id DESC
  `).all(...skus) as MfnActivationLot[];

  const inventoryBySku = new Map<string, MfnActivationInventory>();
  for (const lot of lots) {
    const sku = String(lot.sku);
    const remaining = Number(lot.quantity_remaining);
    const sellable = Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
    const current = inventoryBySku.get(sku);
    if (current) {
      current.sellableQuantity = Math.max(0, current.sellableQuantity + sellable);
    } else {
      inventoryBySku.set(sku, {
        referenceLot: lot,
        sellableQuantity: sellable,
      });
    }
  }

  return inventoryBySku;
}
