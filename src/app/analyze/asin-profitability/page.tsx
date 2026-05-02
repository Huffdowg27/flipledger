'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatPercent, formatNumber } from '@/lib/formatters';

interface ProfitRow {
  groupKey: string;
  productName: string;
  asin: string;
  category: string;
  supplierName: string;
  orders: number;
  unitsSold: number;
  unitsPerOrder: number;
  refunds: number;
  unitsPerRefund: number;
  revenue: number;
  fees: number;
  cogs: number;
  costPerUnit: number;
  profit: number;
  roi: number;
  margin: number;
  onHand: number;
  shippingCharged: number;
  shippingCost: number;
}

interface Totals {
  orders: number;
  unitsSold: number;
  revenue: number;
  fees: number;
  cogs: number;
  profit: number;
  refunds: number;
  onHand: number;
  roi: number;
  margin: number;
  costPerUnit: number;
}

export default function ASINProfitabilityPage() {
  const [rows, setRows] = useState<ProfitRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/profitability?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}&marketplace=amazon&groupBy=asin`);
    const data = await res.json();
    setRows(data.rows || []);
    setTotals(data.totals || null);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo<ColumnDef<ProfitRow, any>[]>(() => [
    {
      id: 'productName',
      header: 'Product',
      accessorFn: (row) => row.productName || row.asin,
      cell: ({ row }) => (
        <div className="min-w-[250px]">
          <div className="text-sm text-text-primary" title={row.original.productName}>{row.original.productName || row.original.asin}</div>
          <div className="text-xs text-text-tertiary font-mono">{row.original.asin}</div>
        </div>
      ),
      size: 300,
    },
    {
      id: 'supplier',
      header: 'Supplier',
      accessorKey: 'supplierName',
      cell: ({ getValue }) => <span className="text-text-secondary text-sm">{getValue() as string || '—'}</span>,
      size: 100,
    },
    {
      id: 'orders',
      header: 'Orders',
      accessorKey: 'orders',
      cell: ({ getValue }) => <span className="font-mono text-text-primary">{formatNumber(getValue() as number)}</span>,
      size: 80,
    },
    {
      id: 'unitsSold',
      header: 'Units Sold',
      accessorKey: 'unitsSold',
      cell: ({ getValue }) => <span className="font-mono text-text-primary">{formatNumber(getValue() as number)}</span>,
      size: 90,
    },
    {
      id: 'refunds',
      header: 'Refunds',
      accessorKey: 'refunds',
      cell: ({ getValue }) => <span className="font-mono text-text-secondary">{getValue() as number}</span>,
      size: 70,
    },
    {
      id: 'revenue',
      header: 'Revenue',
      accessorKey: 'revenue',
      cell: ({ getValue }) => <span className="font-mono text-text-primary">{formatCurrency(getValue() as number)}</span>,
      size: 110,
    },
    {
      id: 'costPerUnit',
      header: 'Cost/Unit',
      accessorKey: 'costPerUnit',
      cell: ({ getValue }) => <span className="font-mono text-text-secondary">{formatCurrency(getValue() as number)}</span>,
      size: 100,
    },
    {
      id: 'fees',
      header: 'Fees',
      accessorKey: 'fees',
      cell: ({ getValue }) => <span className="font-mono text-negative">{formatCurrency(getValue() as number)}</span>,
      size: 100,
    },
    {
      id: 'onHand',
      header: 'On Hand',
      accessorKey: 'onHand',
      cell: ({ getValue }) => <span className="font-mono text-text-secondary">{formatNumber(getValue() as number)}</span>,
      size: 80,
    },
    {
      id: 'profit',
      header: 'Profit',
      accessorKey: 'profit',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`font-mono font-medium ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(v)}</span>;
      },
      size: 110,
    },
    {
      id: 'roi',
      header: 'ROI %',
      accessorKey: 'roi',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`font-mono ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(v)}</span>;
      },
      size: 80,
    },
    {
      id: 'margin',
      header: 'Margin %',
      accessorKey: 'margin',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`font-mono ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(v)}</span>;
      },
      size: 80,
    },
  ], []);

  function handleExport() {
    const headers = ['Product', 'ASIN', 'Supplier', 'Orders', 'Units Sold', 'Refunds', 'Revenue', 'Cost/Unit', 'Fees', 'On Hand', 'Profit', 'ROI %', 'Margin %'];
    const csvRows = rows.map(r => [
      `"${r.productName}"`, r.asin, r.supplierName, r.orders, r.unitsSold, r.refunds,
      (r.revenue / 100).toFixed(2), (r.costPerUnit / 100).toFixed(2), (r.fees / 100).toFixed(2),
      r.onHand, (r.profit / 100).toFixed(2), r.roi.toFixed(1), r.margin.toFixed(1),
    ].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'asin-profitability.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <ProfitSkeleton title="ASIN Profitability" />;

  const footerRow = totals ? {
    productName: <span className="text-text-primary font-semibold">Totals</span>,
    orders: <span className="font-mono">{formatNumber(totals.orders)}</span>,
    unitsSold: <span className="font-mono">{formatNumber(totals.unitsSold)}</span>,
    refunds: <span className="font-mono">{totals.refunds}</span>,
    revenue: <span className="font-mono">{formatCurrency(totals.revenue)}</span>,
    costPerUnit: <span className="font-mono">{formatCurrency(totals.costPerUnit)}</span>,
    fees: <span className="font-mono text-negative">{formatCurrency(totals.fees)}</span>,
    onHand: <span className="font-mono">{formatNumber(totals.onHand)}</span>,
    profit: <span className={`font-mono font-medium ${totals.profit >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(totals.profit)}</span>,
    roi: <span className={`font-mono ${totals.roi >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(totals.roi)}</span>,
    margin: <span className={`font-mono ${totals.margin >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(totals.margin)}</span>,
  } : undefined;

  return (
    <div>
      <PageHeader
        title="ASIN Profitability"
        subtitle="Analyze > ASIN Profitability"
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        onExport={handleExport}
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard label="Total Revenue" value={totals?.revenue || 0} format="currency" />
        <StatCard label="Total Profit" value={totals?.profit || 0} format="currency" accentColor={(totals?.profit || 0) >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Units Sold" value={totals?.unitsSold || 0} format="number" />
        <StatCard label="Avg ROI" value={totals?.roi || 0} format="percent" accentColor={(totals?.roi || 0) >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Inventory Value" value={totals ? totals.onHand * totals.costPerUnit : 0} format="currency" accentColor="amazon" />
      </div>

      <DataTable
        data={rows}
        columns={columns}
        searchPlaceholder="Search by product name, ASIN, or supplier..."
        footerRow={footerRow}
      />
    </div>
  );
}

function ProfitSkeleton({ title }: { title: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div><div className="skeleton h-6 w-48 mb-2" /><div className="skeleton h-4 w-64" /></div>
        <div className="flex gap-2"><div className="skeleton h-9 w-40" /><div className="skeleton h-9 w-24" /></div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-bg-surface border border-border-subtle rounded-lg p-5">
            <div className="skeleton h-3 w-20 mb-3" /><div className="skeleton h-8 w-28" />
          </div>
        ))}
      </div>
      <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton h-10 w-full mb-1" />)}
      </div>
    </div>
  );
}
