'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import StatusBadge from '@/components/ui/StatusBadge';
import { formatCurrency, formatPercent, formatDate } from '@/lib/formatters';
import { Info } from 'lucide-react';

interface MFNSaleRow {
  soldDate: string;
  postedDate: string | null;
  status: 'reconciled' | 'estimated';
  date: string;
  orderId: string;
  asin: string;
  sku: string;
  productName: string;
  quantity: number;
  salePrice: number;
  buyCost: number;
  fees: number;
  shippingCharged: number;
  shippingCost: number;
  shippingProfit: number;
  profit: number;
  profitPercent: number;
  roiPercent: number;
  isEstimated: boolean;
  marketplace?: string;
}

type StatusFilter = 'all' | 'estimated' | 'reconciled';

function amazonOrderUrl(orderId: string): string {
  return `https://sellercentral.amazon.com/orders-v3/order/${encodeURIComponent(orderId)}`;
}

export default function MerchantSalesPage() {
  const [rows, setRows] = useState<MFNSaleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/merchant-sales?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.items || data.rows || []);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const statusCounts = useMemo(() => ({
    all: rows.length,
    estimated: rows.filter((row) => row.status === 'estimated').length,
    reconciled: rows.filter((row) => row.status === 'reconciled').length,
  }), [rows]);

  const visibleRows = useMemo(() => (
    statusFilter === 'all'
      ? rows
      : rows.filter((row) => row.status === statusFilter)
  ), [rows, statusFilter]);

  const visibleTotals = useMemo(() => ({
    totalRevenue: visibleRows.reduce((s, r) => s + r.salePrice, 0),
    totalProfit: visibleRows.reduce((s, r) => s + r.profit, 0),
    totalShippingProfit: visibleRows.reduce((s, r) => s + r.shippingProfit, 0),
  }), [visibleRows]);

  const kpiLabels = {
    all: {
      sales: 'All Sales',
      revenue: 'All Revenue',
      profit: 'Est. + Reconciled Profit',
      shipProfit: 'All Ship Profit',
    },
    estimated: {
      sales: 'Estimated Sales',
      revenue: 'Estimated Revenue',
      profit: 'Estimated Profit',
      shipProfit: 'Est. Ship Profit',
    },
    reconciled: {
      sales: 'Reconciled Sales',
      revenue: 'Reconciled Revenue',
      profit: 'Reconciled Profit',
      shipProfit: 'Rec. Ship Profit',
    },
  }[statusFilter];

  const statusFilters: Array<{ id: StatusFilter; label: string; count: number; help: string }> = [
    {
      id: 'all',
      label: 'All',
      count: statusCounts.all,
      help: 'All merchant-fulfilled orders placed in this date range. Includes estimated recent orders and reconciled orders with posted Amazon financial events.',
    },
    {
      id: 'estimated',
      label: 'Estimated',
      count: statusCounts.estimated,
      help: 'Recent merchant-fulfilled orders that have not posted Amazon financial events yet. Fees and profit are operational estimates for same-day sales visibility.',
    },
    {
      id: 'reconciled',
      label: 'Reconciled',
      count: statusCounts.reconciled,
      help: 'Merchant-fulfilled orders with posted Amazon shipment financial events. These rows are cleaner for accounting review and reconciliation.',
    },
  ];

  const columns = useMemo<ColumnDef<MFNSaleRow, any>[]>(() => [
    {
      id: 'date', header: 'Date',
      accessorFn: (row) => row.soldDate || row.date,
      cell: ({ row }) => (
        <div className="font-mono text-sm">
          <div className="text-text-secondary">{formatDate(row.original.soldDate || row.original.date)}</div>
          {row.original.status === 'reconciled' && row.original.postedDate && (
            <div className="text-[10px] text-text-tertiary">settled {formatDate(row.original.postedDate)}</div>
          )}
        </div>
      ),
      size: 130,
    },
    {
      id: 'status', header: 'Status', accessorKey: 'status',
      cell: ({ row }) => row.original.status === 'reconciled'
        ? <StatusBadge tone="positive">Reconciled</StatusBadge>
        : <StatusBadge tone="warning">Estimated</StatusBadge>,
      size: 90,
    },
    {
      id: 'order', header: 'Order Details', accessorFn: (row) => row.productName || row.orderId,
      cell: ({ row }) => (
        <div className="min-w-[200px]">
          {row.original.marketplace === 'amazon' ? (
            <a
              href={amazonOrderUrl(row.original.orderId)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-mono text-accent hover:underline"
              title="Open in Seller Central"
            >
              {row.original.orderId}
            </a>
          ) : (
            <div className="text-sm font-mono text-accent">{row.original.orderId}</div>
          )}
          <div className="text-sm text-text-secondary truncate max-w-[250px]">{row.original.productName || row.original.asin}</div>
          {row.original.quantity > 1 && <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-bg-active text-xs font-mono text-text-secondary mt-0.5">{row.original.quantity}</span>}
        </div>
      ), size: 280,
    },
    { id: 'salePrice', header: 'Order Price', accessorKey: 'salePrice', cell: ({ getValue }) => <span className="font-mono text-text-primary">{formatCurrency(getValue() as number)}</span>, size: 100 },
    { id: 'shippingCharged', header: 'Ship Charged', accessorKey: 'shippingCharged', cell: ({ getValue }) => <span className="font-mono text-text-secondary">{formatCurrency(getValue() as number)}</span>, size: 100 },
    { id: 'shippingCost', header: 'Ship Cost', accessorKey: 'shippingCost', cell: ({ getValue }) => <span className="font-mono text-negative">{formatCurrency(getValue() as number)}</span>, size: 100 },
    {
      id: 'shippingProfit', header: 'Ship Profit', accessorKey: 'shippingProfit',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`font-mono ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(v)}</span>;
      }, size: 100,
    },
    {
      id: 'profit', header: 'Net Profit', accessorKey: 'profit',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`font-mono font-medium ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(v)}</span>;
      }, size: 100,
    },
    { id: 'roiPercent', header: 'ROI', accessorKey: 'roiPercent', cell: ({ getValue }) => { const v = getValue() as number; return <span className={`font-mono ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(v)}</span>; }, size: 80 },
    // Margin = profit / sale price (profitPercent from the route). Shown alongside ROI per operator preference.
    { id: 'profitPercent', header: 'Margin', accessorKey: 'profitPercent', cell: ({ getValue }) => { const v = getValue() as number; return <span className={`font-mono ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(v)}</span>; }, size: 80 },
  ], []);

  function handleExport() {
    const headers = ['Sold Date', 'Posted Date', 'Status', 'Order ID', 'ASIN', 'SKU', 'Product', 'Sale Price', 'Ship Charged', 'Ship Cost', 'Profit', 'ROI %', 'Margin %'];
    const csvRows = visibleRows.map(r => [
      (r.soldDate || r.date).split('T')[0],
      r.postedDate ? r.postedDate.split('T')[0] : '',
      r.status,
      r.orderId,
      r.asin,
      r.sku,
      `"${r.productName}"`,
      (r.salePrice/100).toFixed(2),
      (r.shippingCharged/100).toFixed(2),
      (r.shippingCost/100).toFixed(2),
      (r.profit/100).toFixed(2),
      r.roiPercent.toFixed(1),
      r.profitPercent.toFixed(1),
    ].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'merchant-sales.csv'; a.click(); URL.revokeObjectURL(url);
  }

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-40" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Merchant Sales" subtitle="Bookkeeping > Merchant Sales (MFN)" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} onExport={handleExport} />
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {statusFilters.map((filter) => {
          const active = statusFilter === filter.id;
          return (
            <div key={filter.id} className="relative group">
              <button
                type="button"
                onClick={() => setStatusFilter(filter.id)}
                className={`flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors ${
                  active
                    ? 'border-accent/60 bg-accent/15 text-accent'
                    : 'border-border-subtle bg-bg-elevated text-text-secondary hover:border-border-default hover:bg-bg-hover hover:text-text-primary'
                }`}
              >
                <span>{filter.label}</span>
                <span className="font-mono text-[11px] opacity-80">{filter.count.toLocaleString()}</span>
                <Info size={11} className="shrink-0 opacity-45" />
              </button>
              <div className="absolute left-0 top-full z-50 mt-2 w-72 rounded-md border border-border-default bg-bg-elevated p-2.5 text-left text-xs leading-relaxed text-text-secondary opacity-0 shadow-lg transition-opacity duration-150 pointer-events-none group-hover:opacity-100">
                {filter.help}
              </div>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label={kpiLabels.sales} value={visibleRows.length} format="number" />
        <StatCard label={kpiLabels.revenue} value={visibleTotals.totalRevenue} format="currency" />
        <StatCard label={kpiLabels.profit} value={visibleTotals.totalProfit} format="currency" accentColor={visibleTotals.totalProfit >= 0 ? 'positive' : 'negative'} />
        <StatCard label={kpiLabels.shipProfit} value={visibleTotals.totalShippingProfit} format="currency" />
      </div>
      <DataTable data={visibleRows} columns={columns} searchPlaceholder="Search by order ID, ASIN, or product..." />
    </div>
  );
}
