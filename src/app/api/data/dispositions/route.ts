import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb(readonly = true) {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const type = searchParams.get('type'); // optional filter

  const db = getDb();
  try {
  const tableExists = (name: string) => {
    const row = db.prepare(
      "SELECT 1 AS existsFlag FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(name) as { existsFlag: number } | undefined;
    return !!row;
  };
  const columnsFor = (table: string) => new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((col) => col.name),
  );
  const currentColumns = columnsFor('dispositions');
  const historicalColumns = tableExists('historical_dispositions')
    ? columnsFor('historical_dispositions')
    : new Set<string>();
  const col = (tableAlias: string, columns: Set<string>, name: string, fallback: string) => (
    columns.has(name) ? `${tableAlias}.${name}` : fallback
  );

  const selects = [`
    SELECT
      ${col('d', currentColumns, 'id', 'NULL')} as id,
      ${col('d', currentColumns, 'disp_date', "''")} as disp_date,
      ${col('d', currentColumns, 'type', "''")} as type,
      ${col('d', currentColumns, 'ref_id', 'NULL')} as ref_id,
      ${col('d', currentColumns, 'title', 'NULL')} as title,
      ${col('d', currentColumns, 'msku', 'NULL')} as msku,
      ${col('d', currentColumns, 'asin', 'NULL')} as asin,
      ${col('d', currentColumns, 'az_disposition', 'NULL')} as az_disposition,
      COALESCE(${col('d', currentColumns, 'sellable_qty', '0')}, 0) as sellable_qty,
      COALESCE(${col('d', currentColumns, 'unsellable_qty', '0')}, 0) as unsellable_qty,
      COALESCE(${col('d', currentColumns, 'buy_cost_adj', '0')}, 0) as buy_cost_adj,
      ${col('d', currentColumns, 'edited_at', 'NULL')} as edited_at,
      'current' as source
    FROM dispositions d
  `];
  if (historicalColumns.size > 0) {
    selects.push(`
      SELECT
        ${col('h', historicalColumns, 'id', 'NULL')} as id,
        ${col('h', historicalColumns, 'disp_date', "''")} as disp_date,
        ${col('h', historicalColumns, 'type', "''")} as type,
        ${col('h', historicalColumns, 'ref_id', 'NULL')} as ref_id,
        ${col('h', historicalColumns, 'title', 'NULL')} as title,
        ${col('h', historicalColumns, 'msku', 'NULL')} as msku,
        ${col('h', historicalColumns, 'asin', 'NULL')} as asin,
        ${col('h', historicalColumns, 'az_disposition', 'NULL')} as az_disposition,
        COALESCE(${col('h', historicalColumns, 'sellable_qty', '0')}, 0) as sellable_qty,
        COALESCE(${col('h', historicalColumns, 'unsellable_qty', '0')}, 0) as unsellable_qty,
        COALESCE(${col('h', historicalColumns, 'buy_cost_adj', '0')}, 0) as buy_cost_adj,
        ${col('h', historicalColumns, 'edited_at', 'NULL')} as edited_at,
        'historical' as source
      FROM historical_dispositions h
    `);
  }

  const where: string[] = [];
  const params: any[] = [];
  if (startDate) { where.push('d.disp_date >= ?'); params.push(startDate); }
  if (endDate) {
    const endNext = new Date(new Date(endDate).getTime() + 86400000).toISOString().slice(0, 10);
    where.push('d.disp_date < ?'); params.push(endNext);
  }
  if (type) { where.push('d.type = ?'); params.push(type); }
  const WHERE = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT
        d.id, d.disp_date as dispDate, d.type, d.ref_id as refId,
        COALESCE(NULLIF(d.title, ''), p.name, d.asin, d.msku) as productName,
        d.msku, d.asin, d.az_disposition as azDisposition,
        d.sellable_qty as sellableQty, d.unsellable_qty as unsellableQty,
        d.buy_cost_adj as buyCostAdj, d.edited_at as editedAt,
        d.source
      FROM (
        ${selects.join('\nUNION ALL\n')}
      ) d
      LEFT JOIN products p ON p.asin = d.asin
      ${WHERE}
      ORDER BY d.disp_date DESC, d.id DESC
    `).all(...params) as any[];

    const restockReversal = rows.filter(r => r.buyCostAdj > 0).reduce((s, r) => s + r.buyCostAdj, 0);
    const writeoff = rows.filter(r => r.buyCostAdj < 0).reduce((s, r) => s + (-r.buyCostAdj), 0);
    const byType: Record<string, number> = {};
    for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
    const bySource = {
      current: rows.filter((r) => r.source === 'current').length,
      historical: rows.filter((r) => r.source === 'historical').length,
    };

    db.close();
    return NextResponse.json({
      items: rows,
      totals: {
        count: rows.length,
        restockReversalCents: restockReversal, // reverses COGS
        writeoffCents: writeoff,               // inventory write-off expense
        byType,
        bySource,
      },
    });
  } catch (error) {
    db.close();
    console.error('Dispositions API error:', error);
    return NextResponse.json({ error: 'Failed to load dispositions' }, { status: 500 });
  }
}

// Edit a disposition row. Body: { id, sellableQty?, unsellableQty?, buyCostAdjCents? }
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id } = body;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const sets: string[] = [];
  const params: any[] = [];
  if (Number.isInteger(body.sellableQty)) { sets.push('sellable_qty = ?'); params.push(body.sellableQty); }
  if (Number.isInteger(body.unsellableQty)) { sets.push('unsellable_qty = ?'); params.push(body.unsellableQty); }
  if (Number.isInteger(body.buyCostAdjCents)) { sets.push('buy_cost_adj = ?'); params.push(body.buyCostAdjCents); }
  if (sets.length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });

  sets.push("edited_at = ?");
  params.push(new Date().toISOString());
  params.push(id);

  const db = getDb(false);
  try {
    const info = db.prepare(`UPDATE dispositions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const updated = db.prepare('SELECT * FROM dispositions WHERE id = ?').get(id);
    db.close();
    return NextResponse.json({ ok: true, changes: info.changes, row: updated });
  } catch (error) {
    db.close();
    console.error('Disposition PATCH error:', error);
    return NextResponse.json({ error: 'Failed to update disposition' }, { status: 500 });
  }
}
