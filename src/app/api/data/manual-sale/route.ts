/**
 * POST /api/data/manual-sale
 *
 * Record an off-marketplace sale (PayPal wholesale, Venmo, bank transfer,
 * whatever) so it flows through the normal P&L / Dashboard / Tax Report
 * pipeline. Creates proper orders + order_items + financial_events +
 * fee_details rows and triggers FIFO so COGS is assigned correctly.
 *
 * Body:
 *   {
 *     sku:                string   (required, must exist in inventory_ledger)
 *     quantity:           number   (required, > 0, must not exceed stock)
 *     saleTotalCents:     number   (required, what the buyer actually paid you)
 *     paymentFeeCents:    number   (optional, default 0 — PayPal/Stripe/etc. fee)
 *     shippingCostCents:  number   (optional, default 0 — what YOU paid the carrier, not what the buyer paid)
 *     saleDate:           string   (optional, ISO — defaults to now)
 *     marketplace:        string   (optional, default 'paypal')
 *     feeType:            string   (optional, default 'PayPalProcessingFee')
 *     feeCategory:        string   (optional, default 'Payment Processing Fees')
 *     buyerNote:          string   (optional, stored in raw_data for reference)
 *     orderId:            string   (optional, auto-generated if omitted — format PP-YYYYMMDD-XXXXX)
 *   }
 *
 * Math flow:
 *   revenue       = saleTotalCents                           (e.g., 240000 = $2,400)
 *   paymentFee    = -paymentFeeCents (stored negative)       (e.g., -8425  = -$84.25)
 *   shippingCost  = shippingCostCents                        (e.g., 20808  = $208.08)
 *   COGS          = FIFO(sku, quantity) × quantity           (filled post-insert)
 *
 *   Expected profit = revenue - |paymentFee| - shippingCost - COGS
 *
 * The entry shows up everywhere that uses `orders JOIN order_items`
 * (Dashboard, P&L, Tax Report). The PayPal fee shows up in fee_details, so
 * it flows into P&L's fee hierarchy under whatever category you pass.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { recalculateFIFO } from '@/lib/fifo';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function generateOrderId(dateIso: string): string {
  // PP-YYYYMMDD-XXXXX  where XXXXX is a random 5-digit suffix
  const d = new Date(dateIso);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const suffix = Math.floor(10000 + Math.random() * 90000);
  return `PP-${ymd}-${suffix}`;
}

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // ─── Validate ────────────────────────────────────────────────────────
  const sku: string = String(body.sku || '').trim();
  const quantity: number = Number(body.quantity);
  const saleTotalCents: number = Number(body.saleTotalCents);
  const paymentFeeCents: number = Number(body.paymentFeeCents || 0);
  const shippingCostCents: number = Number(body.shippingCostCents || 0);
  const saleDate: string = body.saleDate || new Date().toISOString();
  const marketplace: string = String(body.marketplace || 'paypal');
  const feeType: string = String(body.feeType || 'PayPalProcessingFee');
  const feeCategory: string = String(body.feeCategory || 'Payment Processing Fees');
  const buyerNote: string = String(body.buyerNote || '');
  const orderId: string = String(body.orderId || '').trim() || generateOrderId(saleDate);

  if (!sku) return NextResponse.json({ error: 'sku is required' }, { status: 400 });
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: 'quantity must be a positive integer' }, { status: 400 });
  }
  if (!Number.isFinite(saleTotalCents) || saleTotalCents <= 0) {
    return NextResponse.json({ error: 'saleTotalCents must be a positive integer (cents)' }, { status: 400 });
  }
  if (paymentFeeCents < 0 || shippingCostCents < 0) {
    return NextResponse.json({ error: 'paymentFeeCents and shippingCostCents must be non-negative' }, { status: 400 });
  }

  const db = getDb();
  try {
    // Look up ASIN + stock. The FIFO engine matches by sku first then asin, so
    // we need to know the real ASIN for the products row and the financial_events row.
    const ledgerRow = db.prepare(`
      SELECT asin, SUM(quantity_remaining) as total_remaining
      FROM inventory_ledger
      WHERE sku = ?
      GROUP BY asin
      ORDER BY total_remaining DESC
      LIMIT 1
    `).get(sku) as { asin: string; total_remaining: number } | undefined;

    if (!ledgerRow) {
      return NextResponse.json({
        error: `SKU '${sku}' not found in inventory_ledger. Add a purchase first via the Products page.`,
      }, { status: 400 });
    }
    if (ledgerRow.total_remaining < quantity) {
      return NextResponse.json({
        error: `Not enough stock: ${ledgerRow.total_remaining} remaining, trying to sell ${quantity}.`,
      }, { status: 400 });
    }

    const asin = ledgerRow.asin;
    const now = new Date().toISOString();
    const pricePerUnit = Math.round(saleTotalCents / quantity); // integer cents
    const totalPrice = saleTotalCents; // store the agreed total, not price*quantity (avoid rounding drift)

    // Guard against duplicate manual sales — a hand-entered order_id collision is the
    // likely way this happens.
    const existing = db.prepare('SELECT 1 FROM orders WHERE order_id = ?').get(orderId);
    if (existing) {
      return NextResponse.json({ error: `order_id ${orderId} already exists` }, { status: 409 });
    }

    // ─── Insert everything in one transaction ─────────────────────────
    const txResult = db.transaction(() => {
      // 1. orders — purchase_date used by Tax Report
      db.prepare(`
        INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, created_at)
        VALUES (?, ?, 'Shipped', ?, 'MFN', 0, ?)
      `).run(orderId, saleDate, marketplace, now);

      // 2. order_items — total_price + shipping_cost (what we paid the carrier)
      //    cogs_per_unit left 0, FIFO fills it below.
      db.prepare(`
        INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0)
      `).run(orderId, asin, sku, quantity, pricePerUnit, totalPrice, shippingCostCents);

      // 3. financial_events — ShipmentEvent is what P&L/Dashboard revenue queries
      //    filter on for posted_date (cash basis). total_amount = net proceeds
      //    (revenue - fees). Convention matches Amazon sync.
      const netProceeds = saleTotalCents - paymentFeeCents;
      const raw = JSON.stringify({
        AmazonOrderId: orderId,
        PostedDate: saleDate,
        source: 'manual-sale',
        marketplace,
        note: buyerNote || null,
      });
      const feResult = db.prepare(`
        INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
        VALUES ('ShipmentEvent', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(saleDate, orderId, asin, sku, marketplace, netProceeds, raw, now);
      const financialEventId = Number(feResult.lastInsertRowid);

      // 4. fee_details — payment-processing fee (stored negative per codebase
      //    convention for all seller-side fees).
      if (paymentFeeCents > 0) {
        db.prepare(`
          INSERT INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(financialEventId, orderId, asin, feeType, feeCategory, -paymentFeeCents, saleDate);
      }

      // 5. Ensure a products row exists so joins resolve the name.
      //    Tolerant of duplicates — INSERT OR IGNORE.
      db.prepare(`
        INSERT OR IGNORE INTO products (asin, sku, marketplace, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(asin, sku, marketplace, now, now);

      return { financialEventId, netProceeds };
    })();

    // 6. Run FIFO — decrements inventory_ledger and fills cogs_per_unit on the
    //    newly-inserted order_items row.
    const fifoResult = recalculateFIFO({ sku });

    // 7. Read back the final numbers for the response
    const final = db.prepare(`
      SELECT
        oi.quantity, oi.total_price, oi.cogs_per_unit,
        (oi.cogs_per_unit * oi.quantity) as cogs_total,
        oi.shipping_cost
      FROM order_items oi
      WHERE oi.order_id = ?
    `).get(orderId) as any;

    const cogsTotal = final?.cogs_total || 0;
    const expectedProfit = saleTotalCents - cogsTotal - paymentFeeCents - shippingCostCents;

    return NextResponse.json({
      success: true,
      orderId,
      asin,
      sku,
      saleDate,
      marketplace,
      numbers: {
        revenueCents: saleTotalCents,
        paymentFeeCents,
        shippingCostCents,
        cogsCents: cogsTotal,
        netProceedsCents: txResult.netProceeds,
        expectedProfitCents: expectedProfit,
      },
      fifo: {
        itemsUpdated: fifoResult.itemsUpdated,
        skusProcessed: fifoResult.skusProcessed,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
