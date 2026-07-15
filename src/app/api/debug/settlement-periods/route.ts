import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { requireDiagnosticRoute } from '@/lib/diagnostic-routes';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  return new Database(dbPath, { readonly: true });
}

export async function GET(request: Request) {
  const disabled = requireDiagnosticRoute();
  if (disabled) return disabled;

  const { searchParams } = new URL(request.url);
  const testStart = searchParams.get('requestedStart') ?? '2026-04-11';

  const db = getDb();
  try {
    const periods = db.prepare(`
      SELECT
        settlement_id,
        marketplace,
        start_date,
        end_date,
        deposit_date,
        created_at,
        updated_at
      FROM settlement_periods
      ORDER BY end_date DESC
    `).all() as any[];

    const orderCounts = db.prepare(`
      SELECT
        sp.settlement_id,
        COUNT(DISTINCT fe.order_id) as order_count,
        COUNT(fe.id)               as event_count
      FROM settlement_periods sp
      LEFT JOIN financial_events fe
        ON fe.event_type = 'ShipmentEvent'
        AND fe.order_id IS NOT NULL
        AND date(fe.posted_date) >= sp.start_date
        AND date(fe.posted_date) <= sp.end_date
      GROUP BY sp.settlement_id
    `).all() as any[];

    const countMap: Record<string, { order_count: number; event_count: number }> = {};
    for (const row of orderCounts) {
      countMap[row.settlement_id] = {
        order_count: row.order_count,
        event_count: row.event_count,
      };
    }

    const enriched = periods.map(p => ({
      ...p,
      order_count:  countMap[p.settlement_id]?.order_count  ?? 0,
      event_count:  countMap[p.settlement_id]?.event_count  ?? 0,
    }));

    // Rows whose start/end date prefix is not a parseable YYYY-MM-DD date
    const invalidDateRows = db.prepare(`
      SELECT settlement_id, start_date, end_date, deposit_date
      FROM settlement_periods
      WHERE date(substr(start_date, 1, 10)) IS NULL
         OR date(substr(end_date,   1, 10)) IS NULL
    `).all() as any[];

    // Groups where two or more periods share the same calendar start day
    const overlapGroups = db.prepare(`
      SELECT substr(start_date, 1, 10) as start_day, COUNT(*) as period_count,
             GROUP_CONCAT(settlement_id, ', ') as settlement_ids
      FROM settlement_periods
      GROUP BY start_day
      HAVING COUNT(*) > 1
      ORDER BY start_day
    `).all() as any[];

    // Effective reconcile start for the test date (mirrors getEffectiveReconcileStart logic)
    const effectiveStart = db.prepare(`
      SELECT settlement_id, start_date, end_date
      FROM settlement_periods
      WHERE substr(start_date, 1, 10) >= substr(?, 1, 10)
      ORDER BY
        substr(start_date, 1, 19),
        (julianday(substr(end_date,1,19)) - julianday(substr(start_date,1,19))),
        substr(end_date, 1, 19),
        settlement_id
      LIMIT 1
    `).get(testStart) as { settlement_id: string; start_date: string; end_date: string } | undefined;

    db.close();
    return NextResponse.json({
      total_periods: periods.length,
      invalid_date_rows: invalidDateRows,
      overlapping_start_groups: overlapGroups,
      chosen_effective_start: {
        requested_start: testStart,
        result: effectiveStart ?? null,
      },
      note: periods.length === 0
        ? 'No settlement periods stored yet. Trigger a settlement report sync to populate.'
        : null,
      periods: enriched,
    });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
