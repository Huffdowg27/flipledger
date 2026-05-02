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

interface ParsedRow {
  dateTime: string;
  settlementId: string;
  type: string;
  orderId: string;
  sku: string;
  description: string;
  quantity: number;
  productSales: number;
  sellingFees: number;
  fbaFees: number;
  otherTransactionFees: number;
  other: number;
  total: number;
}

function parseMoney(s: string): number {
  if (!s) return 0;
  return parseFloat(s.replace(/,/g, '')) || 0;
}

function parseDateToISO(dateStr: string): string {
  // Format: "Oct 2, 2025 5:48:32 AM PDT" or "Jan 15, 2026 3:22:11 PM PST"
  // Remove timezone abbreviation, parse with Date, return ISO
  const cleaned = dateStr.replace(/ P[DS]T$/, '').trim();
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) {
    // Fallback: try direct parse
    const d2 = new Date(dateStr);
    if (isNaN(d2.getTime())) return dateStr;
    return d2.toISOString();
  }
  // PDT = UTC-7, PST = UTC-8
  const isPDT = dateStr.includes('PDT');
  const offsetHours = isPDT ? 7 : 8;
  const utc = new Date(d.getTime() + offsetHours * 60 * 60 * 1000);
  return utc.toISOString();
}

function parseCSV(content: string): ParsedRow[] {
  const lines = content.split('\n');

  // Find header line (starts with "date/time")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    if (lines[i].startsWith('"date/time"')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error('Could not find header row starting with "date/time"');

  // Parse header
  const headerLine = lines[headerIdx];
  const headers = parseCSVLine(headerLine);

  const col = (name: string) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

  const dateIdx = col('date/time');
  const settlementIdx = col('settlement id');
  const typeIdx = col('type');
  const orderIdx = col('order id');
  const skuIdx = col('sku');
  const descIdx = col('description');
  const qtyIdx = col('quantity');
  const productSalesIdx = col('product sales');
  const sellingFeesIdx = col('selling fees');
  const fbaFeesIdx = col('fba fees');
  const otherTxFeesIdx = col('other transaction fees');
  const otherIdx = col('other');
  const totalIdx = col('total');

  const rows: ParsedRow[] = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    if (cols.length < 5) continue;

    const row: ParsedRow = {
      dateTime: cols[dateIdx] || '',
      settlementId: cols[settlementIdx] || '',
      type: cols[typeIdx] || '',
      orderId: cols[orderIdx] || '',
      sku: cols[skuIdx] || '',
      description: cols[descIdx] || '',
      quantity: parseInt(cols[qtyIdx] || '0') || 0,
      productSales: parseMoney(cols[productSalesIdx]),
      sellingFees: parseMoney(cols[sellingFeesIdx]),
      fbaFees: parseMoney(cols[fbaFeesIdx]),
      otherTransactionFees: parseMoney(cols[otherTxFeesIdx]),
      other: parseMoney(cols[otherIdx]),
      total: parseMoney(cols[totalIdx]),
    };

    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cols.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cols.push(current.trim());
  return cols;
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
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const csvPath = path.join(process.cwd(), 'data', 'amazon-transaction-report.csv');

  if (!fs.existsSync(csvPath)) {
    return NextResponse.json({ error: 'Transaction report not found at data/amazon-transaction-report.csv' }, { status: 404 });
  }

  const content = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, '');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  try {
    const rows = parseCSV(content);

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
          const totalCents = Math.round(row.total * 100);
          if (totalCents === 0) continue; // Skip zero-amount rows (e.g. inbound placement with $0)

          const postedDate = parseDateToISO(row.dateTime);
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

        const totalCents = Math.round(row.total * 100);
        const postedDate = parseDateToISO(row.dateTime);

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

        const totalCents = Math.round(row.total * 100);
        const postedDate = parseDateToISO(row.dateTime);

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

        const totalCents = Math.round(row.total * 100);
        if (totalCents === 0) continue;

        const postedDate = parseDateToISO(row.dateTime);

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
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    description: 'Import Amazon Unified Transaction Report',
    usage: 'POST /api/sync/import-transactions (reads from data/amazon-transaction-report.csv)',
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
