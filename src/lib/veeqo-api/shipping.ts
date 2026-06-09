/**
 * Veeqo shipping-cost sync (API path; primary). Pulls per-order label cost from
 * Veeqo and fills `order_items.shipping_cost` — the hands-free equivalent of the
 * Veeqo Shipping Report CSV importer.
 *
 * Veeqo REST API: https://api.veeqo.com, auth via `x-api-key` header. Per-order
 * label cost lives in `outbound_label_charges` ({ unit, value }) on the shipment
 * inside an order's allocation. The exact nesting can vary, so we recursively sum
 * every `outbound_label_charges.value` found on an order (defensive against
 * schema drift) — verified live after the key is entered.
 *
 * Money is integer cents. Cost is written to ONE order_item per order (lowest id),
 * never every line, to avoid double-counting multi-item orders.
 */
import Database from 'better-sqlite3';
import path from 'path';

const VEEQO_BASE = 'https://api.veeqo.com';

function getDb(readonly = false) {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly });
  db.pragma('journal_mode = WAL');
  return db;
}

export function getVeeqoApiKey(): string | null {
  try {
    const db = getDb(true);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'veeqo_api_key'").get() as { value?: string } | undefined;
    db.close();
    const k = (row?.value || '').trim();
    return k || null;
  } catch {
    return null;
  }
}

export async function veeqoGet(pathAndQuery: string, apiKey: string): Promise<any> {
  const res = await fetch(`${VEEQO_BASE}${pathAndQuery}`, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  });
  if (res.status === 429) throw new Error('Veeqo 429 (rate limited) — back off');
  if (res.status === 401 || res.status === 403) throw new Error(`Veeqo auth failed (${res.status}) — check API key`);
  if (!res.ok) throw new Error(`Veeqo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Recursively sum every `outbound_label_charges.value` on an order → cents. */
export function sumLabelCostCents(order: unknown): number {
  let cents = 0;
  const visit = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    for (const [k, val] of Object.entries(v)) {
      if (k === 'outbound_label_charges' && val && typeof val === 'object' && !Array.isArray(val)) {
        const raw = (val as any).value ?? (val as any).amount;
        const num = typeof raw === 'string' ? parseFloat(raw) : raw;
        if (typeof num === 'number' && Number.isFinite(num) && num > 0) cents += Math.round(num * 100);
      } else if (val && typeof val === 'object') {
        visit(val);
      }
    }
  };
  visit(order);
  return cents;
}

/** Candidate identifiers on a Veeqo order that might equal a FlipLedger order_id. */
export function orderIdentifiers(order: any): string[] {
  const ids = [order?.number, order?.channel_order_number, order?.customer_order_number, order?.remote_id, order?.id]
    .filter((x) => x != null && x !== '')
    .map((x) => String(x).trim());
  return Array.from(new Set(ids));
}

export interface VeeqoShipResult {
  ordersScanned: number;
  withLabelCost: number;
  matched: number;
  set: number;
  unchanged: number;
  skippedExisting: number;
  notFound: number;
  setCents: number;
  pages: number;
  watermark: string;
}

export async function syncVeeqoShipping(opts: { overwrite?: boolean; lookbackDays?: number } = {}): Promise<VeeqoShipResult> {
  const apiKey = getVeeqoApiKey();
  if (!apiKey) throw new Error('Veeqo API key not set (Settings → Veeqo)');
  const overwrite = opts.overwrite === true;

  const db = getDb();
  const last = (db.prepare("SELECT value FROM settings WHERE key = 'veeqo_shipping_last_sync'").get() as any)?.value as string | undefined;
  const lookbackDays = opts.lookbackDays ?? 60;
  const updatedSince = last || new Date(Date.now() - lookbackDays * 86400000).toISOString();

  const getOrder = db.prepare('SELECT order_id FROM orders WHERE order_id = ?');
  const getShip = db.prepare('SELECT COALESCE(SUM(shipping_cost),0) AS total, MIN(id) AS firstId, COUNT(*) AS lc FROM order_items WHERE order_id = ?');
  const zeroOrder = db.prepare('UPDATE order_items SET shipping_cost = 0 WHERE order_id = ?');
  const setLine = db.prepare('UPDATE order_items SET shipping_cost = ? WHERE id = ?');

  const r: VeeqoShipResult = {
    ordersScanned: 0, withLabelCost: 0, matched: 0, set: 0, unchanged: 0,
    skippedExisting: 0, notFound: 0, setCents: 0, pages: 0, watermark: updatedSince,
  };

  const PAGE_SIZE = 100;
  const MAX_PAGES = 100; // safety cap (10k orders/run)
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = `/orders?page=${page}&page_size=${PAGE_SIZE}&updated_at_min=${encodeURIComponent(updatedSince)}`;
      const data = await veeqoGet(q, apiKey);
      const orders: any[] = Array.isArray(data) ? data : (data?.orders || []);
      if (orders.length === 0) break;
      r.pages++;

      const apply = db.transaction(() => {
        for (const order of orders) {
          r.ordersScanned++;
          const cents = sumLabelCostCents(order);
          if (cents <= 0) continue;
          r.withLabelCost++;

          let flId: string | null = null;
          for (const id of orderIdentifiers(order)) {
            const row = getOrder.get(id) as { order_id: string } | undefined;
            if (row) { flId = row.order_id; break; }
          }
          if (!flId) { r.notFound++; continue; }
          r.matched++;

          const t = getShip.get(flId) as { total: number; firstId: number | null; lc: number };
          if (t.total === cents) { r.unchanged++; continue; }
          if (t.total !== 0 && !overwrite) { r.skippedExisting++; continue; }
          if (t.firstId == null) { r.notFound++; continue; }
          if (t.lc > 1) zeroOrder.run(flId);
          setLine.run(cents, t.firstId);
          r.set++; r.setCents += cents;
        }
      });
      apply();

      if (orders.length < PAGE_SIZE) break;
      await new Promise((res) => setTimeout(res, 250)); // gentle on Veeqo's rate limit
    }

    // Advance the watermark only on a clean full pass. Small overlap (-1h) so
    // late updates aren't missed. Idempotent fill makes any overlap harmless.
    const newWatermark = new Date(Date.now() - 3600000).toISOString();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('veeqo_shipping_last_sync', ?)").run(newWatermark);
    r.watermark = newWatermark;
    return r;
  } finally {
    db.close();
  }
}
