/**
 * Dashboard snapshot strip (SellerBoard-style period cards).
 *
 * Reuses the verified P&L engine: for each period (and its prior-equivalent
 * window, for the % deltas) it calls /api/data/profitloss with the same
 * dateBasis the user picked, so every number here ties out to the P&L exactly.
 * No new accounting — same calc across several date windows.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isIsoCalendarDate, parseMarketplaceFilter } from '@/lib/request-filters';
import {
  addCalendarDays,
  calendarDaysBetween,
  formatCalendarDateInTimeZone,
} from '@/lib/local-day-boundaries';

type Metrics = {
  sales: number; netProfit: number; cogs: number; margin: number;
  refunds: number; refundCount: number; refundUnits: number; orders: number; units: number; roi: number;
  operatingSales: number | null;
};

type SnapshotPeriod = {
  key: string;
  label: string;
  start: string;
  end: string;
  pStart: string;
  pEnd: string;
};

const CUSTOM_PRESET_LABELS: Record<string, string> = {
  'this-month': 'This month',
  'last-month': 'Last month',
  'last-7-days': 'Last 7 days',
  'last-14-days': 'Last 14 days',
  'last-30-days': 'Last 30 days',
  qtd: 'Quarter to date',
  ytd: 'Year to date',
  custom: 'Custom',
};

async function plMetrics(origin: string, start: string, end: string, qs: string): Promise<Metrics> {
  const r = await fetch(`${origin}/api/data/profitloss?startDate=${start}&endDate=${end}${qs}`, { cache: 'no-store' });
  if (!r.ok) {
    throw new Error(`P&L metrics request failed (${r.status})`);
  }
  const j = await r.json();
  const netProfit = j.netProfit || 0;
  const cogs = j.expenses?.cogs || 0;
  return {
    sales: j.income?.sales || 0,
    netProfit,
    cogs,
    margin: j.margin || 0,
    refunds: j.refunds?.total || 0,
    refundCount: j.refundSummary?.count || 0,
    refundUnits: j.refundSummary?.units || 0,
    orders: j.unitSummary?.orders || 0,
    units: j.unitSummary?.units || 0,
    roi: cogs > 0 ? (netProfit / cogs) * 100 : 0,
    operatingSales: j.operatingSales ?? null,
  };
}

function previousFullCalendarMonth(start: string): { pStart: string; pEnd: string } {
  const pEnd = addCalendarDays(`${start.slice(0, 7)}-01`, -1);
  return { pStart: `${pEnd.slice(0, 7)}-01`, pEnd };
}

function previousEqualLengthPeriod(start: string, end: string): { pStart: string; pEnd: string } {
  const days = calendarDaysBetween(start, end);
  const pEnd = addCalendarDays(start, -1);
  return { pStart: addCalendarDays(pEnd, -days), pEnd };
}

function fixedSnapshotPeriods(today: string): SnapshotPeriod[] {
  const yest = addCalendarDays(today, -1);
  return [
    { key: 'today',     label: 'Today',         start: today, end: today,
      pStart: yest, pEnd: yest },
    { key: 'yesterday', label: 'Yesterday',     start: yest, end: yest,
      pStart: addCalendarDays(today, -2), pEnd: addCalendarDays(today, -2) },
    { key: '7d',        label: '7 days',        start: addCalendarDays(today, -6), end: today,
      pStart: addCalendarDays(today, -13), pEnd: addCalendarDays(today, -7) },
    { key: '14d',       label: '14 days',       start: addCalendarDays(today, -13), end: today,
      pStart: addCalendarDays(today, -27), pEnd: addCalendarDays(today, -14) },
    (() => {
      const mStart = `${today.slice(0, 7)}-01`;
      const days = calendarDaysBetween(mStart, today);
      const pmEnd = addCalendarDays(mStart, -1);
      const pmStart = addCalendarDays(pmEnd, -days);
      return { key: 'mtd', label: 'Month to date', start: mStart, end: today,
        pStart: pmStart, pEnd: pmEnd };
    })(),
  ];
}

function customSnapshotPeriod(start: string, end: string, preset: string): SnapshotPeriod {
  const previous = (preset === 'this-month' || preset === 'last-month')
    ? previousFullCalendarMonth(start)
    : previousEqualLengthPeriod(start, end);
  return {
    key: 'custom',
    label: CUSTOM_PRESET_LABELS[preset] || 'Custom',
    start,
    end,
    ...previous,
  };
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const dateBasis = sp.get('dateBasis') || 'posted';
  if (!['posted', 'purchase', 'reconciled'].includes(dateBasis)) {
    return NextResponse.json({ error: 'Invalid date basis' }, { status: 400 });
  }

  const marketplaceResult = parseMarketplaceFilter(sp.get('marketplace'));
  if (!marketplaceResult.ok) {
    return NextResponse.json({ error: 'Invalid marketplace' }, { status: 400 });
  }
  const marketplace = marketplaceResult.marketplace;

  const channelParam = sp.get('channel');
  if (channelParam !== null && channelParam !== 'fba' && channelParam !== 'mfn') {
    return NextResponse.json({ error: 'Invalid channel' }, { status: 400 });
  }
  const channel = channelParam as 'fba' | 'mfn' | null;

  const rawStartDate = sp.get('startDate');
  const rawEndDate = sp.get('endDate');
  const hasCustomRange = rawStartDate !== null || rawEndDate !== null;
  if (
    hasCustomRange
    && (
      rawStartDate === null
      || rawEndDate === null
      || !isIsoCalendarDate(rawStartDate)
      || !isIsoCalendarDate(rawEndDate)
      || rawStartDate > rawEndDate
    )
  ) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  }
  const customPreset = sp.get('customPreset') || 'custom';
  if (!(customPreset in CUSTOM_PRESET_LABELS)) {
    return NextResponse.json({ error: 'Invalid custom preset' }, { status: 400 });
  }
  // localDays=1: the snapshot's Today/Yesterday boundaries must match Amazon's
  // (local marketplace day), not UTC. The P&L page keeps UTC (default).
  const qs = `${dateBasis !== 'posted' ? `&dateBasis=${dateBasis}` : ''}`
    + `${marketplace ? `&marketplace=${marketplace}` : ''}`
    + `${channel ? `&channel=${channel}` : ''}`
    + `&localDays=1&summaryOnly=1`;
  const origin = request.nextUrl.origin;

  const today = formatCalendarDateInTimeZone(new Date());
  const periods = fixedSnapshotPeriods(today);
  if (hasCustomRange) {
    periods.push(customSnapshotPeriod(rawStartDate!, rawEndDate!, customPreset));
  }

  const pct = (c: number, pr: number) => (pr !== 0 ? ((c - pr) / Math.abs(pr)) * 100 : null);

  // Operating basis only: show gross order_total sales (matches Amazon app,
  // incl. pending). Settled/Accounting keep the conservative P&L sales figure.
  const operating = dateBasis === 'purchase';

  const cards = await Promise.all(periods.map(async (p) => {
    const [cur, prev] = await Promise.all([
      plMetrics(origin, p.start, p.end, qs),
      plMetrics(origin, p.pStart, p.pEnd, qs),
    ]);
    const curSales = operating ? (cur.operatingSales ?? cur.sales) : cur.sales;
    const prevSales = operating ? (prev.operatingSales ?? prev.sales) : prev.sales;
    return {
      key: p.key, label: p.label, start: p.start, end: p.end,
      previousStart: p.pStart,
      previousEnd: p.pEnd,
      ...cur,
      sales: curSales,
      salesDelta: pct(curSales, prevSales),
      profitDelta: pct(cur.netProfit, prev.netProfit),
    };
  }));

  return NextResponse.json({ dateBasis, channel, cards });
}
