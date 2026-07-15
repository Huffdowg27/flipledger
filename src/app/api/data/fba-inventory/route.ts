import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

/**
 * GET /api/data/fba-inventory — live Amazon FBA / Walmart WFS stock from
 * live_inventory (counts only; no per-lot COGS — that lives in inventory_ledger).
 * Read-only. Powers the Inventory hub's FBA/WFS tabs.
 *
 * Query: channel = amazon (FBA, default) | walmart (WFS) ; q = search.
 */
function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

const HAS_STOCK = '(fulfillable_qty > 0 OR inbound_qty > 0 OR reserved_qty > 0 OR unfulfillable_qty > 0)';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const channel = searchParams.get('channel') === 'walmart' ? 'walmart' : 'amazon';
  const q = (searchParams.get('q') || '').trim();
  const db = getDb();

  try {
    const params: any[] = [channel];
    let search = '';
    if (q) {
      search = ` AND (li.product_name LIKE ? OR li.sku LIKE ? OR li.asin LIKE ?)`;
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const rows = db.prepare(`
      SELECT
        li.asin,
        li.sku,
        li.marketplace,
        COALESCE(li.product_name, p.name, li.asin) AS productName,
        p.image_url   AS imageUrl,
        li.fulfillable_qty   AS fulfillable,
        li.inbound_qty       AS inbound,
        li.reserved_qty      AS reserved,
        li.unfulfillable_qty AS unfulfillable,
        li.list_price        AS listPrice
      FROM live_inventory li
      LEFT JOIN products p ON p.asin = li.asin
      WHERE li.marketplace = ? AND ${HAS_STOCK}${search}
      ORDER BY li.fulfillable_qty DESC, li.inbound_qty DESC
      LIMIT 1000
    `).all(...params) as any[];

    // Stats across both channels so the strip is stable regardless of active tab.
    const byChannel = db.prepare(`
      SELECT marketplace,
        COUNT(*) AS skus,
        COALESCE(SUM(fulfillable_qty), 0)   AS fulfillable,
        COALESCE(SUM(inbound_qty), 0)       AS inbound,
        COALESCE(SUM(reserved_qty), 0)      AS reserved,
        COALESCE(SUM(unfulfillable_qty), 0) AS unfulfillable
      FROM live_inventory
      WHERE ${HAS_STOCK}
      GROUP BY marketplace
    `).all() as { marketplace: string; skus: number; fulfillable: number; inbound: number; reserved: number; unfulfillable: number }[];

    const pick = (mp: string) => byChannel.find((r) => r.marketplace === mp) || { skus: 0, fulfillable: 0, inbound: 0, reserved: 0, unfulfillable: 0 };
    const fba = pick('amazon');
    const wfs = pick('walmart');

    return NextResponse.json({
      rows,
      stats: {
        fba: { skus: fba.skus, units: fba.fulfillable, inbound: fba.inbound, reserved: fba.reserved, unfulfillable: fba.unfulfillable },
        wfs: { skus: wfs.skus, units: wfs.fulfillable, inbound: wfs.inbound, reserved: wfs.reserved, unfulfillable: wfs.unfulfillable },
        totalUnits: fba.fulfillable + wfs.fulfillable,
        totalReserved: fba.reserved + wfs.reserved,
      },
    });
  } catch (err) {
    console.error('[fba-inventory] error:', err);
    return NextResponse.json({ error: 'Failed to load FBA inventory' }, { status: 500 });
  } finally {
    db.close();
  }
}
