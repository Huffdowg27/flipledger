/**
 * FIFO (First In, First Out) COGS calculator.
 *
 * Walks through inventory purchases (oldest first) and allocates them to sales
 * (oldest first) to determine the cost of goods sold per unit.
 *
 * Can recalculate a single SKU/ASIN (after editing a buy price) or all items.
 */
import Database from 'better-sqlite3';
import path from 'path';

interface InventoryBatch {
  id: number;
  sku: string;
  asin: string;
  buyPrice: number; // cents
  quantity: number;
  quantityRemaining: number;
  datePurchased: string;
}

interface SaleItem {
  id: number;
  orderId: string;
  sku: string;
  asin: string;
  quantity: number;
  purchaseDate: string;
  currentCogs: number;
}

interface FIFOResult {
  itemsUpdated: number;
  batchesUpdated: number;
  skusProcessed: number;
  errors: string[];
}

function getDb(readonly = false) {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly });
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Recalculate FIFO COGS for a specific SKU, ASIN, or all items.
 *
 * @param sku - Recalculate only this SKU (optional)
 * @param asin - Recalculate only this ASIN (optional, used if no SKU match)
 * @param recalcAll - If true, recalculate everything (ignores sku/asin params)
 */
export function recalculateFIFO(options: {
  sku?: string;
  asin?: string;
  recalcAll?: boolean;
} = {}): FIFOResult {
  const { sku, asin, recalcAll } = options;
  const db = getDb();

  const result: FIFOResult = {
    itemsUpdated: 0,
    batchesUpdated: 0,
    skusProcessed: 0,
    errors: [],
  };

  try {
    // Determine which SKUs to process
    let skusToProcess: { sku: string; asin: string }[] = [];

    if (recalcAll) {
      // Get all unique SKUs from inventory_ledger
      skusToProcess = db.prepare(`
        SELECT DISTINCT sku, asin FROM inventory_ledger
        WHERE buy_price > 0
        ORDER BY sku
      `).all() as any[];
    } else if (sku) {
      // Single SKU
      const entry = db.prepare('SELECT sku, asin FROM inventory_ledger WHERE sku = ? LIMIT 1').get(sku) as any;
      if (entry) {
        skusToProcess = [{ sku: entry.sku, asin: entry.asin }];
      } else {
        result.errors.push(`No inventory_ledger entry for SKU: ${sku}`);
        db.close();
        return result;
      }
    } else if (asin) {
      // All SKUs for this ASIN
      skusToProcess = db.prepare(`
        SELECT DISTINCT sku, asin FROM inventory_ledger WHERE asin = ? AND buy_price > 0
      `).all(asin) as any[];
      if (skusToProcess.length === 0) {
        result.errors.push(`No inventory_ledger entries for ASIN: ${asin}`);
        db.close();
        return result;
      }
    } else {
      result.errors.push('Must specify sku, asin, or recalcAll');
      db.close();
      return result;
    }

    // Prepared statements
    const getBatches = db.prepare(`
      SELECT id, sku, asin, buy_price as buyPrice, quantity, quantity_remaining as quantityRemaining, date_purchased as datePurchased
      FROM inventory_ledger
      WHERE sku = ? AND buy_price > 0
      ORDER BY date_purchased ASC, id ASC
    `);

    // Get sales for a SKU — match by sku first (primary), then by asin (fallback)
    const getSalesBySku = db.prepare(`
      SELECT oi.id, oi.order_id as orderId, oi.sku, oi.asin, oi.quantity, o.purchase_date as purchaseDate, oi.cogs_per_unit as currentCogs
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE oi.sku = ?
      ORDER BY o.purchase_date ASC, oi.id ASC
    `);

    const getSalesByAsin = db.prepare(`
      SELECT oi.id, oi.order_id as orderId, oi.sku, oi.asin, oi.quantity, o.purchase_date as purchaseDate, oi.cogs_per_unit as currentCogs
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE oi.asin = ? AND (oi.sku IS NULL OR oi.sku = '' OR oi.sku NOT IN (SELECT DISTINCT sku FROM inventory_ledger WHERE buy_price > 0))
      ORDER BY o.purchase_date ASC, oi.id ASC
    `);

    const updateCogs = db.prepare('UPDATE order_items SET cogs_per_unit = ? WHERE id = ?');
    const updateBatchRemaining = db.prepare('UPDATE inventory_ledger SET quantity_remaining = ? WHERE id = ?');

    // Process all SKUs in a single transaction
    const processAll = db.transaction(() => {
      for (const item of skusToProcess) {
        const batches = getBatches.all(item.sku) as InventoryBatch[];
        if (batches.length === 0) continue;

        // Get sales — by SKU primarily
        let sales = getSalesBySku.all(item.sku) as SaleItem[];

        // Also get sales matched by ASIN that don't have their own SKU inventory entry
        const asinSales = getSalesByAsin.all(item.asin) as SaleItem[];
        sales = [...sales, ...asinSales];

        // Sort by purchase_date
        sales.sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate) || a.id - b.id);

        if (sales.length === 0) {
          // No sales — reset all batches to full quantity
          for (const batch of batches) {
            updateBatchRemaining.run(batch.quantity, batch.id);
            result.batchesUpdated++;
          }
          result.skusProcessed++;
          continue;
        }

        // Reset batch quantities to full before recalculating
        const batchState = batches.map(b => ({
          ...b,
          remaining: b.quantity,
        }));

        // Walk through sales, consuming from earliest batches
        for (const sale of sales) {
          let unitsNeeded = sale.quantity;
          let totalCost = 0;
          let batchIdx = 0;

          while (unitsNeeded > 0 && batchIdx < batchState.length) {
            const batch = batchState[batchIdx];
            if (batch.remaining <= 0) {
              batchIdx++;
              continue;
            }

            const unitsFromBatch = Math.min(unitsNeeded, batch.remaining);
            totalCost += unitsFromBatch * batch.buyPrice;
            batch.remaining -= unitsFromBatch;
            unitsNeeded -= unitsFromBatch;

            if (batch.remaining <= 0) batchIdx++;
          }

          // Calculate weighted average COGS per unit for this sale
          const unitsFilled = sale.quantity - unitsNeeded;
          const cogsPerUnit = unitsFilled > 0 ? Math.round(totalCost / unitsFilled) : 0;

          // Only update if changed
          if (cogsPerUnit !== sale.currentCogs) {
            updateCogs.run(cogsPerUnit, sale.id);
            result.itemsUpdated++;
          }
        }

        // Update batch remaining quantities
        for (let i = 0; i < batchState.length; i++) {
          if (batchState[i].remaining !== batches[i].quantityRemaining) {
            updateBatchRemaining.run(batchState[i].remaining, batches[i].id);
            result.batchesUpdated++;
          }
        }

        result.skusProcessed++;
      }
    });

    processAll();
    db.close();
    return result;
  } catch (err) {
    db.close();
    result.errors.push(String(err));
    return result;
  }
}
