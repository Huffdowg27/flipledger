import type Database from 'better-sqlite3';

export interface GradedGhostLotMigrationResult {
  beforeLots: number;
  beforeOriginalUnits: number;
  beforeRemainingUnits: number;
  beforeRemainingValueCents: number;
  removedLots: number;
}

/**
 * Remove historical lots created for Amazon Grade-and-Resell SKUs.
 *
 * The original sale already recognized the item's COGS; an `amzn.gr.*` resale
 * intentionally carries $0 COGS and must not own or consume another cost lot.
 */
export function removeAmazonGradedGhostLots(
  db: Database.Database,
): GradedGhostLotMigrationResult {
  return db.transaction(() => {
    const before = db.prepare(`
      SELECT
        COUNT(*) AS lots,
        COALESCE(SUM(quantity), 0) AS originalUnits,
        COALESCE(SUM(quantity_remaining), 0) AS remainingUnits,
        COALESCE(SUM(quantity_remaining * buy_price), 0) AS remainingValueCents
      FROM inventory_ledger
      WHERE sku GLOB 'amzn.gr.*'
    `).get() as {
      lots: number;
      originalUnits: number;
      remainingUnits: number;
      remainingValueCents: number;
    };

    const referenced = db.prepare(`
      SELECT COUNT(*) AS count
      FROM inventory_ledger il
      WHERE il.sku GLOB 'amzn.gr.*'
        AND (
          EXISTS (
            SELECT 1 FROM listing_batch_items lbi
            WHERE lbi.inventory_ledger_id = il.id
          )
          OR EXISTS (
            SELECT 1 FROM incoming_purchases ip
            WHERE ip.inventory_ledger_id = il.id
          )
          OR EXISTS (
            SELECT 1 FROM receiving_issues ri
            WHERE ri.inventory_ledger_id = il.id
          )
        )
    `).get() as { count: number };

    if (referenced.count > 0) {
      throw new Error(
        `refusing to delete ${referenced.count} referenced amzn.gr inventory lot`
        + `${referenced.count === 1 ? '' : 's'}`,
      );
    }

    const removedLots = db.prepare(`
      DELETE FROM inventory_ledger WHERE sku GLOB 'amzn.gr.*'
    `).run().changes;

    return {
      beforeLots: before.lots,
      beforeOriginalUnits: before.originalUnits,
      beforeRemainingUnits: before.remainingUnits,
      beforeRemainingValueCents: before.remainingValueCents,
      removedLots,
    };
  })();
}
