/**
 * Veeqo Shipping Report CSV → per-order MFN label cost importer (route half).
 *
 * Two-phase, mirroring the InventoryLab FBM importer: the client previews, but
 * the server ALWAYS re-parses the CSV and is the source of truth.
 *   - commit=false (default) → preview: classify every order, write nothing.
 *   - commit=true            → apply inside one transaction.
 *
 * Cost lands on `order_items.shipping_cost` (integer cents), which is what the
 * merchant-sales / profitability / P&L shipping math reads. Shipping is per-ORDER,
 * so we put the order's whole label cost on ONE line (lowest item id) — never the
 * settlement importer's "set every line" approach, which double-counts multi-item
 * orders. Multiple Veeqo labels for one order are summed.
 *
 * Default is fill-only (orders whose shipping_cost is currently 0). Pass
 * overwrite=true to make Veeqo authoritative even where a value already exists.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { parseVeeqoShippingCsv } from '@/lib/imports/veeqo-shipping';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

async function readBody(request: NextRequest): Promise<{ csv: string | null; commit: boolean; overwrite: boolean }> {
  const ct = request.headers.get('content-type') || '';
  let csv: string | null = null;
  let commit = false;
  let overwrite = false;
  if (ct.includes('application/json')) {
    const b = await request.json();
    if (typeof b?.csv === 'string') csv = b.csv;
    commit = b?.commit === true || b?.commit === 'true';
    overwrite = b?.overwrite === true || b?.overwrite === 'true';
  } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData();
    const file = form.get('file');
    if (file instanceof File) csv = await file.text();
    else if (typeof form.get('csv') === 'string') csv = form.get('csv') as string;
    commit = form.get('commit') === 'true';
    overwrite = form.get('overwrite') === 'true';
  } else {
    csv = await request.text();
  }
  return { csv, commit, overwrite };
}

export async function POST(request: NextRequest) {
  let body;
  try {
    body = await readBody(request);
  } catch (err) {
    return NextResponse.json({ error: `Could not read request body: ${err}` }, { status: 400 });
  }
  if (!body.csv || !body.csv.trim()) {
    return NextResponse.json({ error: 'CSV body is empty' }, { status: 400 });
  }

  const parsed = parseVeeqoShippingCsv(body.csv);
  if (parsed.globalErrors.length > 0) {
    return NextResponse.json({ error: 'CSV has problems', globalErrors: parsed.globalErrors }, { status: 400 });
  }
  if (parsed.rows.length === 0) {
    return NextResponse.json({ error: 'No rows with a label cost found (FBA rows have none).' }, { status: 400 });
  }

  // Sum label cost per order (an order can have multiple Veeqo labels / split shipments).
  const costByOrder = new Map<string, number>();
  for (const r of parsed.rows) costByOrder.set(r.orderId, (costByOrder.get(r.orderId) || 0) + r.costCents);

  const db = getDb();
  try {
    const getOrder = db.prepare('SELECT order_id, fulfillment_channel FROM orders WHERE order_id = ?');
    const getOrderShipTotal = db.prepare(
      'SELECT COALESCE(SUM(shipping_cost), 0) AS total, MIN(id) AS firstItemId, COUNT(*) AS lineCount FROM order_items WHERE order_id = ?',
    );

    type Action = 'set' | 'unchanged' | 'skipped_existing' | 'not_found';
    const plan: Array<{
      orderId: string; veeqoCents: number; existingCents: number;
      action: Action; firstItemId: number | null; lineCount: number; channel: string | null;
    }> = [];

    for (const [orderId, veeqoCents] of costByOrder) {
      const ord = getOrder.get(orderId) as { order_id: string; fulfillment_channel: string | null } | undefined;
      if (!ord) {
        plan.push({ orderId, veeqoCents, existingCents: 0, action: 'not_found', firstItemId: null, lineCount: 0, channel: null });
        continue;
      }
      const t = getOrderShipTotal.get(orderId) as { total: number; firstItemId: number | null; lineCount: number };
      let action: Action;
      if (t.total === veeqoCents) action = 'unchanged';
      else if (t.total === 0) action = 'set';
      else action = body.overwrite ? 'set' : 'skipped_existing';
      plan.push({ orderId, veeqoCents, existingCents: t.total, action, firstItemId: t.firstItemId, lineCount: t.lineCount, channel: ord.fulfillment_channel });
    }

    const toSet = plan.filter((p) => p.action === 'set');
    let applied = 0;

    if (body.commit && toSet.length > 0) {
      const zeroOrder = db.prepare('UPDATE order_items SET shipping_cost = 0 WHERE order_id = ?');
      const setLine = db.prepare('UPDATE order_items SET shipping_cost = ? WHERE id = ?');
      const tx = db.transaction(() => {
        for (const p of toSet) {
          if (p.firstItemId == null) continue;
          // Put the whole order's label cost on one line; clear any others so the
          // order total equals the label cost exactly (handles multi-item orders).
          if (p.lineCount > 1) zeroOrder.run(p.orderId);
          setLine.run(p.veeqoCents, p.firstItemId);
          applied++;
        }
      });
      tx();
    }

    const sum = (a: typeof plan) => a.reduce((s, p) => s + p.veeqoCents, 0);
    return NextResponse.json({
      preview: !body.commit,
      overwrite: body.overwrite,
      totals: {
        ordersInCsv: costByOrder.size,
        labelRows: parsed.rows.length,
        skippedNoCost: parsed.skippedNoCost,
        toSet: toSet.length,
        toSetCents: sum(toSet),
        unchanged: plan.filter((p) => p.action === 'unchanged').length,
        skippedExisting: plan.filter((p) => p.action === 'skipped_existing').length,
        notFound: plan.filter((p) => p.action === 'not_found').length,
        applied,
      },
      nonUsdCurrency: parsed.nonUsdCurrency,
      // Surface the rows that need a human decision / can't be applied.
      skippedExisting: plan.filter((p) => p.action === 'skipped_existing')
        .map((p) => ({ orderId: p.orderId, existingCents: p.existingCents, veeqoCents: p.veeqoCents })),
      notFound: plan.filter((p) => p.action === 'not_found').map((p) => p.orderId),
      willSet: plan.filter((p) => p.action === 'set')
        .map((p) => ({ orderId: p.orderId, veeqoCents: p.veeqoCents, channel: p.channel })),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
