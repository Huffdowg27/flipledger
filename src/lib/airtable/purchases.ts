/**
 * Airtable → FlipLedger purchases sync.
 *
 * Pulls Jamie's existing "💳 Orders" table (eBay/Amazon→Amazon buys) into
 * incoming_purchases so FlipLedger owns everything after money moves:
 * on-order tracking, overdue aging, receive → lots, issues.
 *
 * Division of labor: Airtable = entry + pre-purchase pipeline (unchanged
 * workflow), FlipLedger = system of record from purchase onward.
 *
 * Field mapping (💳 Orders):
 *   OrderNumber → order_ref          DateOrdered → ordered_at
 *   Order QTY   → quantity           Cost (per unit) → unit_cost_cents
 *   Seller Sku  → sku (formula)      Product → product_name
 *   ASIN (linked → 💻 Products.Asin) → asin   (fallback: ASIN(OLD))
 *   Tracking Number → tracking_number
 *   Order Tracking Status / Delivery Status → delivery_status (display only)
 *   Suppllier (text) → order_source
 *
 * Rules:
 *   - Upsert keyed by airtable_record_id; idempotent.
 *   - Lock rule: rows locally received/cancelled are never updated again.
 *   - Legacy rows already fully received in Airtable (Received >= QTY) are
 *     skipped on first sight — they predate this system and would flood
 *     Incoming. Partial Airtable receives seed quantity_received.
 *
 * Scope: ONLY the "Orders Current" Airtable view (the rows Jamie is actively
 * working) plus a hard date floor — everything older was received before this
 * system existed and must not flood Incoming.
 *
 * Settings keys: airtable_api_key (PAT, required),
 *   airtable_purchases_base (default app1G29Xd3K6S5swV),
 *   airtable_purchases_table (default 💳 Orders),
 *   airtable_purchases_view (default Orders Current),
 *   airtable_products_table (default 💻 Products),
 *   airtable_purchases_since (date floor, default 2026-06-01),
 *   airtable_purchases_bin_cutoff (default 2026-06-13) — rows ordered BEFORE
 *     this date whose linked product already has a Bin Location are treated
 *     as received+inspected under the old process (Jamie's rule: a bin is
 *     only assigned after receive+inspect) and skipped. Rows ordered on/after
 *     the cutoff ignore bins — FlipLedger receiving owns bins from then on.
 */
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
}

async function fetchAllRecords(
  apiKey: string,
  baseId: string,
  table: string,
  params: Record<string, string | string[]> = {}
): Promise<AirtableRecord[]> {
  const records: AirtableRecord[] = [];
  let offset: string | undefined;
  let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, v);
    }
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Airtable ${res.status} on ${table}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
    pages++;
  } while (offset && pages < 50);
  return records;
}

export interface PurchasesSyncResult {
  scanned: number;
  inserted: number;
  updated: number;
  skippedLegacy: number;
  skippedLocked: number;
}

