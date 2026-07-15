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
import { isAmazonGradedSku } from './sku-cogs';

// Infinite-lot treatment for `il:` import-snapshot lots is the CORRECT default:
// those lots carry a known per-unit cost and must cover every unit sold, not
// deplete to zero. This used to be opt-IN (`FIFO_IL_INFINITE=true`), which fails
// OPEN — any runtime that forgets the flag (bare `npm start`, a different process
// manager, a one-off recalc script) would silently zero out thousands in COGS.
// It is now ON by default; set `FIFO_IL_FINITE=true` only to deliberately disable.
// (The legacy `FIFO_IL_INFINITE=true` env var set in ecosystem.config.js is now a
// harmless no-op — the behavior it enabled is the default.)
const FIFO_IL_INFINITE = process.env.FIFO_IL_FINITE !== 'true';

interface InventoryBatch {
  id: number;
  sku: string;
  asin: string;
  buyPrice: number; // cents
  quantity: number;
  quantityRemaining: number;
  datePurchased: string;
  notes: string | null;
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

interface ConfirmedReturn {
  id: number;
  orderId: string;
  sku: string;
  asin: string;
  quantity: number;
  refundDate: string;
}

interface SaleAllocation {
  batchIndex: number | null;
  unitsUnreturned: number;
  isInfinite: boolean;
}

interface FIFOResult {
  itemsUpdated: number;
  batchesUpdated: number;
  skusProcessed: number;
  returnsConfirmed: number;
  returnsRestored: number;
  returnRestoreMismatches: number;
  errors: string[];
}

function getDb(readonly = false) {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

function isInfiniteLot(batch: InventoryBatch): boolean {
  return FIFO_IL_INFINITE
    && (batch.notes || '').startsWith('il:')
    && !batch.sku.startsWith('amzn.gr.');
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
    returnsConfirmed: 0,
    returnsRestored: 0,
    returnRestoreMismatches: 0,
    errors: [],
  };

  try {
    // Safety guard: the safe default keeps infinite-lot treatment ON. But if a
    // runtime has deliberately disabled it (FIFO_IL_FINITE=true) while il:
    // import-snapshot lots still exist, recalculating in finite mode would
    // deplete those lots to zero and silently destroy thousands in COGS.
    // Refuse loudly rather than corrupt the books — accuracy is the product.
    if (!FIFO_IL_INFINITE) {
      const ilLotCount = (db.prepare(`
        SELECT COUNT(*) AS n FROM inventory_ledger
        WHERE notes LIKE 'il:%' AND sku NOT LIKE 'amzn.gr.%' AND buy_price > 0
      `).get() as { n: number }).n;
      if (ilLotCount > 0) {
        const msg = `FIFO recalc REFUSED: FIFO_IL_FINITE=true but ${ilLotCount} il: `
          + `import-snapshot lot(s) exist. Recalculating in finite mode would silently `
          + `zero their COGS. Unset FIFO_IL_FINITE to proceed.`;
        console.error(`[fifo] ${msg}`);
        result.errors.push(msg);
        db.close();
        return result;
      }
    }

    // Determine which SKUs to process
    let skusToProcess: { sku: string; asin: string }[] = [];

    if (recalcAll) {
      // Get all unique SKUs from inventory_ledger, oldest-lot-first. The order
      // matters for the ASIN fallback below: when an ASIN has lots under several
      // SKUs, an orphan-SKU sale (its own SKU has no lot) is claimed by the FIRST
      // same-ASIN SKU we process — so processing the SKU with the oldest lot first
      // makes that fallback behave like true FIFO across the ASIN's SKUs, and makes
      // the result deterministic (was: alphabetical, which let ~5 items oscillate
      // between equal-cost SKUs on every recalc).
      skusToProcess = db.prepare(`
        SELECT sku, asin FROM (
          SELECT sku, asin, MIN(date_purchased) AS first_lot
          FROM inventory_ledger
          WHERE buy_price > 0 AND sku NOT LIKE 'amzn.gr.%'
          GROUP BY sku, asin
        )
        ORDER BY first_lot ASC, sku ASC
      `).all() as { sku: string; asin: string }[];
    } else if (sku) {
      // Single SKU
      const entry = db.prepare(
        'SELECT sku, asin FROM inventory_ledger WHERE sku = ? LIMIT 1',
      ).get(sku) as { sku: string; asin: string } | undefined;
      const hasGradedTarget = isAmazonGradedSku(sku) && !!db.prepare(`
        SELECT 1 FROM order_items WHERE sku = ?
        UNION ALL
        SELECT 1 FROM inventory_ledger WHERE sku = ?
        LIMIT 1
      `).get(sku, sku);
      if (entry && !isAmazonGradedSku(entry.sku)) {
        skusToProcess = [{ sku: entry.sku, asin: entry.asin }];
      } else if (!hasGradedTarget) {
        result.errors.push(`No inventory_ledger entry for SKU: ${sku}`);
        db.close();
        return result;
      }
    } else if (asin) {
      // All SKUs for this ASIN
      skusToProcess = db.prepare(`
        SELECT DISTINCT sku, asin FROM inventory_ledger
        WHERE asin = ? AND buy_price > 0 AND sku NOT LIKE 'amzn.gr.%'
      `).all(asin) as { sku: string; asin: string }[];
      if (skusToProcess.length === 0) {
        const hasGradedTarget = !!db.prepare(`
          SELECT 1 FROM order_items WHERE asin = ? AND sku LIKE 'amzn.gr.%'
          UNION ALL
          SELECT 1 FROM inventory_ledger WHERE asin = ? AND sku LIKE 'amzn.gr.%'
          LIMIT 1
        `).get(asin, asin);
        if (!hasGradedTarget) {
          result.errors.push(`No inventory_ledger entries for ASIN: ${asin}`);
          db.close();
          return result;
        }
      }
    } else {
      result.errors.push('Must specify sku, asin, or recalcAll');
      db.close();
      return result;
    }

    // Prepared statements
    const getBatches = db.prepare(`
      SELECT id, sku, asin, buy_price as buyPrice, quantity, quantity_remaining as quantityRemaining, date_purchased as datePurchased, notes
      FROM inventory_ledger
      WHERE sku = ? AND buy_price > 0
      ORDER BY date_purchased ASC, id ASC
    `);

    // Get sales for a SKU — match by sku first (primary), then by asin (fallback).
    // Canceled orders never shipped, so they must not consume inventory or carry COGS.
    const getSalesBySku = db.prepare(`
      SELECT oi.id, oi.order_id as orderId, oi.sku, oi.asin, oi.quantity, o.purchase_date as purchaseDate, oi.cogs_per_unit as currentCogs
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE oi.sku = ? AND o.status NOT IN ('Canceled', 'Cancelled')
      ORDER BY o.purchase_date ASC, oi.id ASC
    `);

    // amzn.gr.* resales are excluded from the ASIN fallback: they must never
    // consume a real lot (their cost was already expensed on the first sale).
    const getSalesByAsin = db.prepare(`
      SELECT oi.id, oi.order_id as orderId, oi.sku, oi.asin, oi.quantity, o.purchase_date as purchaseDate, oi.cogs_per_unit as currentCogs
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE oi.asin = ? AND o.status NOT IN ('Canceled', 'Cancelled')
        AND COALESCE(oi.sku, '') NOT LIKE 'amzn.gr.%'
        AND (
          oi.sku IS NULL
          OR oi.sku = ''
          OR oi.sku NOT IN (
            SELECT DISTINCT sku FROM inventory_ledger
            WHERE buy_price > 0 AND sku IS NOT NULL
          )
        )
      ORDER BY o.purchase_date ASC, oi.id ASC
    `);

    const updateCogs = db.prepare('UPDATE order_items SET cogs_per_unit = ? WHERE id = ?');
    const updateBatchRemaining = db.prepare('UPDATE inventory_ledger SET quantity_remaining = ? WHERE id = ?');
    const confirmedReturns = db.prepare(`
      SELECT
        id,
        order_id AS orderId,
        COALESCE(sku, '') AS sku,
        COALESCE(asin, '') AS asin,
        quantity,
        refund_date AS refundDate
      FROM refunds
      WHERE marketplace = 'amazon'
        AND disposition = 'SELLABLE'
        AND item_returned = 1
      ORDER BY refund_date ASC, id ASC
    `).all() as ConfirmedReturn[];
    const updateReturnRestoration = db.prepare(`
      UPDATE refunds
      SET
        inventory_restored_quantity = ?,
        inventory_restore_error = ?,
        inventory_restore_checked_at = CASE
          WHEN inventory_restored_quantity != ?
            OR COALESCE(inventory_restore_error, '') != COALESCE(?, '')
          THEN ?
          ELSE inventory_restore_checked_at
        END
      WHERE id = ?
    `);

    // Belt-and-suspenders: never process an amzn.gr.* SKU (covers the single-SKU
    // recalc path). Their lots are left untouched so ghost lots are never refilled.
    skusToProcess = skusToProcess.filter((s) => !isAmazonGradedSku(s.sku));

    // amzn.gr.* order_items never carry COGS (cost was expensed on the unit's
    // first sale). Reset them to 0 as part of recalculation, scoped to the recalc
    // target. Lots are excluded above, so quantity_remaining is not refilled.
    const resetAmznGrCogs = (): number => {
      if (recalcAll) {
        return db.prepare(`UPDATE order_items SET cogs_per_unit = 0 WHERE sku LIKE 'amzn.gr.%' AND cogs_per_unit != 0`).run().changes;
      } else if (isAmazonGradedSku(sku)) {
        return db.prepare(`UPDATE order_items SET cogs_per_unit = 0 WHERE sku = ? AND cogs_per_unit != 0`).run(sku).changes;
      } else if (asin) {
        return db.prepare(`UPDATE order_items SET cogs_per_unit = 0 WHERE sku LIKE 'amzn.gr.%' AND asin = ? AND cogs_per_unit != 0`).run(asin).changes;
      }
      return 0;
    };

    // Process all SKUs in a single transaction
    const processAll = db.transaction(() => {
      result.itemsUpdated += resetAmznGrCogs();
      // An orphan-SKU sale (its own SKU carries no lot) matches the ASIN fallback
      // for EVERY same-ASIN SKU that has lots. Without this guard each of those SKU
      // passes consumes the same sale from its own lots — double-counting inventory
      // and leaving cogs_per_unit set by whichever SKU ran last (the source of the
      // run-to-run oscillation). Claim each ASIN-fallback sale exactly once, by the
      // first SKU pass (oldest-lot, per the ordering above).
      const claimedAsinSaleIds = new Set<number>();
      const handledReturnIds = new Set<number>();
      const processedSkus = new Set<string>();

      for (const item of skusToProcess) {
        // A SKU should identify one product, but one historical SKU is mapped to
        // two ASIN values. Batches and direct sales are queried by SKU, so a
        // second pass would replay the same sale and return twice.
        if (processedSkus.has(item.sku)) continue;
        processedSkus.add(item.sku);

        const batches = getBatches.all(item.sku) as InventoryBatch[];
        if (batches.length === 0) continue;

        // Get sales — by SKU primarily
        let sales = getSalesBySku.all(item.sku) as SaleItem[];

        // Also get sales matched by ASIN that don't have their own SKU inventory
        // entry — but only those not already claimed by an earlier same-ASIN SKU.
        const asinSales = (getSalesByAsin.all(item.asin) as SaleItem[])
          .filter((s) => !claimedAsinSaleIds.has(s.id));
        for (const s of asinSales) claimedAsinSaleIds.add(s.id);
        sales = [...sales, ...asinSales];

        // Sort by purchase_date
        sales.sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate) || a.id - b.id);

        if (sales.length === 0) {
          // No sales — reset all batches to full quantity
          for (const batch of batches) {
            if (isInfiniteLot(batch)) continue;
            updateBatchRemaining.run(batch.quantity, batch.id);
            result.batchesUpdated++;
          }
          result.skusProcessed++;
          continue;
        }

        // Reset batch quantities to full before recalculating
        const batchState = batches.map(b => ({
          ...b,
          isInfinite: isInfiniteLot(b),
          remaining: b.quantity,
        }));
        const salesByKey = new Map<string, SaleItem[]>();
        for (const sale of sales) {
          const key = JSON.stringify([sale.orderId, sale.sku || '']);
          const matching = salesByKey.get(key) || [];
          matching.push(sale);
          salesByKey.set(key, matching);
        }
        const returnsBySaleId = new Map<number, ConfirmedReturn[]>();
        for (const returned of confirmedReturns) {
          const key = JSON.stringify([returned.orderId, returned.sku || '']);
          const matching = salesByKey.get(key);
          if (!matching || matching.length !== 1) continue;
          const saleReturns = returnsBySaleId.get(matching[0].id) || [];
          saleReturns.push(returned);
          returnsBySaleId.set(matching[0].id, saleReturns);
        }

        // Carry-forward cost for OVERFLOW units (sold more than recorded
        // purchases). A real sale always cost something — booking $0 COGS says
        // the item was free, which overstates profit/tax. So when finite lots
        // are exhausted, charge the overflow at the most recent known lot cost
        // (matches Inventory Lab's per-item carry-forward). Excludes amzn.gr.
        // resales (intentionally $0). Safe: oversold SKUs carry a single clean
        // cost in this data (verified 0 conflicts). Does not touch il: infinite
        // lots — those fill fully and never reach overflow.
        const carryCost = item.sku.startsWith('amzn.gr.')
          ? 0
          : ([...batchState].reverse().find(b => b.buyPrice > 0)?.buyPrice ?? 0);

        // Replay sales and confirmed SELLABLE returns in time order. A return
        // reverses the newest still-unreturned allocation from its original
        // sale, so multi-lot and partial-line returns remain deterministic.
        const events: Array<
          | { type: 'sale'; timestamp: string; sale: SaleItem }
          | { type: 'return'; timestamp: string; returned: ConfirmedReturn; saleId: number }
        > = [];
        for (const sale of sales) {
          events.push({ type: 'sale', timestamp: sale.purchaseDate, sale });
          for (const returned of returnsBySaleId.get(sale.id) || []) {
            events.push({
              type: 'return',
              timestamp: returned.refundDate,
              returned,
              saleId: sale.id,
            });
          }
        }
        events.sort((a, b) => (
          a.timestamp.localeCompare(b.timestamp)
          || (a.type === b.type ? 0 : a.type === 'sale' ? -1 : 1)
          || (a.type === 'sale' ? a.sale.id : a.returned.id)
            - (b.type === 'sale' ? b.sale.id : b.returned.id)
        ));

        const allocationsBySaleId = new Map<number, SaleAllocation[]>();
        for (const event of events) {
          if (event.type === 'return') {
            const { returned, saleId } = event;
            handledReturnIds.add(returned.id);
            const quantity = Number.isSafeInteger(returned.quantity) && returned.quantity > 0
              ? returned.quantity
              : 0;
            result.returnsConfirmed += quantity;

            let unitsToRestore = quantity;
            let restored = 0;
            const allocations = allocationsBySaleId.get(saleId) || [];
            for (let i = allocations.length - 1; i >= 0 && unitsToRestore > 0; i--) {
              const allocation = allocations[i];
              const units = Math.min(unitsToRestore, allocation.unitsUnreturned);
              if (units <= 0) continue;
              allocation.unitsUnreturned -= units;
              unitsToRestore -= units;

              if (allocation.isInfinite) {
                restored += units;
                continue;
              }
              if (allocation.batchIndex === null) continue;

              const batch = batchState[allocation.batchIndex];
              const capacity = Math.max(0, batch.quantity - batch.remaining);
              const unitsIntoLot = Math.min(units, capacity);
              batch.remaining += unitsIntoLot;
              restored += unitsIntoLot;
            }

            const missing = quantity - restored;
            const error = missing > 0
              ? `${missing} of ${quantity} confirmed unit${quantity === 1 ? '' : 's'} could not be restored to a recorded FIFO lot`
              : null;
            updateReturnRestoration.run(
              restored,
              error,
              restored,
              error,
              new Date().toISOString(),
              returned.id,
            );
            result.returnsRestored += restored;
            if (error) result.returnRestoreMismatches++;
            continue;
          }

          const sale = event.sale;
          let unitsNeeded = sale.quantity;
          let totalCost = 0;
          let batchIdx = 0;
          const allocations: SaleAllocation[] = [];

          while (unitsNeeded > 0 && batchIdx < batchState.length) {
            const batch = batchState[batchIdx];
            if (batch.remaining <= 0) {
              batchIdx++;
              continue;
            }

            const unitsFromBatch = batch.isInfinite ? unitsNeeded : Math.min(unitsNeeded, batch.remaining);
            totalCost += unitsFromBatch * batch.buyPrice;
            allocations.push({
              batchIndex: batchIdx,
              unitsUnreturned: unitsFromBatch,
              isInfinite: batch.isInfinite,
            });
            if (!batch.isInfinite) batch.remaining -= unitsFromBatch;
            unitsNeeded -= unitsFromBatch;

            if (!batch.isInfinite && batch.remaining <= 0) batchIdx++;
          }

          // Overflow: finite lots exhausted but units remain → carry forward the
          // known cost instead of leaving them at $0.
          if (unitsNeeded > 0 && carryCost > 0) {
            totalCost += unitsNeeded * carryCost;
            allocations.push({
              batchIndex: null,
              unitsUnreturned: unitsNeeded,
              isInfinite: false,
            });
            unitsNeeded = 0;
          }
          allocationsBySaleId.set(sale.id, allocations);

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
          if (batchState[i].isInfinite) continue;
          if (batchState[i].remaining !== batches[i].quantityRemaining) {
            updateBatchRemaining.run(batchState[i].remaining, batches[i].id);
            result.batchesUpdated++;
          }
        }

        result.skusProcessed++;
      }

      // A full replay is also the integrity sweep: every confirmed SELLABLE
      // return must map to one sale and recorded FIFO capacity. Scoped replays
      // leave unrelated return statuses untouched.
      if (recalcAll) {
        for (const returned of confirmedReturns) {
          if (handledReturnIds.has(returned.id)) continue;
          const quantity = Number.isSafeInteger(returned.quantity) && returned.quantity > 0
            ? returned.quantity
            : 0;
          if (isAmazonGradedSku(returned.sku)) {
            updateReturnRestoration.run(
              quantity,
              null,
              quantity,
              null,
              new Date().toISOString(),
              returned.id,
            );
            result.returnsConfirmed += quantity;
            result.returnsRestored += quantity;
            continue;
          }
          const error = quantity > 0
            ? `${quantity} of ${quantity} confirmed unit${quantity === 1 ? '' : 's'} could not be restored: no unique matching FIFO sale`
            : 'confirmed return has invalid quantity';
          updateReturnRestoration.run(
            0,
            error,
            0,
            error,
            new Date().toISOString(),
            returned.id,
          );
          result.returnsConfirmed += quantity;
          result.returnRestoreMismatches++;
        }
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
