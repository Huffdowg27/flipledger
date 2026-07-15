import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { isIsoCalendarDate } from '@/lib/request-filters';
import {
  getSettlementNetMetricPeriods,
  SETTLEMENT_NET_BASIS_LABELS,
  summarizeSettlementNetMetrics,
} from '@/lib/settlement-net-metrics';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate') || undefined;
  const endDate = searchParams.get('endDate') || undefined;

  if (
    (startDate !== undefined && !isIsoCalendarDate(startDate))
    || (endDate !== undefined && !isIsoCalendarDate(endDate))
    || (startDate !== undefined && endDate !== undefined && startDate > endDate)
  ) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  }

  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly: true });
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');

  try {
    const periods = getSettlementNetMetricPeriods(db, { startDate, endDate });
    return NextResponse.json({
      basis: SETTLEMENT_NET_BASIS_LABELS,
      periods,
      totals: summarizeSettlementNetMetrics(periods),
    });
  } catch (err) {
    return NextResponse.json({ periods: [], error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
