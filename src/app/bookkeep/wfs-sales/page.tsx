'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatPercent, formatDate } from '@/lib/formatters';

interface SaleRow {
  date: string;
  orderId: string;
  asin: string;
  sku: string;
  productName: string;
  quantity: number;
  salePrice: number;
  buyCost: number;
  fees: number;
  profit: number;
  profitPercent: number;
  roiPercent: number;
  isEstimated: boolean;
}

export default function FBASalesPage() {
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [averages, setAverages] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/wfs-sales?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.items || data.rows || []);
    setAverages(data.averages || null);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalRevenue = rows.reduce((s, r) => s + r.salePrice, 0);
  const totalProfit = rows.reduce((s, r) => s + r.profit, 0);

  const columns = useMemo<ColumnDef<SaleRow, any>[]>(() => [
    { id: 'date', header: 'Date', accessorKey: 'date', cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary">{formatDate(getValue() as string)}</span>, size: 110 },
    {
      id: 'status', header: 'Status', accessorKey: 'isEstimated',
      cell: ({ getValue }) => getValue() ? <span className="text-xs font-medium px-2 py-0.5 rounded bg-warning-muted text-warning">Estimated</span> : <span className="text-xs font-medium px-2 py-0.5 rounded bg-positive-muted text-positive">Reconciled</span>,
      size: 90,
    },
    {
      id: 'order', header: 'Order Details', accessorFn: (row) => row.productName || row.orderId,
      cell: ({ row }) => (
        <div className="min-w-[200px]">
          <div className="text-sm font-mono text-accent">{row.original.orderId}</div>
          <div className="text-sm text-text-secondary truncate max-w-[250px]">{row.original.productName || row.original.asin}</div>
          {row.original.quantity > 1 && <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-bg-active text-xs font-mono text-text-secondary mt-0.5">{row.original.quantity}</span>}
        </div>
      ), size: 280,
    },
    { id: 'salePrice', header: 'Order Price', accessorKey: 'salePrice', cell: ({ getValue }) => <span className="font-mono text-text-primary">{formatCurrency(getValue() as number)}</span>, size: 110 },
    {
      id: 'buyCost', header: 'Buy Cost', accessorKey: 'buyCost',
      cell: ({ getValue }) => <span className="font-mono text-negative">{formatCurrency(-(getValue() as number))}</span>,
      size: 100,
    },
    { id: 'fees', header: 'Fees', accessorKey: 'fees', cell: ({ getValue }) => <span className="font-mono text-negative">{formatCurrency(getValue() as number)}</span>, size: 90 },
    {
      id: 'profit', header: 'Net Profit', accessorKey: 'profit',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`font-mono font-medium ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(v)}</span>;
      }, size: 110,
    },
    {
      id: 'profitPercent', header: 'Margin', accessorKey: 'profitPercent',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`font-mono ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(v)}</span>;
      }, size: 80,
    },
    {
      id: 'roiPercent', header: 'ROI', accessorKey: 'roiPercent',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`font-mono ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(v)}</span>;
      }, size: 80,
    },
  ], []);

  function handleExport() {
    const headers = ['Date', 'Order ID', 'ASIN', 'SKU', 'Product', 'Qty', 'Sale Price', 'Buy Cost', 'Fees', 'Profit', 'Margin %', 'ROI %'];
    const csvRows = rows.map(r => [
      r.date.split('T')[0], r.orderId, r.asin, r.sku, `"${r.productName}"`, r.quantity,
      (r.salePrice / 100).toFixed(2), (r.buyCost / 100).toFixed(2), (r.fees / 100).toFixed(2),
      (r.profit / 100).toFixed(2), r.profitPercent.toFixed(1), r.roiPercent.toFixed(1),
    ].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'wfs-sales.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-32" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="WFS Sales" subtitle="Bookkeeping > WFS Sales" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} onExport={handleExport} />
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard label="Total Sales" value={rows.length} format="number" />
        <StatCard label="Total Revenue" value={totalRevenue} format="currency" />
        <StatCard label="Total Profit" value={totalProfit} format="currency" accentColor={totalProfit >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Avg Profit/Sale" value={averages?.avgProfit || 0} format="currency" />
        <StatCard label="Avg ROI" value={averages?.avgRoi || 0} format="percent" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by order ID, ASIN, or product name..." />
    </div>
  );
}
