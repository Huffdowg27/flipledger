'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate, formatNumber } from '@/lib/formatters';

interface RemovalRow {
  removalOrderId: string;
  asin: string;
  sku: string;
  productName: string;
  quantity: number;
  removalType: string;
  reason: string;
  status: string;
  dateRequested: string;
  dateCompleted: string | null;
  fee: number;
}

export default function RemovalsPage() {
  const [rows, setRows] = useState<RemovalRow[]>([]);
  const [totals, setTotals] = useState<{ totalRemovals: number; totalFee: number; totalQuantity: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/removals?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.items || data.rows || []);
    setTotals(data.totals || null);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo<ColumnDef<RemovalRow, any>[]>(() => [
    { id: 'dateRequested', header: 'Date', accessorKey: 'dateRequested', cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary">{formatDate(getValue() as string)}</span>, size: 120 },
    { id: 'removalOrderId', header: 'Removal ID', accessorKey: 'removalOrderId', cell: ({ getValue }) => <span className="font-mono text-sm text-accent">{getValue() as string}</span>, size: 140 },
    {
      id: 'product', header: 'Product', accessorFn: (row) => row.productName || row.asin,
      cell: ({ row }) => (
        <div>
          <div className="text-sm text-text-primary truncate max-w-[200px]">{row.original.productName || row.original.asin}</div>
          <div className="text-xs text-text-tertiary font-mono">{row.original.asin}</div>
        </div>
      ), size: 220,
    },
    { id: 'quantity', header: 'Qty', accessorKey: 'quantity', cell: ({ getValue }) => <span className="font-mono">{getValue() as number}</span>, size: 60 },
    {
      id: 'removalType', header: 'Type', accessorKey: 'removalType',
      cell: ({ getValue }) => {
        const v = getValue() as string;
        return <span className={`text-xs font-medium px-2 py-0.5 rounded ${v === 'Return' ? 'bg-accent-muted text-accent' : 'bg-negative-muted text-negative'}`}>{v}</span>;
      }, size: 90,
    },
    { id: 'reason', header: 'Reason', accessorKey: 'reason', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string}</span>, size: 130 },
    {
      id: 'status', header: 'Status', accessorKey: 'status',
      cell: ({ getValue }) => {
        const v = getValue() as string;
        return <span className={`text-xs font-medium px-2 py-0.5 rounded ${v === 'Completed' ? 'bg-positive-muted text-positive' : 'bg-warning-muted text-warning'}`}>{v}</span>;
      }, size: 100,
    },
    { id: 'fee', header: 'Fee', accessorKey: 'fee', cell: ({ getValue }) => <span className="font-mono text-negative">{formatCurrency(getValue() as number)}</span>, size: 90 },
  ], []);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-32" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Removals" subtitle="Analyze > Removals" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <StatCard label="Total Removals" value={totals?.totalRemovals || 0} format="number" />
        <StatCard label="Total Units Removed" value={totals?.totalQuantity || 0} format="number" />
        <StatCard label="Total Fees" value={totals?.totalFee || 0} format="currency" accentColor="negative" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by product, ASIN, or removal ID..." />
    </div>
  );
}
