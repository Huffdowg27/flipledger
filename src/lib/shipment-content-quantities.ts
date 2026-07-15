import type Database from 'better-sqlite3';

export interface ShipmentItemQuantity {
  msku: string;
  quantity: number;
}

export interface ShipmentQuantityPlanItem {
  itemId: number;
  msku: string;
  expectedBatchQuantity: number;
  nextBatchQuantity: number;
}

function quantityMap(
  items: ShipmentItemQuantity[],
  label: string,
): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const item of items) {
    const msku = item.msku?.trim();
    if (!msku) throw new Error(`${label} contains an empty MSKU`);
    if (!Number.isInteger(item.quantity) || item.quantity < 0) {
      throw new Error(`${label} quantity for ${msku} must be a non-negative integer`);
    }
    if (quantities.has(msku)) {
      throw new Error(`${label} contains duplicate MSKU ${msku}`);
    }
    quantities.set(msku, item.quantity);
  }
  return quantities;
}

export function planShipmentQuantityUpdate(
  db: Database.Database,
  batchId: number,
  beforeShipment: ShipmentItemQuantity[],
  afterShipment: ShipmentItemQuantity[],
): ShipmentQuantityPlanItem[] {
  const before = quantityMap(beforeShipment, 'Current shipment contents');
  const after = quantityMap(afterShipment, 'Post-update shipment contents');

  for (const msku of before.keys()) {
    if (!after.has(msku)) {
      throw new Error(`Post-update shipment contents are incomplete: missing ${msku}`);
    }
  }
  for (const msku of after.keys()) {
    if (!before.has(msku)) {
      throw new Error(`Post-update shipment contents include unexpected SKU ${msku}`);
    }
  }

  const findItem = db.prepare(`
    SELECT id, quantity
    FROM listing_batch_items
    WHERE batch_id = ? AND sku = ?
  `);
  const plan: ShipmentQuantityPlanItem[] = [];

  for (const [msku, previousShipmentQuantity] of before) {
    const nextShipmentQuantity = after.get(msku)!;
    const delta = nextShipmentQuantity - previousShipmentQuantity;
    if (delta === 0) continue;

    const rows = findItem.all(batchId, msku) as Array<{ id: number; quantity: number }>;
    if (rows.length === 0) {
      throw new Error(`No local batch item exists for shipment SKU ${msku}`);
    }
    if (rows.length > 1) {
      throw new Error(`Multiple local batch items make shipment SKU ${msku} ambiguous`);
    }

    const row = rows[0];
    const nextBatchQuantity = row.quantity + delta;
    if (nextBatchQuantity < 0) {
      throw new Error(`Shipment update would make the local batch quantity for ${msku} negative`);
    }
    plan.push({
      itemId: row.id,
      msku,
      expectedBatchQuantity: row.quantity,
      nextBatchQuantity,
    });
  }

  return plan;
}

export function applyShipmentQuantityPlan(
  db: Database.Database,
  plan: ShipmentQuantityPlanItem[],
  updatedAt: string,
): number {
  const updateItem = db.prepare(`
    UPDATE listing_batch_items
    SET quantity = ?, listing_updated_at = ?
    WHERE id = ? AND quantity = ?
  `);

  return db.transaction(() => {
    let updated = 0;
    for (const item of plan) {
      const result = updateItem.run(
        item.nextBatchQuantity,
        updatedAt,
        item.itemId,
        item.expectedBatchQuantity,
      );
      if (result.changes !== 1) {
        throw new Error(`Local batch quantity for ${item.msku} changed; shipment reconciliation is stale`);
      }
      updated += result.changes;
    }
    return updated;
  }).immediate();
}
