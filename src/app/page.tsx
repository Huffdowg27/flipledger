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
  const [incomingStats, setIncomingStats] = useState<any | null>(null);
  // Tier-1 dashboard modularity: saved card order + hidden set, persisted to
  // settings.dashboard_layout. Defaults are filled in at render from the
  // registry, so new cards added later show up automatically.
  const [layout, setLayout] = useState<{ order: string[]; hidden: string[] }>({ order: [], hidden: [] });
  const [customizing, setCustomizing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const saveLayout = useCallback((next: { order: string[]; hidden: string[] }) => {
    setLayout(next);
    fetch('/api/data/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dashboard_layout: JSON.stringify(next) }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/data/settings')
      .then((r) => r.json())
      .then((d) => {
        const raw = d?.settings?.dashboard_layout;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            setLayout({ order: parsed.order || [], hidden: parsed.hidden || [] });
          } catch { /* ignore malformed */ }
        }
      })
      .catch(() => {});
  }, []);
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
    // Purchases strip — independent fetch, never blocks the P&L tiles.
    fetch('/api/incoming')
      .then((r) => r.json())
      .then((d) => { if (d?.stats) setIncomingStats(d.stats); })
      .catch(() => {});
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

  // Pull fresh data on demand instead of waiting for the hourly auto-sync.
  // Kicks the Amazon full sync (orders incl. MFN, finances, inventory) +
  // Airtable purchases ("what's been bought"), plus Walmart/eBay only if
  // they've synced before. Polls until the marketplace runners go idle, then
  // re-reads the dashboard. Respects the existing in-process overlap guards —
  // a sync already running just gets polled, not re-fired.
  const pullFreshData = useCallback(async () => {
    setSyncing(true);
    setSyncMsg('Starting sync…');
    try {
      const status = await fetch('/api/sync/status').then((r) => r.json()).catch(() => null);
      const jobBy = (key: string) => status?.jobs?.find((j: any) => j.key === key);
      const amazonRunning = status?.live?.amazon?.running;

      // Fire the marketplace + purchases syncs (best-effort, non-blocking).
      const fires: Promise<unknown>[] = [];
      if (!amazonRunning) {
        fires.push(fetch('/api/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lookbackDays: 14 }),
        }).catch(() => {}));
      }
      fires.push(fetch('/api/sync/airtable-purchases', { method: 'POST' }).catch(() => {}));
      // Only fire Walmart/eBay if they've run before (i.e. configured/in use).
      if (jobBy('walmart_last_sync')?.lastAttemptAt && !status?.live?.walmart?.running) {
        fires.push(fetch('/api/sync/walmart', { method: 'POST' }).catch(() => {}));
      }
      if (jobBy('ebay_last_sync')?.lastAttemptAt && !status?.live?.ebay?.running) {
        fires.push(fetch('/api/sync/ebay', { method: 'POST' }).catch(() => {}));
      }
      await Promise.all(fires);
      setSyncMsg('Syncing… orders, MFN, purchases');

      // Poll until the marketplace runners are idle (cap ~4 min).
      const start = Date.now();
      while (Date.now() - start < 4 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 4000));
        const s = await fetch('/api/sync/status').then((r) => r.json()).catch(() => null);
        const anyRunning = s?.live?.amazon?.running || s?.live?.walmart?.running || s?.live?.ebay?.running;
        if (!anyRunning) break;
      }

      await fetchData();
      setSyncMsg('Up to date');
      setTimeout(() => setSyncMsg(null), 4000);
    } catch {
      setSyncMsg('Sync failed — check the Sync page');
    }
    setSyncing(false);
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

  // ── Profit-target pace ────────────────────────────────────────────────────
  // One monthly target; day and week derived from it. Week/month pace is
  // pro-rated by how far into the period we are, so "ahead/behind" reflects
  // expected-to-date, not the full-period goal. Returns a small line per card.
  function pace(period: 'today' | 'week' | 'month', actualCents: number): { text: string; tone: string } | null {
    const monthly = incomingStats?.profitTargetMonthlyCents || 0;
    if (!monthly) return null;
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dailyTarget = monthly / daysInMonth;
    const fmtShort = (c: number) => formatCurrency(Math.round(c));

    if (period === 'today') {
      const pct = dailyTarget > 0 ? Math.round((actualCents / dailyTarget) * 100) : 0;
      return { text: `${pct}% of ${fmtShort(dailyTarget)}/day`, tone: actualCents >= dailyTarget ? 'text-positive' : 'text-text-tertiary' };
    }

    // Elapsed fraction of the period (today counts as in-progress).
    const elapsed = period === 'week'
      ? (now.getDay() + 1) / 7
      : now.getDate() / daysInMonth;
    const periodTarget = period === 'week' ? monthly * 7 / daysInMonth : monthly;
    const expectedToDate = periodTarget * elapsed;
    const projected = elapsed > 0 ? actualCents / elapsed : 0;
    const delta = actualCents - expectedToDate;
    const ahead = delta >= 0;
    return {
      text: `${ahead ? 'ahead' : 'behind'} ${fmtShort(Math.abs(delta))} · on pace ${fmtShort(projected)} of ${fmtShort(periodTarget)}`,
      tone: ahead ? 'text-positive' : 'text-warning',
    };
  }

  // ── Card registry — each entry is a self-contained dashboard tile ──────────
  // span 1 = quarter-width stat tile; 'full' = full-width section.
  const cardRegistry: { id: string; label: string; span: 1 | 'full'; node: React.ReactNode }[] = [
    {
      id: 'daily-sales', label: 'Daily Sales', span: 1, node: (
        <Link
          href="/bookkeep/fba-sales"
          className="block h-full rounded-lg border border-border-default bg-bg-surface p-5 hover:border-positive/60 transition-colors"
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
      ) },
    {
      id: 'monthly-returns', label: 'Monthly Returns', span: 1, node: (
        <Link href="/bookkeep/refunds" className="block h-full rounded-lg border border-border-default bg-bg-surface p-5 hover:border-negative/60 transition-colors">
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
      ) },
    {
      id: 'open-mfn', label: 'Open MFN Orders', span: 1, node: (
        <Link href="/mfn/orders" className="block h-full rounded-lg border border-border-default bg-bg-surface p-5 hover:border-amazon/60 transition-colors">
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
      ) },
    {
      id: 'mfn-channels', label: 'MFN Sales by Channels', span: 1, node: (
        <Link href="/bookkeep/merchant-sales?preset=7d" className="block h-full rounded-lg border border-border-default bg-bg-surface p-5 hover:border-accent/60 transition-colors">
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
      ) },
    {
      id: 'purchases', label: 'Purchases & Incoming', span: 'full', node: !incomingStats ? (
        <Link href="/incoming" className="block rounded-lg border border-border-default bg-bg-surface p-5 hover:border-accent/60 transition-colors text-sm text-text-tertiary">
          Purchases &amp; Incoming — no data yet. Sync from Airtable on the Incoming page.
        </Link>
      ) : (
        <Link href="/incoming" className="block rounded-lg border border-border-default bg-bg-surface p-5 hover:border-accent/60 transition-colors">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-text-secondary">Purchases &amp; Incoming</div>
            <div className="rounded-full bg-accent/20 px-3 py-1 text-xs font-semibold text-accent">Receive →</div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            {[
              { label: 'Bought today', main: formatCurrency(incomingStats.purchasedToday.cents), sub: `${incomingStats.purchasedToday.units} units · profit est. ${formatCurrency(incomingStats.purchasedToday.profitCents)}`, pace: pace('today', incomingStats.purchasedToday.profitCents) },
              { label: 'This week', main: formatCurrency(incomingStats.purchasedWeek.cents), sub: `${incomingStats.purchasedWeek.units} units · profit est. ${formatCurrency(incomingStats.purchasedWeek.profitCents)}`, pace: pace('week', incomingStats.purchasedWeek.profitCents) },
              { label: 'This month', main: formatCurrency(incomingStats.purchasedMonth.cents), sub: `${incomingStats.purchasedMonth.units} units · profit est. ${formatCurrency(incomingStats.purchasedMonth.profitCents)}`, pace: pace('month', incomingStats.purchasedMonth.profitCents) },
              { label: 'On order', main: formatCurrency(incomingStats.onOrderCents), sub: `${incomingStats.onOrderUnits} units incoming` },
              { label: `Over ${incomingStats.overdueDays} days`, main: String(incomingStats.overdueCount), sub: `${formatCurrency(incomingStats.overdueCents)} at risk`, alert: incomingStats.overdueCount > 0 },
              { label: 'Open issues', main: String(incomingStats.openIssuesCount), sub: `${formatCurrency(incomingStats.openIssuesCents)} unresolved`, alert: incomingStats.openIssuesCount > 0 },
            ].map((c: any) => (
              <div key={c.label} className={`rounded-lg bg-bg-elevated p-3 border-t-2 ${c.alert ? 'border-t-amber-400' : 'border-t-accent/50'}`}>
                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">{c.label}</div>
                <div className={`text-xl font-bold font-mono ${c.alert ? 'text-amber-400' : 'text-text-primary'}`}>{c.main}</div>
                <div className="text-[11px] text-text-tertiary mt-0.5">{c.sub}</div>
                {c.pace && <div className={`text-[11px] mt-0.5 ${c.pace.tone}`}>{c.pace.text}</div>}
              </div>
            ))}
          </div>
        </Link>
      ) },
    {
      id: 'pnl', label: 'Monthly Profit & Loss', span: 'full', node: (
        <Link href="/analyze/profitloss" className="block rounded-lg border border-border-default bg-bg-surface p-5 hover:border-accent/60 transition-colors">
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
      ) },
  ];

  // Resolve display order: saved order first (only ids that still exist), then
  // any registry cards not in the saved order (newly added). Hidden removed.
  const byId = new Map(cardRegistry.map((c) => [c.id, c]));
  const orderedIds = [
    ...layout.order.filter((id) => byId.has(id)),
    ...cardRegistry.filter((c) => !layout.order.includes(c.id)).map((c) => c.id),
  ];
  const hiddenSet = new Set(layout.hidden);
  const visibleCards = orderedIds.map((id) => byId.get(id)!).filter((c) => !hiddenSet.has(c.id));

  function moveCard(id: string, dir: -1 | 1) {
    const idx = orderedIds.indexOf(id);
    const swap = idx + dir;
    if (swap < 0 || swap >= orderedIds.length) return;
    const next = [...orderedIds];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    saveLayout({ order: next, hidden: layout.hidden });
  }

  function toggleHidden(id: string) {
    const hidden = hiddenSet.has(id) ? layout.hidden.filter((h) => h !== id) : [...layout.hidden, id];
    saveLayout({ order: orderedIds, hidden });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <div className="flex items-center gap-2">
          {syncMsg && <span className="text-xs text-text-tertiary mr-1">{syncMsg}</span>}
          <button
            onClick={pullFreshData}
            disabled={syncing}
            className="h-10 rounded-lg border border-accent bg-accent/15 px-4 text-sm font-medium text-accent hover:bg-accent/25 transition-colors disabled:opacity-60 flex items-center gap-2"
            title="Sync orders, MFN, and purchases from Amazon + Airtable now"
          >
            <span className={syncing ? 'inline-block animate-spin' : ''}>⟳</span>
            {syncing ? 'Pulling…' : 'Pull fresh data'}
          </button>
          <button
            onClick={() => setCustomizing((v) => !v)}
            className={`h-10 rounded-lg border px-4 text-sm font-medium transition-colors ${customizing ? 'border-accent bg-accent/15 text-accent' : 'border-border-default bg-bg-elevated text-text-secondary hover:bg-bg-hover'}`}
          >
            {customizing ? 'Done' : 'Customize'}
          </button>
          <button onClick={fetchData} disabled={syncing} title="Re-read the dashboard (no sync)" className="h-10 w-10 rounded-lg border border-border-default bg-bg-elevated text-accent hover:bg-bg-hover disabled:opacity-60">↻</button>
        </div>
      </div>

      {customizing && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
          <div className="mb-3 text-sm font-semibold text-text-secondary">Show, hide, and reorder cards</div>
          <div className="space-y-2">
            {orderedIds.map((id, i) => {
              const card = byId.get(id)!;
              const isHidden = hiddenSet.has(id);
              return (
                <div key={id} className="flex items-center gap-3 rounded-lg bg-bg-surface px-3 py-2">
                  <button onClick={() => toggleHidden(id)} className={`text-sm ${isHidden ? 'text-text-tertiary' : 'text-positive'}`} title={isHidden ? 'Hidden — click to show' : 'Visible — click to hide'}>
                    {isHidden ? '☐' : '☑'}
                  </button>
                  <span className={`flex-1 text-sm ${isHidden ? 'text-text-tertiary line-through' : 'text-text-primary'}`}>{card.label}</span>
                  <span className="text-[11px] text-text-tertiary">{card.span === 'full' ? 'full width' : 'stat tile'}</span>
                  <button onClick={() => moveCard(id, -1)} disabled={i === 0} className="h-7 w-7 rounded border border-border-default text-text-secondary hover:bg-bg-hover disabled:opacity-30">↑</button>
                  <button onClick={() => moveCard(id, 1)} disabled={i === orderedIds.length - 1} className="h-7 w-7 rounded border border-border-default text-text-secondary hover:bg-bg-hover disabled:opacity-30">↓</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {visibleCards.map((card) => (
          <div key={card.id} className={card.span === 'full' ? 'md:col-span-2 xl:col-span-4' : ''}>
            {card.node}
          </div>
        ))}
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
