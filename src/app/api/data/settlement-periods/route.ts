/**
 * List Amazon settlement periods for the Profit First statement picker.
 * Lets the user scope numbers to real settlement boundaries instead of
 * arbitrary calendar dates (fixes the +1-day bucketing mismatch).
 */
import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import {
  getSettlementNetMetricPeriods,
  SETTLEMENT_NET_BASIS_LABELS,
} from '@/lib/settlement-net-metrics';

export async function GET() {
  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'), { readonly: true });
  db.pragma('busy_timeout = 15000');
  try {
    const periods = getSettlementNetMetricPeriods(db).map((period) => ({
      ...period,
      refundsCents: period.netRefundsCents,
      settlementNetBasis: {
        salesCents: period.salesCents,
        netRefundsCents: period.netRefundsCents,
        grossRefundsCents: period.grossRefundsCents,
        refundRatePct: period.refundRatePct,
        labels: SETTLEMENT_NET_BASIS_LABELS,
      },
    }));
    return NextResponse.json({ periods, basis: SETTLEMENT_NET_BASIS_LABELS });
  } catch (err) {
    return NextResponse.json({ periods: [], error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
