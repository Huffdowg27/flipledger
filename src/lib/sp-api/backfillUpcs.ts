/**
 * UPC backfill — shared core.
 *
 * Fills products.upc from the Catalog Items API for ASINs that appear on
 * merchant-fulfilled (MFN) orders and don't have a UPC yet. Read-only SP-API.
 *
 * Used by:
 *   - POST /api/sync/backfill-upcs  (manual / dry-run capable)
 *   - auto-sync (daily, so new MFN-order ASINs get UPCs without manual runs).
 *
 * Stores the real UPC, or the sentinel '-' for "checked, none found" so it isn't
 * re-fetched forever. Rate-limited via delayMs (Catalog API ~2/s).
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fetchUpcByAsin } from './catalog';
import type { SPAPICredentials } from './types';

export interface BackfillUpcsResult {
  eligible: number;
  attempted: number;
  found: number;
  missing: number;
  failed: number;
  errors: { asin: string; error: string }[];
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ASINs on MFN orders that have a products row with no UPC yet.
export const UPC_ELIGIBLE_SQL = `
  SELECT DISTINCT p.asin
  FROM products p
  JOIN order_items oi ON oi.asin = p.asin
  JOIN orders o ON o.order_id = oi.order_id
  WHERE (p.upc IS NULL OR p.upc = '')
    AND o.marketplace = 'amazon'
    AND o.fulfillment_channel IN ('MFN', 'DEFAULT')
`;

export async function backfillUpcs(
  creds: SPAPICredentials,
  opts: { limit?: number; delayMs?: number } = {}
): Promise<BackfillUpcsResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 300);
  const delayMs = Math.max(opts.delayMs ?? 300, 0);

  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'));
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');

  const result: BackfillUpcsResult = { eligible: 0, attempted: 0, found: 0, missing: 0, failed: 0, errors: [] };
  try {
    result.eligible = (db.prepare(`SELECT COUNT(*) AS n FROM (${UPC_ELIGIBLE_SQL})`).get() as { n: number }).n;
    const asins = (db.prepare(`${UPC_ELIGIBLE_SQL} ORDER BY p.asin LIMIT ?`).all(limit) as { asin: string }[]).map(r => r.asin);
    const update = db.prepare(`UPDATE products SET upc = ?, updated_at = ? WHERE asin = ?`);

    for (let i = 0; i < asins.length; i++) {
      if (i > 0 && delayMs > 0) await delay(delayMs);
      result.attempted++;
      try {
        const upc = await fetchUpcByAsin(creds, asins[i]);
        if (upc) { update.run(upc, new Date().toISOString(), asins[i]); result.found++; }
        else { update.run('-', new Date().toISOString(), asins[i]); result.missing++; }
      } catch (err) {
        result.failed++;
        result.errors.push({ asin: asins[i], error: String(err) });
      }
    }
  } finally {
    db.close();
  }
  return result;
}
