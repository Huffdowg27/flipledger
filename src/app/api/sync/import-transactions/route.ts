/**
 * Import Amazon Unified Transaction Report CSV.
 *
 * This replaces ServiceFeeEvent entries (which have wrong timestamps from the Financial Events API)
 * with properly-dated service fees, FBA inventory fees, shipping label costs, and adjustments
 * from the transaction report.
 *
 * Reads from data/amazon-transaction-report.csv (no upload needed).
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {
  parseAmountToCents,
  parseTransactionReportCsv,
  parseTransactionReportDate,
} from '@/lib/imports/transaction-report';

interface ParsedRow {
  dateTime: string;
  postedDate: string;
  settlementId: string;
  type: string;
  orderId: string;
  sku: string;
  description: string;
  totalCents: number;
}

class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportValidationError';
  }
}

function parseCSV(content: string): ParsedRow[] {
  let sourceRows;
  try {
    sourceRows = parseTransactionReportCsv(content);
  } catch (error) {
    throw new ImportValidationError(error instanceof Error ? error.message : String(error));
  }
  if (sourceRows.length === 0) {
    throw new ImportValidationError('Transaction report contains zero data rows');
  }

  return sourceRows.map((row, index) => {
    try {
      return {
        dateTime: row.dateTime,
        postedDate: parseTransactionReportDate(row.dateTime),
        settlementId: row.settlementId,
        type: row.type,
        orderId: row.orderId,
        sku: row.sku,
        description: row.description,
        totalCents: parseAmountToCents(row.totalRaw),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ImportValidationError(`Invalid transaction report row ${index + 1}: ${detail}`);
    }
  });
}

function validateReplacementScopes(db: Database.Database, rows: ParsedRow[]) {
  const incomingFeeRows = rows.filter(
    (row) => (row.type === 'Service Fee' || row.type === 'FBA Inventory Fee')
      && row.totalCents !== 0,
  ).length;
  const existingFeeRows = (db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM fee_details
       WHERE (order_id IS NULL OR order_id = '')
         AND fee_type IN (
           'Subscription', 'FBAStorageFee', 'FBALongTermStorageFee', 'FBARemovalFee',
           'CostOfAdvertising', 'FBAInboundTransportationFee', 'FBAInboundConvenienceFee',
           'FBAInboundPlacementServiceFee', 'UnplannedServiceCharge',
           'CustomerReturnHRRUnitFee', 'FBADisposalFee', 'FBAInboundDefectFee',
           'FBAInboundShipmentCartonLevelInfoFee', 'InboundTransportationFee',
           'RemovalComplete', 'DisposalComplete'
         ))
      + (SELECT COUNT(*) FROM financial_events
         WHERE marketplace = 'amazon'
           AND event_type IN (
             'ServiceFeeEvent', 'SettlementServiceFee',
             'TransactionReportServiceFee', 'TransactionReportInventoryFee'
           )) AS count
  `).get() as { count: number }).count;
  if (existingFeeRows > 0 && incomingFeeRows === 0) {
    throw new ImportValidationError(
      'Refusing to replace an existing service/inventory-fee scope with zero replacement rows',
    );
  }

  const incomingShippingFeeRows = rows.filter(
    (row) => row.type === 'Shipping Services'
      && (row.description === 'Adjustment' || row.description === 'ReturnPostageBilling'),
  ).length;
  const existingShippingFeeRows = (db.prepare(`
    SELECT COUNT(*) AS count FROM fee_details
    WHERE fee_type IN ('ShippingLabelAdjustment', 'ReturnPostageBilling')
      AND fee_category = 'Other Fees' AND financial_event_id = 0
  `).get() as { count: number }).count;
  if (existingShippingFeeRows > 0 && incomingShippingFeeRows === 0) {
    throw new ImportValidationError(
      'Refusing to replace an existing shipping-fee scope with zero replacement rows',
    );
  }

  const incomingLiquidationRows = rows.filter(
    (row) => row.type === 'Liquidations' && row.totalCents !== 0,
  ).length;
  const existingLiquidationRows = (db.prepare(`
    SELECT COUNT(*) AS count FROM financial_events
    WHERE event_type = 'TransactionReportLiquidation'
  `).get() as { count: number }).count;
  if (existingLiquidationRows > 0 && incomingLiquidationRows === 0) {
    throw new ImportValidationError(
      'Refusing to replace an existing liquidation scope with zero replacement rows',
    );
  }
}

function mapDescriptionToFeeType(type: string, description: string): { feeType: string; feeCategory: string } {
  // Service Fee descriptions → fee_type names matching what the Financial Events API uses
  // Categories match what P&L expects: 'FBA Inventory and Inbound Service Fees' or 'Other Fees'
  const map: Record<string, { feeType: string; feeCategory: string }> = {
    'Cost of Advertising': { feeType: 'CostOfAdvertising', feeCategory: 'Other Fees' },
    'Subscription': { feeType: 'Subscription', feeCategory: 'Other Fees' },
    'FBA Inbound Placement Service Fee': { feeType: 'FBAInboundPlacementServiceFee', feeCategory: 'FBA Inventory and Inbound Service Fees' },
    'Unplanned Service Charge - Deleted/Abandoned Shipments': { feeType: 'UnplannedServiceCharge', feeCategory: 'Other Fees' },
    'FBA storage fee': { feeType: 'FBAStorageFee', feeCategory: 'FBA Inventory and Inbound Service Fees' },
    'FBA Long-Term Storage Fee': { feeType: 'FBALongTermStorageFee', feeCategory: 'FBA Inventory and Inbound Service Fees' },
    'FBA Removal Order: Return Fee': { feeType: 'FBARemovalFee', feeCategory: 'FBA Inventory and Inbound Service Fees' },
  };

  if (map[description]) return map[description];

  // FBA Inventory Fee with no description = inbound transport/convenience fees
  if (type === 'FBA Inventory Fee' && !description) {
    return { feeType: 'FBAInboundTransportationFee', feeCategory: 'FBA Inventory and Inbound Service Fees' };
  }

  // Fallback
  const feeType = description.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+(.)/g, (_, c) => c.toUpperCase()).replace(/^\w/, c => c.toUpperCase());
  const feeCategory = type === 'FBA Inventory Fee' ? 'FBA Inventory and Inbound Service Fees' : 'Other Fees';
  return { feeType, feeCategory };
}

export async function POST(request: NextRequest) {
  if (request.nextUrl.searchParams.get('confirm') !== '1') {
    return NextResponse.json({
      error: 'Destructive transaction replacement requires explicit ?confirm=1',
    }, { status: 400 });
  }

  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const csvPath = path.join(process.cwd(), 'data', 'amazon-transaction-report.csv');

  if (!fs.existsSync(csvPath)) {
    return NextResponse.json({ error: 'Transaction report not found at data/amazon-transaction-report.csv' }, { status: 404 });
  }

  const content = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, '');
  let rows: ParsedRow[];
  try {
    rows = parseCSV(content);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 400 });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  try {
    const stats = {
      totalRows: rows.length,
      serviceFees: { deleted: 0, inserted: 0, totalCents: 0 },
      fbaInventoryFees: { deleted: 0, inserted: 0, totalCents: 0 },
      shippingLabels: { updated: 0, totalCents: 0 },
      shippingAdjustments: { inserted: 0, totalCents: 0 },
      returnPostage: { inserted: 0, totalCents: 0 },
      adjustments: { updated: 0, inserted: 0, totalCents: 0 },
      liquidations: { inserted: 0, totalCents: 0 },
      skipped: 0,
    };

    const importAll = db.transaction(() => {
      // Validate every destructive replacement scope inside the same transaction,
      // before the first DELETE. A scope already holding rows may never be
      // replaced by an empty parse.
      validateReplacementScopes(db, rows);

      // === 1. DELETE old service fee data (wrong timestamps from Financial Events API) ===
      // The transaction report is the definitive source for ALL non-order fees.
      // Delete fee_details FIRST (before their parent events), then events.

      // Delete ALL non-order fee_details (service fees, storage, subscriptions, etc.)
      // The transaction report will replace these with properly-dated entries
      const deletedFeeDetails = db.prepare(`
        DELETE FROM fee_details
        WHERE (order_id IS NULL OR order_id = '')
        AND fee_type IN ('Subscription', 'FBAStorageFee', 'FBALongTermStorageFee', 'FBARemovalFee',
                         'CostOfAdvertising', 'FBAInboundTransportationFee', 'FBAInboundConvenienceFee',
                         'FBAInboundPlacementServiceFee', 'UnplannedServiceCharge',
                         'CustomerReturnHRRUnitFee', 'FBADisposalFee', 'FBAInboundDefectFee',
                         'FBAInboundShipmentCartonLevelInfoFee', 'InboundTransportationFee',
                         'RemovalComplete', 'DisposalComplete')
      `).run();

      // Delete ServiceFeeEvent financial_events (replaced by TransactionReport events)
      const deletedEvents = db.prepare(`
        DELETE FROM financial_events
        WHERE event_type IN ('ServiceFeeEvent', 'SettlementServiceFee')
        AND marketplace = 'amazon'
      `).run();

      // Also delete any previous transaction report imports (for idempotency)
      // Delete fee_details tied to previous transaction report imports
      db.prepare(`
        DELETE FROM fee_details
        WHERE financial_event_id IN (
          SELECT id FROM financial_events
          WHERE event_type IN ('TransactionReportServiceFee', 'TransactionReportInventoryFee', 'TransactionReportLiquidation')
        )
      `).run();
      db.prepare(`
        DELETE FROM financial_events
        WHERE event_type IN ('TransactionReportServiceFee', 'TransactionReportInventoryFee', 'TransactionReportLiquidation')
      `).run();

      stats.serviceFees.deleted = deletedFeeDetails.changes;
      stats.fbaInventoryFees.deleted = deletedEvents.changes;

      // === 2. Insert properly-dated Service Fee and FBA Inventory Fee entries ===
      const insertEvent = db.prepare(`
        INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
        VALUES (?, ?, NULL, NULL, NULL, 'amazon', ?, ?, datetime('now'))
      `);

      const insertFeeDetail = db.prepare(`
        INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
        VALUES (?, NULL, NULL, ?, ?, ?, ?)
      `);

      for (const row of rows) {
        if (row.type === 'Service Fee' || row.type === 'FBA Inventory Fee') {
          const totalCents = row.totalCents;
          if (totalCents === 0) continue; // Skip zero-amount rows (e.g. inbound placement with $0)

          const postedDate = row.postedDate;
          const { feeType, feeCategory } = mapDescriptionToFeeType(row.type, row.description);
          const eventType = row.type === 'Service Fee' ? 'TransactionReportServiceFee' : 'TransactionReportInventoryFee';

          const result = insertEvent.run(
            eventType,
            postedDate,
            totalCents,
            JSON.stringify({ type: row.type, description: row.description, dateTime: row.dateTime })
          );

          const eventId = result.lastInsertRowid;
          insertFeeDetail.run(eventId, feeType, feeCategory, totalCents, postedDate);

          if (row.type === 'Service Fee') {
            stats.serviceFees.inserted++;
            stats.serviceFees.totalCents += totalCents;
          } else {
            stats.fbaInventoryFees.inserted++;
            stats.fbaInventoryFees.totalCents += totalCents;
          }
        }
      }

      // === 3. Shipping Services ===
      // Clean up previous import's shipping adjustments and return postage
      db.prepare(`
        DELETE FROM fee_details WHERE fee_type IN ('ShippingLabelAdjustment', 'ReturnPostageBilling')
        AND fee_category = 'Other Fees' AND financial_event_id = 0
      `).run();

      const updateShippingCost = db.prepare(`
        UPDATE order_items SET shipping_cost = ? WHERE order_id = ?
      `);

      const insertShippingFee = db.prepare(`
        INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
        VALUES (0, ?, NULL, ?, 'Other Fees', ?, ?)
      `);

      for (const row of rows) {
        if (row.type !== 'Shipping Services') continue;

        const totalCents = row.totalCents;
        const postedDate = row.postedDate;

        if (row.description === 'Shipping Label Purchased through Amazon' && row.orderId) {
          // Update order_items shipping_cost for this order
          const absCents = Math.abs(totalCents);
          const result = updateShippingCost.run(absCents, row.orderId);
          if (result.changes > 0) {
            stats.shippingLabels.updated++;
            stats.shippingLabels.totalCents += totalCents;
          }
        } else if (row.description === 'Shipping Label Refunded through Amazon' && row.orderId) {
          // Refunded label — set shipping cost to 0
          updateShippingCost.run(0, row.orderId);
          stats.shippingLabels.updated++;
        } else if (row.description === 'Adjustment' && row.orderId) {
          // Shipping adjustment — store as fee_detail on the order
          insertShippingFee.run(row.orderId, 'ShippingLabelAdjustment', totalCents, postedDate);
          stats.shippingAdjustments.inserted++;
          stats.shippingAdjustments.totalCents += totalCents;
        } else if (row.description === 'ReturnPostageBilling' && row.orderId) {
          // Return postage charged to seller
          insertShippingFee.run(row.orderId, 'ReturnPostageBilling', totalCents, postedDate);
          stats.returnPostage.inserted++;
          stats.returnPostage.totalCents += totalCents;
        }
      }

      // === 4. Adjustments (reimbursements with proper dates) ===
      // Don't delete existing reimbursements — just update dates where we can match
      for (const row of rows) {
        if (row.type !== 'Adjustment') continue;

        const totalCents = row.totalCents;
        const postedDate = row.postedDate;

        if (row.description.includes('FBA Inventory Reimbursement')) {
          // Try to update existing reimbursement date to the correct one
          const reason = row.description.replace('FBA Inventory Reimbursement - ', '');
          const updated = db.prepare(`
            UPDATE reimbursements
            SET reimbursement_date = ?
            WHERE amount = ?
            AND reason LIKE ?
            AND marketplace = 'amazon'
            AND reimbursement_date LIKE '2026-04-11%'
          `).run(postedDate, totalCents, `%${reason}%`);

          if (updated.changes > 0) {
            stats.adjustments.updated++;
          }
          stats.adjustments.totalCents += totalCents;
        } else if (row.description === 'Buyer Recharge') {
          // Small buyer recharges — these are order adjustments, skip
          stats.skipped++;
        }
      }

      // === 5. Liquidations — insert as financial events ===
      for (const row of rows) {
        if (row.type !== 'Liquidations') continue;

        const totalCents = row.totalCents;
        if (totalCents === 0) continue;

        const postedDate = row.postedDate;

        // Check if we already have this liquidation
        const existing = db.prepare(`
          SELECT id FROM financial_events
          WHERE event_type = 'TransactionReportLiquidation'
          AND order_id = ?
          AND posted_date = ?
        `).get(row.orderId, postedDate);

        if (!existing) {
          const result = insertEvent.run(
            'TransactionReportLiquidation',
            postedDate,
            totalCents,
            JSON.stringify({ type: row.type, description: row.description, sku: row.sku })
          );

          // Store as an "other income" fee detail
          db.prepare(`
            INSERT INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
            VALUES (?, ?, NULL, 'LiquidationProceeds', 'Other Fees', ?, ?)
          `).run(result.lastInsertRowid, row.orderId, totalCents, postedDate);

          stats.liquidations.inserted++;
          stats.liquidations.totalCents += totalCents;
        }
      }
    });

    importAll();
    db.close();

    return NextResponse.json({
      success: true,
      stats: {
        totalRows: stats.totalRows,
        serviceFees: {
          oldEventsDeleted: stats.serviceFees.deleted,
          newInserted: stats.serviceFees.inserted,
          totalDollars: (stats.serviceFees.totalCents / 100).toFixed(2),
        },
        fbaInventoryFees: {
          orphanFeesDeleted: stats.fbaInventoryFees.deleted,
          newInserted: stats.fbaInventoryFees.inserted,
          totalDollars: (stats.fbaInventoryFees.totalCents / 100).toFixed(2),
        },
        shippingLabels: {
          ordersUpdated: stats.shippingLabels.updated,
          totalDollars: (stats.shippingLabels.totalCents / 100).toFixed(2),
        },
        shippingAdjustments: {
          inserted: stats.shippingAdjustments.inserted,
          totalDollars: (stats.shippingAdjustments.totalCents / 100).toFixed(2),
        },
        returnPostage: {
          inserted: stats.returnPostage.inserted,
          totalDollars: (stats.returnPostage.totalCents / 100).toFixed(2),
        },
        adjustments: {
          datesFixed: stats.adjustments.updated,
          totalDollars: (stats.adjustments.totalCents / 100).toFixed(2),
        },
        liquidations: {
          inserted: stats.liquidations.inserted,
          totalDollars: (stats.liquidations.totalCents / 100).toFixed(2),
        },
        skipped: stats.skipped,
      },
    });
  } catch (err) {
    db.close();
    const status = err instanceof ImportValidationError ? 400 : 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}

export async function GET() {
  return NextResponse.json({
    description: 'Import Amazon Unified Transaction Report',
    usage: 'POST /api/sync/import-transactions?confirm=1 (reads from data/amazon-transaction-report.csv)',
    actions: [
      'Deletes ServiceFeeEvent entries with wrong timestamps',
      'Inserts service fees and FBA inventory fees with correct posted dates',
      'Updates shipping label costs on order_items',
      'Inserts shipping adjustments and return postage billing as fee_details',
      'Fixes reimbursement dates from transaction report',
      'Inserts liquidation proceeds',
    ],
  });
}