export async function syncAirtablePurchases(): Promise<PurchasesSyncResult> {
  const db = getDb();
  let settings: Record<string, string> = {};
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    for (const r of rows) settings[r.key] = r.value;
  } finally {
    db.close();
  }

  const apiKey = settings.airtable_api_key?.trim();
  if (!apiKey) throw new Error('airtable_api_key not configured — paste an Airtable personal access token in Settings.');
  const baseId = settings.airtable_purchases_base?.trim() || 'app1G29Xd3K6S5swV';
  const ordersTable = settings.airtable_purchases_table?.trim() || '💳 Orders';
  const productsTable = settings.airtable_products_table?.trim() || '💻 Products';
  const view = settings.airtable_purchases_view?.trim() || 'Orders Current';
  const sinceDate = settings.airtable_purchases_since?.trim() || '2026-06-01';
  const binCutoff = settings.airtable_purchases_bin_cutoff?.trim() || '2026-06-13';

  // 1. Products record-id → ASIN map (Orders links ASIN via record links).
  const productRecords = await fetchAllRecords(apiKey, baseId, productsTable, {
    'fields[]': ['Asin', 'Bin Location'],
  });
  const asinByRecordId = new Map<string, string>();
  const binByRecordId = new Map<string, string>();
  for (const r of productRecords) {
    if (r.fields?.Asin) asinByRecordId.set(r.id, String(r.fields.Asin).trim());
    if (r.fields?.['Bin Location']) binByRecordId.set(r.id, String(r.fields['Bin Location']).trim());
  }

  // 2. Orders from the working view only.
  const orders = await fetchAllRecords(apiKey, baseId, ordersTable, { view });

  const db2 = getDb();
  let inserted = 0, updated = 0, skippedLegacy = 0, skippedLocked = 0;
  try {
    const getExisting = db2.prepare('SELECT id, status, quantity_received FROM incoming_purchases WHERE airtable_record_id = ?');
    const insert = db2.prepare(`
      INSERT INTO incoming_purchases (
        airtable_record_id, order_source, order_ref, asin, sku, product_name, image_url,
        quantity, quantity_received, unit_cost_cents, sales_price_cents, profit_cents,
        ordered_at, tracking_number, delivery_status, status, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = db2.prepare(`
      UPDATE incoming_purchases SET
        order_source = ?, order_ref = ?, asin = ?, sku = ?, product_name = ?, image_url = ?,
        quantity = ?, unit_cost_cents = ?, sales_price_cents = ?, profit_cents = ?,
        ordered_at = ?, tracking_number = ?, delivery_status = ?, notes = ?, updated_at = ?
      WHERE airtable_record_id = ?
    `);

    const now = new Date().toISOString();

    for (const rec of orders) {
      const f = rec.fields || {};
      const qty = Math.max(0, Math.round(Number(f['Order QTY']) || 0));
      if (qty === 0) continue;
      // Date floor: anything ordered before the cutover was handled in the
      // old (pre-FlipLedger) process even if it's still in the view.
      const orderedAtRaw = typeof f['DateOrdered'] === 'string' ? f['DateOrdered'] : null;
      if (orderedAtRaw && orderedAtRaw < sinceDate) { skippedLegacy++; continue; }

      const airtableReceived = Math.max(0, Math.round(Number(f['Received']) || 0));
      const existing = getExisting.get(rec.id) as { id: number; status: string; quantity_received: number } | undefined;

      // Legacy rows fully handled before this system existed — never import.
      if (!existing && airtableReceived >= qty) { skippedLegacy++; continue; }
      // Bin rule: pre-cutoff orders whose product already has a bin were
      // received+inspected under the old process (bins only get assigned
      // after receive+inspect).
      if (!existing && orderedAtRaw && orderedAtRaw < binCutoff) {
        const links0: string[] = Array.isArray(f['ASIN']) ? f['ASIN'] : [];
        if (links0.some((rid) => binByRecordId.has(rid))) { skippedLegacy++; continue; }
      }
      // Lock rule: once FlipLedger marked it received/cancelled, Airtable
      // edits no longer flow in.
      if (existing && (existing.status === 'received' || existing.status === 'cancelled')) { skippedLocked++; continue; }

      // ASIN: linked 💻 Products record → Asin; fallback to legacy text field.
      let asin: string | null = null;
      const links: string[] = Array.isArray(f['ASIN']) ? f['ASIN'] : [];
      for (const rid of links) {
        const a = asinByRecordId.get(rid);
        if (a) { asin = a; break; }
      }
      if (!asin && f['ASIN(OLD)']) asin = String(f['ASIN(OLD)']).trim() || null;

      const skuRaw = f['Seller Sku'];
      const sku = (typeof skuRaw === 'string' && skuRaw.trim()) ? skuRaw.trim() : null;
      const unitCostCents = Math.round((Number(f['Cost']) || 0) * 100);
      const salesPriceCents = f['SalesPrice'] != null ? Math.round((Number(f['SalesPrice']) || 0) * 100) : null;
      const profitCents = f['Profit'] != null ? Math.round((Number(f['Profit']) || 0) * 100) : null;
      const deliveryStatus = [
        ...(Array.isArray(f['Delivery Status']) ? f['Delivery Status'] : []),
        ...(typeof f['Order Tracking Status'] === 'string' ? [f['Order Tracking Status']] : []),
      ].join(', ') || null;
      const source = (typeof f['Suppllier'] === 'string' && f['Suppllier'].trim()) ? f['Suppllier'].trim() : null;
      const orderedAt = f['DateOrdered'] || null;
      const orderRef = (typeof f['OrderNumber'] === 'string' && f['OrderNumber'].trim()) ? f['OrderNumber'].trim().split('\n')[0] : null;
      const productName = (typeof f['Product'] === 'string' && f['Product'].trim()) ? f['Product'].trim() : null;
      const imageUrl = (typeof f['ImageURL'] === 'string' && f['ImageURL'].trim()) ? f['ImageURL'].trim() : null;
      const notes = (typeof f['Promo Code / Notes'] === 'string' && f['Promo Code / Notes'].trim()) ? f['Promo Code / Notes'].trim() : null;

      if (existing) {
        update.run(
          source, orderRef, asin, sku, productName, imageUrl,
          qty, unitCostCents, salesPriceCents, profitCents, orderedAt, f['Tracking Number'] || null,
          deliveryStatus, notes, now, rec.id
        );
        updated++;
      } else {
        // Seed quantity_received from Airtable's manual count so partially
        // received legacy rows show only the remainder as incoming.
        const seedReceived = Math.min(airtableReceived, qty);
        insert.run(
          rec.id, source, orderRef, asin, sku, productName, imageUrl,
          qty, seedReceived, unitCostCents, salesPriceCents, profitCents, orderedAt, f['Tracking Number'] || null,
          deliveryStatus, seedReceived > 0 ? 'partial' : 'on_order', notes, now, now
        );
        inserted++;
      }
    }
  } finally {
    db2.close();
  }

  return { scanned: orders.length, inserted, updated, skippedLegacy, skippedLocked };
}
