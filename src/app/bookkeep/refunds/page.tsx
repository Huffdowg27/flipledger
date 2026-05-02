'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate } from '@/lib/formatters';

interface RefundRow {
  refundDate: string;
  orderId: string;
  asin: string;
  sku: string;
  productName: string;
  refundAmount: number;
  reason: string;
  itemReturned: boolean;
  feeClawback: number;
  netImpact: number;
}

export default function RefundsPage() {
  const [rows, setRows] = useState<RefundRow[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/refunds?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.items || data.rows || []);
    setTotals(data.totals || null);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo<ColumnDef<RefundRow, any>[]>(() => [
    { id: 'refundDate', header: 'Date', accessorKey: 'refundDate', cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary">{formatDate(getValue() as string)}</span>, size: 110 },
    {
      id: 'marketplace', header: '', accessorKey: 'marketplace',
      cell: ({ getValue }) => {
        const m = getValue() as string;
        return m === 'walmart'
          ? <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">WMT</span>
          : <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amazon/15 text-amazon">AMZ</span>;
      }, size: 45,
    },
    { id: 'orderId', header: 'Order ID', accessorKey: 'orderId', cell: ({ getValue }) => <span className="font-mono text-sm text-accent">{getValue() as string}</span>, size: 180 },
    {
      id: 'product', header: 'Product', accessorFn: (row) => row.productName || row.asin,
      cell: ({ row }) => (
        <div><div className="text-sm text-text-primary truncate max-w-[200px]">{row.original.productName || row.original.asin}</div><div className="text-xs text-text-tertiary font-mono">{row.original.asin}</div></div>
      ), size: 230,
    },
    { id: 'refundAmount', header: 'Refund Amount', accessorKey: 'refundAmount', cell: ({ getValue }) => <span className="font-mono text-negative">{formatCurrency(getValue() as number)}</span>, size: 120 },
    { id: 'reason', header: 'Reason', accessorKey: 'reason', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string}</span>, size: 150 },
    {
      id: 'itemReturned', header: 'Returned?', accessorKey: 'itemReturned',
      cell: ({ getValue }) => getValue() ? <span className="text-xs font-medium px-2 py-0.5 rounded bg-positive-muted text-positive">Yes</span> : <span className="text-xs font-medium px-2 py-0.5 rounded bg-negative-muted text-negative">No</span>,
      size: 80,
    },
    { id: 'feeClawback', header: 'Fee Clawback', accessorKey: 'feeClawback', cell: ({ getValue }) => <span className="font-mono text-positive">{formatCurrency(getValue() as number)}</span>, size: 110 },
    {
      id: 'netImpact', header: 'Net Impact', accessorKey: 'netImpact',
      cell: ({ getValue }) => <span className="font-mono font-medium text-negative">{formatCurrency(getValue() as number)}</span>,
      size: 110,
    },
  ], []);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-32" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Refunds" subtitle="Bookkeeping > Refunds" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Refunds" value={totals?.count || 0} format="number" />
        <StatCard label="Total Refund Amount" value={totals?.totalRefundAmount || 0} format="currency" accentColor="negative" />
        <StatCard label="Total Fee Clawbacks" value={totals?.totalClawback || 0} format="currency" accentColor="positive" />
        <StatCard label="Net Impact" value={totals?.totalNetImpact || 0} format="currency" accentColor="negative" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by order ID, product, or reason..." />
    </div>
  );
}
