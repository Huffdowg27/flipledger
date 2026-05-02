'use client';

import { useEffect, useState, useCallback } from 'react';
import StatCard from '@/components/ui/StatCard';
import DateRangePicker, { type DateRange } from '@/components/ui/DateRangePicker';
import MarketplaceFilter from '@/components/ui/MarketplaceFilter';
import { useFilters } from '@/lib/useFilters';
import { formatCurrency, centsToDollars, formatNumber } from '@/lib/formatters';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend
} from 'recharts';

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
  topProducts: { name: string; asin: string; category: string; revenue: number; unitsSold: number; cogs: number; fees?: number }[];
  worstProducts: { name: string; asin: string; category: string; revenue: number; unitsSold: number; cogs: number; fees?: number }[];
  expenseBreakdown: { category: string; total: number }[];
  inventoryValue: { totalValue: number; totalUnits: number };
  inFlight?: {
    pending: { orders: number; revenueReported: number; revenueEstimate: number; avgOrderValue: number };
    shippedNotPosted: { orders: number; revenue: number; cogs: number; projectedProfit: number; earliestRelease: string | null; latestRelease: string | null };
  };
}

const CHART_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#f97316'];

interface DayDetail {
  order_id: string;
  marketplace: string;
  product_name: string;
  sku: string;
  quantity: number;
  revenue: number;
  cogs: number;
  gross_profit: number;
  posted_date: string;
}

