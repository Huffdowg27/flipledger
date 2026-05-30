'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { formatCurrency, centsToDollars, formatNumber } from '@/lib/formatters';

interface DashboardData {
  stats: {
    totalRevenue: number;
    totalProfit: number;
    totalUnits: number;
    totalOrders: number;
    totalCogs: number;
    totalFees: number;
    serviceFees: number;
    roi: number;
    prevRevenue: number;
    prevProfit: number;
    prevUnits: number;
    prevRoi: number;
  };
  dailyRevenue: { day: string; revenue: number; profit: number; grouping?: string }[];
}

function toLocalDateString(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().split('T')[0];
}

function relativeTime(value?: string | null): string {
  if (!value) return 'not synced yet';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'sync time unknown';
  const diffMinutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface OpsPulse {
  // Fixed-window operational cards — independent of the user's date picker.
  // "today" uses accrual basis (purchase_date) because cash settles ~10 days later.
  // "7d" uses cash basis (posted_date) to match P&L.
  week7d: { revenue: number; profit: number; prevRevenue: number; prevProfit: number };
  mfn7d: {
    estimated: { count: number; revenue: number };
    reconciled: { count: number; revenue: number };
  };
  returnsMonth: { count: number; netImpact: number };
  draftMfnBatches: { count: number };
  openMfnOrders: { count: number; revenue: number };
}

interface DailySales {
  // Today's sales composition. Headline is KNOWN-ONLY: itemized + Amazon-provided
  // OrderTotal placeholders. Pending orders without item detail are surfaced as a
  // count only — never converted to dollars (no AOV multiplication in the UI).
  // The dashboard endpoint still computes an AOV estimate for other consumers
  // (in-flight panel), but this page no longer renders the dollar figure.
  itemizedRevenue: number;
  itemizedOrders: number;
  itemizedUnits: number;
  pendingAmazonTotalRevenue: number;
  pendingAmazonTotalOrders: number;
  salesReportAdjustment: number;
  salesReportUnits: number;
  salesReportOrderItems: number;
  pendingUnknownOrders: number;
  syncedAt: string | null;
  knownTotal: number;            // itemizedRevenue + pendingAmazonTotalRevenue  = stats.totalRevenue
  // Drawer rows (cents). All sourced from today's purchase-basis data via /api/data/dashboard.
  // Promo, shipping-charged, and shipping-cost are NOT surfaced — the existing dashboard
  // endpoint doesn't expose them; they'll earn rows in a later phase if needed.
  estimatedFees: number;
  cogs: number;
  refundsTodayCount: number;
  refundsTodayNet: number;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [opsPulse, setOpsPulse] = useState<OpsPulse | null>(null);
  const [dailySales, setDailySales] = useState<DailySales | null>(null);
  const [loading, setLoading] = useState(true);
  const nowForDashboard = new Date();
  const dashboardMonthStart = toLocalDateString(new Date(nowForDashboard.getFullYear(), nowForDashboard.getMonth(), 1));
  const dashboardToday = toLocalDateString(nowForDashboard);

  // Ops Pulse: fixed-window operational cards, independent of the date picker.
  useEffect(() => {
    const today = toLocalDateString(new Date());
    const sevenDaysAgo = toLocalDateString(new Date(Date.now() - 6 * 86400000));
    const now = new Date();
    const monthStart = toLocalDateString(new Date(now.getFullYear(), now.getMonth(), 1));
    const daysSinceMonthStart = Math.max(
      1,
      Math.floor((now.getTime() - new Date(monthStart + 'T00:00:00').getTime()) / 86400000) + 1
    );

    Promise.all([
      fetch(`/api/data/dashboard?startDate=${today}&endDate=${today}&dateBasis=purchase`).then(r => r.json()),
      fetch(`/api/data/dashboard?startDate=${sevenDaysAgo}&endDate=${today}`).then(r => r.json()),
      fetch(`/api/data/merchant-sales?startDate=${sevenDaysAgo}&endDate=${today}`).then(r => r.json()),
      fetch(`/api/data/merchant-sales?openOnly=1`).then(r => r.json()),
      fetch(`/api/data/refunds?days=${daysSinceMonthStart}`).then(r => r.json()),
      fetch(`/api/list/batches`).then(r => r.json()),
    ])
      .then(([todayRes, week7dRes, mfn7dRes, openMfnRes, refundsRes, batchesRes]) => {
        const monthRefunds = (refundsRes.items || []).filter(
          (r: any) => r.refundDate >= monthStart
        );
        const mfnItems = mfn7dRes.items || [];
        const mfnEst = mfnItems.filter((i: any) => i.status === 'estimated');
        const mfnRec = mfnItems.filter((i: any) => i.status === 'reconciled');
        const openMfnItems = openMfnRes.items || [];
        const openMfnOrderIds = new Set(openMfnItems.map((i: any) => i.orderId));
        const mfnDraftBatches = (batchesRes.batches || []).filter(
          (b: any) => b.channel === 'MFN' && b.status === 'draft'
        );

        setOpsPulse({
          week7d: {
            revenue: week7dRes.stats?.totalRevenue ?? 0,
            profit: week7dRes.stats?.totalProfit ?? 0,
            prevRevenue: week7dRes.stats?.prevRevenue ?? 0,
            prevProfit: week7dRes.stats?.prevProfit ?? 0,
          },
          mfn7d: {
            estimated: {
              count: mfnEst.length,
              revenue: mfnEst.reduce((s: number, i: any) => s + (i.salePrice || 0), 0),
            },
            reconciled: {
              count: mfnRec.length,
              revenue: mfnRec.reduce((s: number, i: any) => s + (i.salePrice || 0), 0),
            },
          },
          returnsMonth: {
            count: monthRefunds.length,
            netImpact: monthRefunds.reduce((s: number, r: any) => s + (r.netImpact || 0), 0),
          },
          draftMfnBatches: { count: mfnDraftBatches.length },
          openMfnOrders: {
            count: openMfnOrderIds.size,
            revenue: openMfnItems.reduce((s: number, i: any) => s + (i.salePrice || 0) + (i.shippingCharged || 0), 0),
          },
        });

        // ─── Daily Sales composition ─────────────────────────────────────
        // Headline = reported Amazon dollars: itemized rows plus order-level totals
        // for orders whose item detail has not landed yet.
        const stats = todayRes.stats || {};
        const inRange = todayRes.inFlight?.pendingInRange || {};

        const totalRevenue = stats.totalRevenue ?? 0;
        const totalOrders  = stats.totalOrders  ?? 0;
        const totalUnits   = stats.totalUnits   ?? 0;

        const placeholderRevenue = inRange.placeholderRevenue ?? 0;
        const placeholderOrders  = inRange.placeholderOrders  ?? 0;
        const unknownOrders      = inRange.unknownOrders      ?? 0;
        const pulseRevenue       = todayRes.salesPulse?.orderedProductSales ?? 0;
        const pulseUnits         = todayRes.salesPulse?.unitsOrdered ?? 0;
        const pulseOrderItems    = todayRes.salesPulse?.orderItems ?? 0;

        const itemizedRevenue = totalRevenue - placeholderRevenue;
        const itemizedOrders  = totalOrders  - placeholderOrders;
        // Each PENDING placeholder row carries quantity=1 (per orders.ts sync).
        const itemizedUnits   = totalUnits   - placeholderOrders;

        const knownTotal = Math.max(totalRevenue, pulseRevenue);
        const salesReportAdjustment = Math.max(0, knownTotal - totalRevenue);

        // Drawer rows. stats.totalCogs and stats.totalFees are today-scoped already
        // and are itemized-only by construction (PENDING placeholders have no
        // cogs_per_unit and no fee_details rows tied to them).
        const cogs = stats.totalCogs ?? 0;
        const estimatedFees = stats.totalFees ?? 0;

        // Today's refunds — refundDate's date portion === today.
        const todayRefunds = (refundsRes.items || []).filter(
          (r: any) => (r.refundDate || '').slice(0, 10) === today
        );

        setDailySales({
          itemizedRevenue,
          itemizedOrders,
          itemizedUnits,
          pendingAmazonTotalRevenue: placeholderRevenue,
          pendingAmazonTotalOrders: placeholderOrders,
          salesReportAdjustment,
          salesReportUnits: pulseUnits,
          salesReportOrderItems: pulseOrderItems,
          pendingUnknownOrders: unknownOrders,
          syncedAt: todayRes.salesPulse?.syncedAt ?? null,
          knownTotal,
          estimatedFees,
          cogs,
          refundsTodayCount: todayRefunds.length,
          refundsTodayNet: todayRefunds.reduce((s: number, r: any) => s + (r.netImpact || 0), 0),
        });
      })
      .catch(err => console.error('Ops pulse fetch failed', err));
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/data/profitloss?startDate=${dashboardMonthStart}&endDate=${dashboardToday}&dateBasis=purchase&summaryOnly=1`);
      const json = await res.json();
      setData({
        stats: {
          totalRevenue: json.income?.total || 0,
          totalProfit: json.netProfit || 0,
          totalUnits: json.unitSummary?.units || 0,
          totalOrders: json.unitSummary?.orders || 0,
          totalCogs: json.expenses?.cogs || 0,
          totalFees: json.expenses?.totalFees || 0,
          serviceFees: 0,
          roi: (json.expenses?.cogs || 0) > 0 ? ((json.netProfit || 0) / json.expenses.cogs) * 100 : 0,
          prevRevenue: 0,
          prevProfit: 0,
          prevUnits: 0,
          prevRoi: 0,
        },
        dailyRevenue: (json.dailySummary || []).map((row: any) => ({
          day: row.day,
          revenue: row.revenue || 0,
          profit: row.profit || 0,
          grouping: 'daily',
        })),
      });
    } catch (err) {
      console.error('Failed to load dashboard:', err);
    }
    setLoading(false);
  }, [dashboardMonthStart, dashboardToday]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading || !data) {
    return <DashboardSkeleton />;
  }

  const { stats, dailyRevenue } = data;

  const chartGrouping = dailyRevenue[0]?.grouping || 'daily';
  const chartData = dailyRevenue.map(d => {
    const date = new Date(d.day + 'T00:00:00');
    let label: string;
    if (chartGrouping === 'monthly') {
      label = date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    } else if (chartGrouping === 'weekly') {
      label = 'Wk ' + date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else {
      label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return {
      day: label,
      rawDate: d.day,
      revenue: centsToDollars(d.revenue),
      profit: centsToDollars(d.profit),
    };
  });

  const compactCurrency = (cents: number) => {
    const value = Math.abs(cents) / 100;
    const sign = cents < 0 ? '-' : '';
    if (value >= 1000) return `${sign}$${(value / 1000).toFixed(1)}K`;
    return `${sign}$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  };
  const dailyBars = [
    ...chartData.slice(-5).map(d => ({
      label: d.day.replace(/^May /, ''),
      value: Math.max(0, d.revenue),
    })),
    { label: 'Today', value: centsToDollars(dailySales?.knownTotal || 0) },
  ];
  const mfnTotal = (opsPulse?.mfn7d.estimated.revenue || 0) + (opsPulse?.mfn7d.reconciled.revenue || 0);
  const pnlFees = stats.totalFees;
  const grossProfit = stats.totalRevenue - stats.totalCogs - pnlFees;
  const margin = stats.totalRevenue > 0 ? (stats.totalProfit / stats.totalRevenue) * 100 : 0;
  const monthRangeLabel = `${new Date(dashboardMonthStart + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${new Date(dashboardToday + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  const MiniBars = ({ bars, color = 'bg-positive' }: { bars: { label: string; value: number }[]; color?: string }) => (
    <div className="mt-5 flex h-24 items-end gap-2">
      {(() => {
        const maxBar = Math.max(1, ...bars.map(b => b.value));
        return bars.map((bar, i) => (
          <div key={`${bar.label}-${i}`} className="flex flex-1 flex-col items-center gap-2">
            <div
              className={`w-full rounded-t ${color}`}
              style={{ height: `${Math.max(12, (bar.value / maxBar) * 86)}px` }}
            />
            <div className="text-[11px] font-medium text-text-tertiary">{bar.label}</div>
          </div>
        ));
      })()}
    </div>
  );

  const DonutStub = ({ color = 'border-amazon' }: { color?: string }) => (
    <div className={`h-28 w-28 rounded-full border-[16px] ${color} border-r-bg-elevated`} />
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <div className="flex items-center gap-2">
          <button onClick={fetchData} className="h-10 w-10 rounded-lg border border-border-default bg-bg-elevated text-accent hover:bg-bg-hover">↻</button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Link
          href="/bookkeep/fba-sales"
          className="rounded-lg border border-border-default bg-bg-surface p-5 hover:border-positive/60 transition-colors"
        >
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-semibold text-text-secondary">Daily Sales</div>
              <div className="mt-2 text-3xl font-bold font-mono text-text-primary">{formatCurrency(dailySales?.knownTotal || 0)}</div>
              <div className="mt-1 text-sm text-text-tertiary">
                {formatNumber(dailySales?.salesReportOrderItems || 0)} orders/items · updated {relativeTime(dailySales?.syncedAt)}
              </div>
            </div>
            <div className="grid h-11 w-11 place-items-center rounded-full bg-positive/20 text-positive text-xl">$</div>
          </div>
          <MiniBars bars={dailyBars} />
        </Link>

        <Link href="/bookkeep/refunds" className="rounded-lg border border-border-default bg-bg-surface p-5 hover:border-negative/60 transition-colors">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-semibold text-negative">Monthly Returns</div>
              <div className="mt-2 text-3xl font-bold font-mono text-text-primary">{formatCurrency(Math.abs(opsPulse?.returnsMonth.netImpact || 0))}</div>
              <div className="mt-1 text-sm text-text-tertiary">{formatNumber(opsPulse?.returnsMonth.count || 0)} returns this month</div>
            </div>
            <div className="grid h-11 w-11 place-items-center rounded-full bg-negative/20 text-negative text-xl">↩</div>
          </div>
          <MiniBars bars={[
            { label: 'Dec', value: 8 },
            { label: 'Jan', value: 1 },
            { label: 'Feb', value: 1 },
            { label: 'Mar', value: 1 },
            { label: 'Apr', value: 1 },
            { label: 'May', value: Math.max(1, opsPulse?.returnsMonth.count || 0) },
          ]} color="bg-negative" />
        </Link>

        <Link href="/bookkeep/merchant-sales" className="rounded-lg border border-border-default bg-bg-surface p-5 hover:border-amazon/60 transition-colors">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-semibold text-amazon">Open MFN Orders</div>
              <div className="mt-2 text-3xl font-bold font-mono text-text-primary">{formatNumber(opsPulse?.openMfnOrders.count || 0)}</div>
              <div className="mt-1 text-sm text-text-tertiary">{formatCurrency(opsPulse?.openMfnOrders.revenue || 0)} awaiting shipment</div>
            </div>
            <div className="grid h-11 w-11 place-items-center rounded-full bg-amazon/20 text-amazon text-xl">▣</div>
          </div>
          <div className="mt-6 flex items-center justify-between gap-5">
            <DonutStub color="border-amazon" />
            <div className="flex-1 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-text-tertiary">Amazon</span><span className="font-mono text-text-primary">{opsPulse?.openMfnOrders.count || 0}</span></div>
              <div className="flex justify-between"><span className="text-text-tertiary">Shopify</span><span className="font-mono text-text-primary">0</span></div>
              <div className="flex justify-between"><span className="text-text-tertiary">Walmart</span><span className="font-mono text-text-primary">0</span></div>
              <div className="flex justify-between"><span className="text-text-tertiary">eBay</span><span className="font-mono text-text-primary">0</span></div>
            </div>
          </div>
        </Link>

        <Link href="/bookkeep/merchant-sales?preset=7d" className="rounded-lg border border-border-default bg-bg-surface p-5 hover:border-accent/60 transition-colors">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-semibold text-accent">MFN Sales by Channels</div>
              <div className="mt-2 text-3xl font-bold font-mono text-text-primary">{formatCurrency(mfnTotal)}</div>
              <div className="mt-1 text-sm text-text-tertiary">
                {formatNumber((opsPulse?.mfn7d.estimated.count || 0) + (opsPulse?.mfn7d.reconciled.count || 0))} orders · last 7 days
              </div>
            </div>
            <div className="grid h-11 w-11 place-items-center rounded-full bg-accent/20 text-accent text-xl">◔</div>
          </div>
          <div className="mt-6 flex items-center justify-between gap-5">
            <DonutStub color="border-amazon" />
            <div className="flex-1 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-text-tertiary">Amazon</span><span className="font-mono font-semibold text-text-primary">{formatCurrency(mfnTotal)}</span></div>
              <div className="flex justify-between"><span className="text-text-tertiary">Walmart</span><span className="font-mono font-semibold text-text-primary">$0.00</span></div>
              <div className="flex justify-between"><span className="text-text-tertiary">Shopify</span><span className="font-mono font-semibold text-text-primary">$0.00</span></div>
              <div className="flex justify-between"><span className="text-text-tertiary">eBay</span><span className="font-mono font-semibold text-text-primary">$0.00</span></div>
            </div>
          </div>
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Link href="/analyze/profitloss" className="rounded-lg border border-border-default bg-bg-surface p-5 hover:border-accent/60 transition-colors">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <div className="text-sm font-semibold text-accent">Monthly Profit & Loss</div>
              <div className="mt-1 text-sm text-text-tertiary">{monthRangeLabel}</div>
            </div>
            <div className="rounded-full bg-accent/20 px-3 py-1 text-xs font-semibold text-accent">Details</div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg bg-bg-elevated p-4">
              <div className="space-y-4">
                <div className="flex justify-between border-l-4 border-positive pl-3"><span>Total Sales</span><span className="font-mono text-positive">{compactCurrency(stats.totalRevenue)}</span></div>
                <div className="flex justify-between border-l-4 border-amazon pl-3"><span>COGS</span><span className="font-mono text-negative">{compactCurrency(stats.totalCogs)}</span></div>
                <div className="flex justify-between border-l-4 border-negative pl-3"><span>Platform Fees</span><span className="font-mono text-negative">{compactCurrency(pnlFees)}</span></div>
                <div className="border-t border-border-subtle pt-3">
                  <div className="flex justify-between"><span className="font-semibold">Gross Profit</span><span className="font-mono text-positive">{compactCurrency(grossProfit)}</span></div>
                  <div className="mt-2 flex justify-between"><span className="font-semibold">Net Profit</span><span className={`font-mono ${stats.totalProfit >= 0 ? 'text-positive' : 'text-negative'}`}>{compactCurrency(stats.totalProfit)}</span></div>
                </div>
              </div>
            </div>
            <div className="grid gap-3">
              <div className="rounded-lg bg-accent/10 p-4">
                <div className="text-sm text-text-tertiary">Total Items Sold</div>
                <div className="mt-2 text-xl font-bold font-mono text-accent">{formatNumber(stats.totalUnits)}</div>
              </div>
              <div className="rounded-lg bg-accent/10 p-4">
                <div className="text-sm text-text-tertiary">Orders</div>
                <div className="mt-2 text-xl font-bold font-mono text-accent">{formatNumber(stats.totalOrders)}</div>
              </div>
              <div className="rounded-lg bg-accent/10 p-4">
                <div className="text-sm text-text-tertiary">ROI / Margin</div>
                <div className="mt-2 text-xl font-bold font-mono text-accent">{stats.roi.toFixed(1)}% / {margin.toFixed(1)}%</div>
              </div>
            </div>
          </div>
        </Link>
      </div>
    </div>
  );

}

function DashboardSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="skeleton h-6 w-32 mb-2" />
          <div className="skeleton h-4 w-56" />
        </div>
        <div className="skeleton h-9 w-40" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-bg-surface border border-border-subtle rounded-lg p-5">
            <div className="skeleton h-3 w-20 mb-3" />
            <div className="skeleton h-8 w-28" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2 bg-bg-surface border border-border-subtle rounded-lg p-5">
          <div className="skeleton h-4 w-32 mb-4" />
          <div className="skeleton h-[280px] w-full" />
        </div>
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-5">
          <div className="skeleton h-4 w-36 mb-4" />
          <div className="skeleton h-[280px] w-full" />
        </div>
      </div>
    </div>
  );
}
