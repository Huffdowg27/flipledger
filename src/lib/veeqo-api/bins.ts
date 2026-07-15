/**
 * Push FlipLedger bin locations → Veeqo (so the native pick/pack list shows them).
 *
 * Veeqo stores bin on the stock entry:
 *   PUT /sellables/{sellable_id}/warehouses/{warehouse_id}/stock_entry
 *   body { stock_entry: { location: "<bin>" } }   (verified to persist)
 *
 * Matching: Veeqo's product API does NOT expose ASIN, so we match on `sku_code`
 * (normalized: trimmed + upper-cased to absorb trivial drift). Anything that
 * doesn't match is REPORTED, never guessed — writing a bin to the wrong product
 * is worse than leaving it blank.
 *
 * Two-phase like the other importers: preview (apply=false) writes nothing.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { getVeeqoApiKey, veeqoGet } from './shipping';

const VEEQO_BASE = 'https://api.veeqo.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: unknown) => String(s ?? '').trim().toUpperCase();

function getDb(readonly = false) {
  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

async function veeqoPut(pathAndQuery: string, body: unknown, apiKey: string): Promise<{ status: number; ok: boolean }> {
  const res = await fetch(`${VEEQO_BASE}${pathAndQuery}`, {
    method: 'PUT',
    headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Veeqo PUT ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return { status: res.status, ok: true };
}

interface VeeqoEntry { raw: string; sellableId: number | null; warehouseId: number | null; location: string | null }

/** sku_code(normalized) → first stock entry (sellable + warehouse + current location). */
async function buildVeeqoSkuMap(apiKey: string): Promise<Map<string, VeeqoEntry>> {
  const map = new Map<string, VeeqoEntry>();
  for (let page = 1; page <= 60; page++) {
    const d = await veeqoGet(`/products?page=${page}&page_size=100`, apiKey);
    const prods: any[] = Array.isArray(d) ? d : (d?.products || []);
    if (prods.length === 0) break;
    for (const p of prods) {
      for (const s of (p.sellables || [])) {
        const sc = s.sku_code;
        if (!sc) continue;
        const se = (s.stock_entries || [])[0] || {};
        const key = norm(sc);
        if (!map.has(key)) map.set(key, { raw: sc, sellableId: s.id ?? null, warehouseId: se.warehouse_id ?? null, location: se.location ?? null });
      }
    }
    if (prods.length < 100) break;
    await sleep(200);
  }
  return map;
}

export interface VeeqoBinResult {
  preview: boolean;
  flSkusWithBin: number;
  veeqoSkus: number;
  matched: number;
  toWrite: number;
  written: number;
  unchanged: number;
  unmatched: number;
  unmatchedSkus: string[];
  errors: string[];
}

export async function syncVeeqoBins(opts: { apply?: boolean } = {}): Promise<VeeqoBinResult> {
  const apiKey = getVeeqoApiKey();
  if (!apiKey) throw new Error('Veeqo API key not set (Settings → Veeqo)');
  const apply = opts.apply === true;

  const db = getDb(true);
  // One bin per SKU — most recent lot wins (date, then id).
  const rows = db.prepare(`
    SELECT sku, bin_location, date_purchased, id FROM inventory_ledger
    WHERE bin_location IS NOT NULL AND TRIM(bin_location) != '' AND sku IS NOT NULL AND TRIM(sku) != ''
    ORDER BY date_purchased DESC, id DESC
  `).all() as Array<{ sku: string; bin_location: string }>;
  db.close();

  const flBinBySku = new Map<string, string>(); // normalized sku → bin
  for (const r of rows) { const k = norm(r.sku); if (!flBinBySku.has(k)) flBinBySku.set(k, r.bin_location.trim()); }

  const vmap = await buildVeeqoSkuMap(apiKey);

  const res: VeeqoBinResult = {
    preview: !apply, flSkusWithBin: flBinBySku.size, veeqoSkus: vmap.size,
    matched: 0, toWrite: 0, written: 0, unchanged: 0, unmatched: 0, unmatchedSkus: [], errors: [],
  };

  for (const [skuKey, bin] of flBinBySku) {
    const v = vmap.get(skuKey);
    if (!v || v.sellableId == null || v.warehouseId == null) {
      res.unmatched++;
      if (res.unmatchedSkus.length < 100) res.unmatchedSkus.push(skuKey);
      continue;
    }
    res.matched++;
    if (norm(v.location) === norm(bin)) { res.unchanged++; continue; }
    res.toWrite++;
    if (apply) {
      try {
        await veeqoPut(`/sellables/${v.sellableId}/warehouses/${v.warehouseId}/stock_entry`, { stock_entry: { location: bin } }, apiKey);
        res.written++;
        await sleep(150); // gentle on rate limit
      } catch (err) {
        if (res.errors.length < 20) res.errors.push(`${v.raw}: ${String(err).slice(0, 120)}`);
      }
    }
  }
  return res;
}
