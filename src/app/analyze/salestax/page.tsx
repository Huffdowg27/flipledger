'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatNumber } from '@/lib/formatters';

interface TaxRow {
  state: string;
  taxCollected: number;
  facilitatorTax: number;
  total: number;
}

export default function SalesTaxPage() {
  const [rows, setRows] = useState<TaxRow[]>([]);
  const [totals, setTotals] = useState<{ totalCollected: number; totalFacilitator: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/salestax?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.rows || []);
    setTotals(data.totals || null);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo<ColumnDef<TaxRow, any>[]>(() => [
    { id: 'state', header: 'State', accessorKey: 'state', cell: ({ getValue }) => <span className="text-text-primary font-medium">{getValue() as string}</span>, size: 100 },
    { id: 'taxCollected', header: 'Tax Collected', accessorKey: 'taxCollected', cell: ({ getValue }) => <span className="font-mono text-text-primary">{formatCurrency(getValue() as number)}</span>, size: 140 },
    { id: 'facilitatorTax', header: 'Marketplace Facilitator Tax', accessorKey: 'facilitatorTax', cell: ({ getValue }) => <span className="font-mono text-text-secondary">{formatCurrency(getValue() as number)}</span>, size: 200 },
    { id: 'total', header: 'Total', accessorKey: 'total', cell: ({ getValue }) => <span className="font-mono font-medium text-text-primary">{formatCurrency(getValue() as number)}</span>, size: 140 },
  ], []);

  function handleExport() {
    const headers = ['State', 'Tax Collected', 'Marketplace Facilitator Tax', 'Total'];
    const csvRows = rows.map(r => [r.state, (r.taxCollected / 100).toFixed(2), (r.facilitatorTax / 100).toFixed(2), (r.total / 100).toFixed(2)].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'sales-tax.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-32" /><div className="skeleton h-[400px] w-full" /></div>;

  const footerRow = totals ? {
    state: <span className="text-text-primary font-semibold">Totals</span>,
    taxCollected: <span className="font-mono">{formatCurrency(totals.totalCollected)}</span>,
    facilitatorTax: <span className="font-mono">{formatCurrency(totals.totalFacilitator)}</span>,
    total: <span className="font-mono font-semibold">{formatCurrency(totals.totalCollected + totals.totalFacilitator)}</span>,
  } : undefined;

  return (
    <div>
      <PageHeader title="Sales Tax" subtitle="Analyze > Sales Tax" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} onExport={handleExport} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <StatCard label="Total Tax Collected" value={totals?.totalCollected || 0} format="currency" />
        <StatCard label="Marketplace Facilitator Tax" value={totals?.totalFacilitator || 0} format="currency" />
        <StatCard label="States" value={rows.length} format="number" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by state..." footerRow={footerRow} />
    </div>
  );
}
