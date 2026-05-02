'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate, formatNumber } from '@/lib/formatters';

interface ReimbRow {
  reimbursementDate: string;
  reimbursementId: string;
  asin: string;
  sku: string;
  productName: string;
  reason: string;
  amount: number;
  quantity: number;
  status: string;
  // Searchable but not displayed — see DataTable's globalFilterFn
  orderId?: string | null;
  customerOrderId?: string | null;
}

export default function ReimbursementsPage() {
  const [rows, setRows] = useState<ReimbRow[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/reimbursements?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.items || data.rows || []);
    setTotals(data.totals || null);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo<ColumnDef<ReimbRow, any>[]>(() => [
    { id: 'date', header: 'Date', accessorKey: 'date', cell: ({ getValue }) => { const v = getValue() as string; return <span className="font-mono text-sm text-text-secondary">{v ? formatDate(v) : '—'}</span>; }, size: 110 },
    {
      id: 'marketplace', header: '', accessorKey: 'marketplace',
      cell: ({ getValue }) => {
        const m = getValue() as string;
        return m === 'walmart'
          ? <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">WMT</span>
          : <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amazon/15 text-amazon">AMZ</span>;
      }, size: 45,
    },
    { id: 'reimbursementId', header: 'Reimb. ID', accessorKey: 'reimbursementId', cell: ({ getValue }) => {
      const id = getValue() as string;
      return <span className="font-mono text-sm text-accent">{id}</span>;
    }, size: 120 },
    {
      id: 'product', header: 'Product', accessorFn: (row) => row.productName || row.asin,
      cell: ({ row }) => (
        <div><div className="text-sm text-text-primary truncate max-w-[200px]">{row.original.productName || row.original.asin}</div><div className="text-xs text-text-tertiary font-mono">{row.original.asin}</div></div>
      ), size: 220,
    },
    { id: 'reason', header: 'Reason', accessorKey: 'reason', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string}</span>, size: 180 },
    { id: 'amount', header: 'Amount', accessorKey: 'amount', cell: ({ getValue }) => <span className="font-mono font-medium text-positive">{formatCurrency(getValue() as number)}</span>, size: 110 },
    { id: 'quantity', header: 'Qty', accessorKey: 'quantity', cell: ({ getValue }) => <span className="font-mono">{getValue() as number}</span>, size: 60 },
    {
      id: 'status', header: 'Status', accessorKey: 'status',
      cell: ({ getValue }) => {
        const v = getValue() as string;
        const styles = v === 'Paid' ? 'bg-positive-muted text-positive' : v === 'Approved' ? 'bg-accent-muted text-accent' : 'bg-warning-muted text-warning';
        return <span className={`text-xs font-medium px-2 py-0.5 rounded ${styles}`}>{v}</span>;
      }, size: 90,
    },
  ], []);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-40" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Reimbursements" subtitle="Bookkeeping > Reimbursements" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} />
      <div className="grid grid-cols-2 gap-4 mb-6">
        <StatCard label="Total Reimbursements" value={totals?.count || 0} format="number" />
        <StatCard label="Total Amount" value={totals?.totalAmount || 0} format="currency" accentColor="positive" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by ID, product, reason, order #, SKU…" />
    </div>
  );
}
