'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatPercent, formatDate } from '@/lib/formatters';

interface MFNSaleRow {
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
}

export default function MerchantSalesPage() {
  const [rows, setRows] = useState<MFNSaleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/merchant-sales?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.items || data.rows || []);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalRevenue = rows.reduce((s, r) => s + r.salePrice, 0);
  const totalProfit = rows.reduce((s, r) => s + r.profit, 0);

  const columns = useMemo<ColumnDef<MFNSaleRow, any>[]>(() => [
    { id: 'date', header: 'Date', accessorKey: 'date', cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary">{formatDate(getValue() as string)}</span>, size: 110 },
    {
      id: 'order', header: 'Order Details', accessorFn: (row) => row.productName || row.orderId,
      cell: ({ row }) => (
        <div className="min-w-[200px]">
          <div className="text-sm font-mono text-accent">{row.original.orderId}</div>
          <div className="text-sm text-text-secondary truncate max-w-[250px]">{row.original.productName || row.original.asin}</div>
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
  ], []);

  function handleExport() {
    const headers = ['Date', 'Order ID', 'ASIN', 'Product', 'Sale Price', 'Ship Charged', 'Ship Cost', 'Profit', 'ROI %'];
    const csvRows = rows.map(r => [r.date.split('T')[0], r.orderId, r.asin, `"${r.productName}"`, (r.salePrice/100).toFixed(2), (r.shippingCharged/100).toFixed(2), (r.shippingCost/100).toFixed(2), (r.profit/100).toFixed(2), r.roiPercent.toFixed(1)].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'merchant-sales.csv'; a.click(); URL.revokeObjectURL(url);
  }

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-40" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Merchant Sales" subtitle="Bookkeeping > Merchant Sales (MFN)" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} onExport={handleExport} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Sales" value={rows.length} format="number" />
        <StatCard label="Total Revenue" value={totalRevenue} format="currency" />
        <StatCard label="Total Profit" value={totalProfit} format="currency" accentColor={totalProfit >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Total Ship Profit" value={rows.reduce((s, r) => s + r.shippingProfit, 0)} format="currency" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by order ID, ASIN, or product..." />
    </div>
  );
}