interface CashBalance {
  latest: {
    marketplace: string;
    postedDate: string;
    currentReserveCents: number;
    previousReserveCents: number;
    deltaCents: number;
  } | null;
  history: { postedDate: string; currentReserveCents: number; previousReserveCents: number }[];
  pendingSinceLastReserveCents: number;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [cashBalance, setCashBalance] = useState<CashBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [dayDetails, setDayDetails] = useState<DayDetail[]>([]);
  const [dayRefunds, setDayRefunds] = useState<any[]>([]);
  const [dayDetailsLoading, setDayDetailsLoading] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showInFlight, setShowInFlight] = useState(false);
  const [inFlightItems, setInFlightItems] = useState<any[]>([]);
  const [inFlightLoading, setInFlightLoading] = useState(false);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam, dateBasis, setDateBasis, dateBasisParam } = useFilters();

  // Cash balance is independent of date range / marketplace filter — always
  // shows the latest snapshot from Amazon settlement reports.
  useEffect(() => {
    fetch('/api/data/cash-balance')
      .then(r => r.json())
      .then(setCashBalance)
      .catch(() => {});
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/data/dashboard?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}${dateBasisParam}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Failed to load dashboard:', err);
    }
    setLoading(false);
  }, [dateRange, marketplaceParam, dateBasisParam]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!selectedDay) { setDayDetails([]); setDayRefunds([]); return; }
    setDayDetailsLoading(true);
    // For monthly grouping (YYYY-MM-01), fetch the whole month
    // For weekly grouping, fetch 7 days
    // For daily, fetch single day
    let fetchStart = selectedDay;
    let fetchEnd = selectedDay;
    const grouping = dailyRevenue[0]?.grouping || 'daily';
    if (grouping === 'monthly') {
      // selectedDay = "2026-03-01", fetch Mar 1 - Mar 31
      const d = new Date(selectedDay + 'T00:00:00');
      fetchStart = selectedDay;
      fetchEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
    } else if (grouping === 'weekly') {
      const d = new Date(selectedDay + 'T00:00:00');
      const end = new Date(d.getTime() + 6 * 86400000);
      fetchEnd = end.toISOString().split('T')[0];
    }
    fetch(`/api/data/profitloss?startDate=${fetchStart}&endDate=${fetchEnd}${marketplaceParam}`)
      .then(r => r.json())
      .then(d => {
        // Group by product (sku + marketplace), sum quantities and amounts
        const grouped: Record<string, any> = {};
        for (const item of (d.salesDetail || [])) {
          const key = `${item.sku || item.asin}-${item.marketplace}`;
          if (!grouped[key]) {
            grouped[key] = { ...item };
          } else {
            grouped[key].quantity += item.quantity;
            grouped[key].revenue += item.revenue;
            grouped[key].cogs += item.cogs;
            grouped[key].gross_profit += item.gross_profit;
          }
        }
        const sales = Object.values(grouped).sort((a: any, b: any) => b.gross_profit - a.gross_profit);
        setDayDetails(sales);
        setDayRefunds(d.refundDetail || []);
        setDayDetailsLoading(false);
      })
      .catch(() => setDayDetailsLoading(false));
  }, [selectedDay, marketplaceParam]);

  if (loading || !data) {
    return <DashboardSkeleton />;
  }

  const { stats, dailyRevenue, topProducts, worstProducts, expenseBreakdown, inventoryValue } = data;

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

  const donutData = expenseBreakdown
    .filter(e => e.total > 0)
    .map(e => ({
      name: e.category,
      value: centsToDollars(e.total),
    }));

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-text-tertiary mt-0.5">Overview of your business performance</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex h-9 rounded-md border border-border-default overflow-hidden text-sm">
            <button
              onClick={() => setDateBasis('posted')}
              className={`px-3 transition-colors ${
                dateBasis === 'posted'
                  ? 'bg-accent/15 text-accent font-medium'
                  : 'bg-bg-elevated text-text-secondary hover:bg-bg-hover'
              }`}
            >
              Cash
            </button>
            <button
              onClick={() => setDateBasis('purchase')}
              className={`px-3 border-l border-border-default transition-colors ${
                dateBasis === 'purchase'
                  ? 'bg-accent/15 text-accent font-medium'
                  : 'bg-bg-elevated text-text-secondary hover:bg-bg-hover'
              }`}
            >
              Accrual
            </button>
          </div>
          <MarketplaceFilter value={marketplace} onChange={setMarketplace} />
          <DateRangePicker
            value={dateRange}
            onChange={setDateRange}
          />
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard
          label="Total Revenue"
          value={stats.totalRevenue}
          previousValue={stats.prevRevenue}
          format="currency"
          accentColor="default"
        />
        <StatCard
          label="Total Profit"
          value={stats.totalProfit}
          previousValue={stats.prevProfit}
          format="currency"
          accentColor={stats.totalProfit >= 0 ? 'positive' : 'negative'}
        />
        <StatCard
          label="Units Sold"
          value={stats.totalUnits}
          previousValue={stats.prevUnits}
          format="number"
        />
        <StatCard
          label="ROI"
          value={stats.roi}
          previousValue={stats.prevRoi}
          format="percent"
          accentColor={stats.roi >= 0 ? 'positive' : 'negative'}
        />
        <StatCard
          label="Total COGS"
          value={stats.totalCogs}
          format="currency"
        />
      </div>

      {/* In-flight: orders earned but not yet in Cash-basis P&L */}
      {data.inFlight && (data.inFlight.pending.orders > 0 || data.inFlight.shippedNotPosted.orders > 0) && (
        <div className="mb-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] uppercase tracking-wider text-text-tertiary">Pending (estimated)</div>
              <div className="text-[10px] text-text-tertiary">{data.inFlight.pending.orders} orders</div>
            </div>
            <div className="text-2xl font-mono text-accent">
              ~{formatCurrency(data.inFlight.pending.revenueEstimate)}
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              {data.inFlight.pending.orders} × {formatCurrency(data.inFlight.pending.avgOrderValue)} (30d AOV).
              Amazon withholds line items until payment clears.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              const next = !showInFlight;
              setShowInFlight(next);
              if (next && inFlightItems.length === 0) {
                setInFlightLoading(true);
                fetch(`/api/data/in-flight-orders?marketplace=${marketplace === 'all' ? 'amazon' : marketplace}`)
                  .then(r => r.json())
                  .then(j => { setInFlightItems(j.items || []); setInFlightLoading(false); })
                  .catch(() => setInFlightLoading(false));
              }
            }}
            className="bg-bg-surface border border-border-subtle rounded-lg p-4 text-left hover:border-border-default transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] uppercase tracking-wider text-text-tertiary">Held under Delivery Date Policy</div>
              <div className="text-[10px] text-text-tertiary">{data.inFlight.shippedNotPosted.orders} orders ›</div>
            </div>
            <div className="text-2xl font-mono text-warning">
              {formatCurrency(data.inFlight.shippedNotPosted.revenue)}
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              ≈ {formatCurrency(data.inFlight.shippedNotPosted.projectedProfit)} projected profit
              {data.inFlight.shippedNotPosted.earliestRelease && data.inFlight.shippedNotPosted.latestRelease && (
                <> · releases {new Date(data.inFlight.shippedNotPosted.earliestRelease).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}–{new Date(data.inFlight.shippedNotPosted.latestRelease).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</>
              )}
            </div>
          </button>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="text-[11px] uppercase tracking-wider text-text-tertiary mb-1">Total expected to post</div>
            <div className="text-2xl font-mono text-text-primary">
              {formatCurrency(data.inFlight.pending.revenueEstimate + data.inFlight.shippedNotPosted.revenue)}
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              Revenue not yet in Cash view; will appear as orders settle
            </div>
          </div>
        </div>
      )}

      {/* Inline drill: per-order list of orders held under DDP */}
      {showInFlight && (
        <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden mb-6">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text-primary">Orders Held under Delivery Date Policy</span>
              <span className="text-xs text-text-tertiary">{inFlightItems.length} orders · sorted by release date</span>
            </div>
            <button onClick={() => setShowInFlight(false)} className="text-xs text-text-tertiary hover:text-text-secondary">✕ Close</button>
          </div>
          {inFlightLoading ? (
            <div className="p-4 text-sm text-text-tertiary">Loading...</div>
          ) : inFlightItems.length === 0 ? (
            <div className="p-4 text-sm text-text-tertiary">No orders held.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-bg-elevated">
                    <th className="px-4 py-2 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle">Product</th>
                    <th className="px-4 py-2 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-32">Order</th>
                    <th className="px-4 py-2 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-20">FC</th>
                    <th className="px-4 py-2 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Shipped</th>
                    <th className="px-4 py-2 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-32">Est. Release</th>
                    <th className="px-4 py-2 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-14">Qty</th>
                    <th className="px-4 py-2 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Revenue</th>
                    <th className="px-4 py-2 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Proj. Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {inFlightItems.map((item, i) => (
                    <tr key={`${item.orderId}-${item.sku}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2 text-sm">
                        <div className="text-text-primary font-medium truncate max-w-[280px]">{item.productName}</div>
                        <div className="text-[11px] text-text-tertiary font-mono">{item.sku || item.asin}</div>
                      </td>
                      <td className="px-4 py-2 text-[11px] font-mono text-text-tertiary">{item.orderId}</td>
                      <td className="px-4 py-2 text-[11px] text-text-secondary">{item.fulfillment}</td>
                      <td className="px-4 py-2 text-xs text-text-secondary">
                        {item.shippedAt ? new Date(item.shippedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <span className={item.daysUntilRelease === 0 ? 'text-positive font-medium' : 'text-text-secondary'}>
                          {new Date(item.expectedRelease).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                        <span className="text-text-tertiary ml-1">
                          ({item.daysUntilRelease === 0 ? 'releasing' : `${item.daysUntilRelease}d`})
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">{item.quantity}</td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-primary">{formatCurrency(item.revenue)}</td>
                      <td className={`px-4 py-2 text-right text-sm font-mono font-medium ${item.projectedProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {formatCurrency(item.projectedProfit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Amazon DD+7 cash balance — held vs pending */}
      {cashBalance?.latest && (
        <div className="mb-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] uppercase tracking-wider text-text-tertiary">Held in DD+7</div>
              <div className="text-[10px] text-text-tertiary">Amazon</div>
            </div>
            <div className="text-2xl font-mono text-warning">
              {formatCurrency(cashBalance.latest.currentReserveCents)}
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              Reserve as of {new Date(cashBalance.latest.postedDate).toLocaleDateString()}
              {cashBalance.latest.deltaCents !== 0 && (
                <span className={cashBalance.latest.deltaCents > 0 ? ' text-warning' : ' text-positive'}>
                  {' '}({cashBalance.latest.deltaCents > 0 ? '+' : ''}{formatCurrency(cashBalance.latest.deltaCents)} vs prev)
                </span>
              )}
            </div>
          </div>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="text-[11px] uppercase tracking-wider text-text-tertiary mb-1">Pending since last settlement</div>
            <div className="text-2xl font-mono text-accent">
              {formatCurrency(cashBalance.pendingSinceLastReserveCents)}
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              Sales settled since {new Date(cashBalance.latest.postedDate).toLocaleDateString()} — disburses next cycle
            </div>
          </div>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="text-[11px] uppercase tracking-wider text-text-tertiary mb-1">Total in transit</div>
            <div className="text-2xl font-mono text-text-primary">
              {formatCurrency(cashBalance.latest.currentReserveCents + cashBalance.pendingSinceLastReserveCents)}
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              Earned but not yet in your bank account
            </div>
          </div>
        </div>
      )}

      {/* Settlement fee note */}
      {stats.serviceFees > stats.totalRevenue * 0.3 && stats.serviceFees > 10000 && (
        <div className="mb-6 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-start gap-2">
          <span className="text-amber-400 text-sm mt-0.5">⚠</span>
          <p className="text-xs text-amber-200/80">
            <span className="font-medium text-amber-300">Settlement fees posted this period.</span>{' '}
            {formatCurrency(stats.serviceFees)} in service fees (storage, subscriptions, inbound shipping) posted in this date range.
            These fees may cover prior months and are batched by Amazon into settlement periods, making short date ranges appear less profitable than they actually are.
          </p>
        </div>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Revenue & Profit Chart */}
        <div className="lg:col-span-2 bg-bg-surface border border-border-subtle rounded-lg p-5">
          <h3 className="text-sm font-medium text-text-secondary mb-4">Revenue & Profit</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} barGap={2} style={{ cursor: 'pointer' }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e1e24" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#606070' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#606070' }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#18181c',
                  border: '1px solid #2a2a33',
                  borderRadius: '8px',
                  fontSize: '12px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                }}
                labelStyle={{ color: '#a0a0b0' }}
                cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                formatter={(value: any, name: any) => [`$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, name]}
              />
              <Bar dataKey="revenue" fill="#6366f1" radius={[4, 4, 0, 0]} name="Revenue"
                onClick={(data: any) => { if (data?.rawDate) setSelectedDay(data.rawDate); }}
              />
              <Bar dataKey="profit" fill="#22c55e" radius={[4, 4, 0, 0]} name="Profit"
                onClick={(data: any) => { if (data?.rawDate) setSelectedDay(data.rawDate); }}
              />
              <Legend wrapperStyle={{ fontSize: '11px', color: '#606070' }} iconType="circle" iconSize={8} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Expense Breakdown Donut */}
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-5">
          <h3 className="text-sm font-medium text-text-secondary mb-4">Expense Breakdown</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={donutData}
                cx="50%"
                cy="45%"
                innerRadius={55}
                outerRadius={85}
                paddingAngle={2}
                dataKey="value"
              >
                {donutData.map((_, index) => (
                  <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: '#18181c',
                  border: '1px solid #2a2a33',
                  borderRadius: '8px',
                  fontSize: '12px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                }}
                formatter={(value) => [`$${Number(value).toFixed(2)}`, '']}
              />
              <Legend
                layout="vertical"
                verticalAlign="bottom"
                wrapperStyle={{ fontSize: '10px', color: '#a0a0b0' }}
                iconType="circle"
                iconSize={6}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Day Detail Panel */}
      {selectedDay && (
        <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden mb-6">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text-primary">
                {chartGrouping === 'monthly'
                  ? new Date(selectedDay + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                  : chartGrouping === 'weekly'
                  ? `Week of ${new Date(selectedDay + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                  : new Date(selectedDay + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
              <span className="text-xs text-text-tertiary">
                {dayDetails.length} sale{dayDetails.length !== 1 ? 's' : ''}{dayRefunds.length > 0 ? ` · ${dayRefunds.length} return${dayRefunds.length !== 1 ? 's' : ''}` : ''}
              </span>
            </div>
            <button onClick={() => setSelectedDay(null)} className="text-xs text-text-tertiary hover:text-text-secondary">✕ Close</button>
          </div>
          {dayDetailsLoading ? (
            <div className="p-4 text-sm text-text-tertiary">Loading...</div>
          ) : dayDetails.length === 0 ? (
            <div className="p-4 text-sm text-text-tertiary">No sales on this day.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-bg-elevated">
                    <th className="px-4 py-2 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle">Product</th>
                    <th className="px-4 py-2 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-16">Mkt</th>
                    <th className="px-4 py-2 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-14">Qty</th>
                    <th className="px-4 py-2 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Revenue</th>
                    <th className="px-4 py-2 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">COGS</th>
                    <th className="px-4 py-2 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {dayDetails.map((item, i) => (
                    <tr key={`${item.order_id}-${item.sku}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2 text-sm">
                        <div className="text-text-primary font-medium truncate max-w-[300px]">{item.product_name}</div>
                        <div className="text-[11px] text-text-tertiary font-mono">{item.sku}</div>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                          item.marketplace === 'amazon' ? 'bg-orange-500/10 text-orange-400' :
                          item.marketplace === 'walmart' ? 'bg-blue-500/10 text-blue-400' :
                          item.marketplace === 'ebay' ? 'bg-green-500/10 text-green-400' :
                          item.marketplace === 'paypal' ? 'bg-cyan-500/10 text-cyan-400' :
                          'bg-purple-500/10 text-purple-400'
                        }`}>
                          {item.marketplace === 'amazon' ? 'AMZ' : item.marketplace === 'walmart' ? 'WMT' : item.marketplace === 'ebay' ? 'EBAY' : item.marketplace === 'paypal' ? 'PP' : (item.marketplace || '').toUpperCase()}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">{item.quantity}</td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-primary">{formatCurrency(item.revenue)}</td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-negative">{formatCurrency(-item.cogs)}</td>
                      <td className={`px-4 py-2 text-right text-sm font-mono font-medium ${item.gross_profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {formatCurrency(item.gross_profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Refunds for this day */}
          {dayRefunds.length > 0 && (
            <div className="border-t border-border-subtle">
              <div className="px-4 py-2 bg-bg-elevated">
                <span className="text-xs font-semibold text-negative uppercase tracking-wider">Returns ({dayRefunds.length})</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <tbody>
                    {dayRefunds.map((item: any, i: number) => (
                      <tr key={`refund-${item.order_id}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                        <td className="px-4 py-2 text-sm">
                          <div className="text-text-primary font-medium truncate max-w-[300px]">{item.product_name || item.asin || item.order_id}</div>
                          <div className="text-[11px] text-text-tertiary font-mono">{item.reason}</div>
                        </td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                            item.marketplace === 'amazon' ? 'bg-orange-500/10 text-orange-400' :
                            item.marketplace === 'walmart' ? 'bg-blue-500/10 text-blue-400' :
                            item.marketplace === 'ebay' ? 'bg-green-500/10 text-green-400' :
                            item.marketplace === 'paypal' ? 'bg-cyan-500/10 text-cyan-400' :
                            'bg-purple-500/10 text-purple-400'
                          }`}>
                            {item.marketplace === 'amazon' ? 'AMZ' : item.marketplace === 'walmart' ? 'WMT' : item.marketplace === 'ebay' ? 'EBAY' : item.marketplace === 'paypal' ? 'PP' : (item.marketplace || '').toUpperCase()}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">{item.quantity}</td>
                        <td className="px-4 py-2 text-right text-sm font-mono text-negative">{formatCurrency(-item.refund_amount)}</td>
                        <td className="px-4 py-2 text-right text-sm font-mono text-positive">{formatCurrency(item.fee_clawback)}</td>
                        <td className={`px-4 py-2 text-right text-sm font-mono font-medium text-negative`}>
                          {formatCurrency(-(item.refund_amount - item.fee_clawback))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Bottom Row: Top/Worst Products + Inventory */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Top Products */}
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-5">
          <h3 className="text-sm font-medium text-text-secondary mb-3">Top 5 Profitable</h3>
          <div className="space-y-2">
            {topProducts.map((p, i) => {
              const profit = p.revenue - p.cogs - (p.fees || 0);
              return (
                <div key={`top-${i}`} className="flex items-center gap-3 py-1.5">
                  <span className="text-xs font-mono text-text-tertiary w-4">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text-primary truncate">{p.name || p.asin}</div>
                    <div className="text-xs text-text-tertiary font-mono">{p.asin}</div>
                  </div>
                  <span className="text-sm font-mono text-positive shrink-0">
                    {formatCurrency(profit)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Worst Products */}
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-5">
          <h3 className="text-sm font-medium text-text-secondary mb-3">Bottom 5 Performers</h3>
          <div className="space-y-2">
            {worstProducts.map((p, i) => {
              const profit = p.revenue - p.cogs - (p.fees || 0);
              return (
                <div key={`worst-${i}`} className="flex items-center gap-3 py-1.5">
                  <span className="text-xs font-mono text-text-tertiary w-4">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text-primary truncate">{p.name || p.asin}</div>
                    <div className="text-xs text-text-tertiary font-mono">{p.asin}</div>
                  </div>
                  <span className={`text-sm font-mono shrink-0 ${profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                    {formatCurrency(profit)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Inventory Value */}
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-5 border-t-2 border-t-amazon">
          <h3 className="text-sm font-medium text-text-secondary mb-3">Inventory on Hand</h3>
          <div className="space-y-4">
            <div>
              <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-1">Total Value (COGS)</div>
              <div className="text-2xl font-bold font-mono text-text-primary">{formatCurrency(inventoryValue.totalValue)}</div>
            </div>
            <div>
              <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-1">Total Units</div>
              <div className="text-2xl font-bold font-mono text-text-primary">{formatNumber(inventoryValue.totalUnits)}</div>
            </div>
          </div>
        </div>
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
