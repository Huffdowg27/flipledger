import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { recalculateFIFO } from '@/lib/fifo';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET() {
  const db = getDb();
  try {
    // Two-part query:
    //
    // PART A: items in inventory_ledger (you've entered at least a placeholder).
    //   Name resolution is a layered lookup because inventory_ledger.asin often
    //   holds an MSKU (numeric) rather than a real Amazon ASIN. Priority:
    //     1. products row matching il.asin directly
    //     2. products row matching il.sku directly
    //     3. products row matching the real B-prefixed ASIN found in order_items
    //        for the same SKU (recovers items where inventory_ledger stores a
    //        numeric MSKU but orders has the real ASIN)
    //     4. live_inventory.product_name matched by SKU (cached from FBA sync)
    //     5. live_inventory.product_name matched by ASIN
    //     6. Fallback: the raw ASIN value
    //
    // PART B: items sold but never entered in inventory_ledger (surfaces
    //   missing-COGS exposure). For each such SKU we pick marketplace +
    //   total units sold from order_items and flag with hasLedger=0. The
    //   frontend can filter/highlight these as "Missing COGS".
    const products = db.prepare(`
      WITH real_asin AS (
        SELECT sku, MIN(asin) as asin
        FROM order_items
        WHERE asin LIKE 'B%' AND LENGTH(asin) = 10
        GROUP BY sku
      )
      SELECT
        COALESCE(p.asin, p2.asin, p3.asin, li_sku.asin, li_asin.asin, il.asin) as asin,
        COALESCE(p.name, p2.name, p3.name, li_sku.product_name, li_asin.product_name, il.asin) as name,
        COALESCE(p.category, p2.category, p3.category) as category,
        COALESCE(p.image_url, p2.image_url, p3.image_url) as image_url,
        il.sku,
        il.buy_price / 100.0 as costPerUnit,
        il.quantity as purchaseQty,
        il.quantity_remaining as qtyRemaining,
        il.date_purchased as datePurchased,
        s.name as supplierName,
        s.id as supplierId,
        COALESCE(p.marketplace, p2.marketplace, p3.marketplace, li_sku.marketplace, li_asin.marketplace) as marketplace,
        1 as hasLedger,
        0 as unitsSold
      FROM inventory_ledger il
      LEFT JOIN products p ON il.asin = p.asin
      LEFT JOIN products p2 ON il.sku = p2.sku AND p.asin IS NULL
      LEFT JOIN real_asin ra ON il.sku = ra.sku
      LEFT JOIN products p3 ON ra.asin = p3.asin
      LEFT JOIN live_inventory li_sku ON il.sku = li_sku.sku
      LEFT JOIN live_inventory li_asin ON il.asin = li_asin.asin AND li_sku.sku IS NULL
      LEFT JOIN suppliers s ON il.supplier_id = s.id

      UNION ALL

      SELECT
        COALESCE(p_oi_sku.asin, p_oi.asin, li_oi_sku.asin, li_oi_asin.asin, oi_missing.asin) as asin,
        COALESCE(p_oi_sku.name, p_oi.name, li_oi_sku.product_name, li_oi_asin.product_name, oi_missing.sku) as name,
        COALESCE(p_oi_sku.category, p_oi.category, 'Uncategorized') as category,
        COALESCE(p_oi_sku.image_url, p_oi.image_url) as image_url,
        oi_missing.sku,
        0 as costPerUnit,
        0 as purchaseQty,
        0 as qtyRemaining,
        NULL as datePurchased,
        NULL as supplierName,
        NULL as supplierId,
        oi_missing.marketplace,
        0 as hasLedger,
        oi_missing.unitsSold
      FROM (
        SELECT
          oi.sku,
          MIN(oi.asin) as asin,
          o.marketplace,
          SUM(oi.quantity) as unitsSold
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.order_id
        LEFT JOIN inventory_ledger il2 ON oi.sku = il2.sku
        -- Exclude phantom orders that have no matching financial event.
        -- These are usually sync artifacts (e.g. reimbursements or adjustments
        -- that got miscategorized as orders) and don't represent real inventory.
        WHERE il2.sku IS NULL
          AND EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.order_id = oi.order_id AND fe.event_type = 'ShipmentEvent'
          )
        GROUP BY oi.sku, o.marketplace
      ) oi_missing
      -- Join products by SKU first (eBay sync stores title with sku as the key),
      -- then by the ASIN column as a fallback (Amazon/Walmart path).
      LEFT JOIN products p_oi_sku ON oi_missing.sku = p_oi_sku.sku
      LEFT JOIN products p_oi ON oi_missing.asin = p_oi.asin AND p_oi_sku.sku IS NULL
      LEFT JOIN live_inventory li_oi_sku ON oi_missing.sku = li_oi_sku.sku
      LEFT JOIN live_inventory li_oi_asin ON oi_missing.asin = li_oi_asin.asin AND li_oi_sku.sku IS NULL

      ORDER BY hasLedger DESC, name
    `).all();

    const suppliers = db.prepare('SELECT id, name FROM suppliers ORDER BY name').all();

    db.close();
    return NextResponse.json({ products, suppliers });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { sku, asin, buyPrice, supplier, datePurchased, quantity } = body;

  if (!sku && !asin) {
    return NextResponse.json({ error: 'SKU or ASIN required' }, { status: 400 });
  }

  const db = getDb();
  try {
    const now = new Date().toISOString();
    const buyPriceCents = Math.round((buyPrice || 0) * 100);

    // Upsert supplier if name provided
    let supplierId = null;
    if (supplier) {
      db.prepare('INSERT OR IGNORE INTO suppliers (name, created_at) VALUES (?, ?)').run(supplier, now);
      const row = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(supplier) as any;
      supplierId = row?.id;
    }

    // Upsert inventory ledger entry
    if (sku) {
      const existing = db.prepare('SELECT id FROM inventory_ledger WHERE sku = ?').get(sku) as any;
      if (existing) {
        db.prepare(`
          UPDATE inventory_ledger SET
            buy_price = ?,
            supplier_id = COALESCE(?, supplier_id),
            date_purchased = COALESCE(?, date_purchased)
          WHERE sku = ?
        `).run(buyPriceCents, supplierId, datePurchased, sku);
      } else {
        // New ledger row. If the user is back-filling COGS for a SKU that has
        // already been SOLD (common for eBay items that were never pre-entered),
        // we need quantity >= units_sold so FIFO can allocate COGS to those
        // historical sales. Look up the sold count and seed accordingly.
        const soldRow = db.prepare(`
          SELECT COALESCE(SUM(oi.quantity), 0) as units_sold
          FROM order_items oi
          WHERE oi.sku = ?
        `).get(sku) as { units_sold: number };

        const unitsSold = soldRow?.units_sold || 0;
        const qtyRequested = quantity || 1;
        // Seed quantity = max(requested qty, units_sold + 1) so FIFO has room
        const seedQty = Math.max(qtyRequested, unitsSold + 1);

        // quantity_remaining starts at the seed qty; the FIFO recalc below
        // will immediately decrement it to reflect past sales.
        db.prepare(`
          INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, supplier_id, date_purchased, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(asin || sku, sku, buyPriceCents, seedQty, seedQty, supplierId, datePurchased || now, now);
      }
    } else if (asin) {
      // Update all entries for this ASIN
      db.prepare(`
        UPDATE inventory_ledger SET
          buy_price = ?,
          supplier_id = COALESCE(?, supplier_id)
        WHERE asin = ?
      `).run(buyPriceCents, supplierId, asin);
    }

    db.close();

    // Auto-recalculate FIFO COGS for the affected SKU/ASIN
    const fifoResult = recalculateFIFO({ sku: sku || undefined, asin: asin || undefined });

    return NextResponse.json({ success: true, fifo: fifoResult });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
