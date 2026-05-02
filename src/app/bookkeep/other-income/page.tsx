'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate } from '@/lib/formatters';

interface IncomeRow { date: string; incomeType: string; amount: number; description: string; }

export default function OtherIncomePage() {
  const [rows, setRows] = useState<IncomeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/other-income?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.items || data.rows || []);
    setTotal(data.totalIncome || 0);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo<ColumnDef<IncomeRow, any>[]>(() => [
    { id: 'date', header: 'Date', accessorKey: 'date', cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary">{formatDate(getValue() as string)}</span>, size: 120 },
    { id: 'incomeType', header: 'Type', accessorKey: 'incomeType', cell: ({ getValue }) => <span className="text-sm text-text-primary">{getValue() as string}</span>, size: 180 },
    { id: 'amount', header: 'Amount', accessorKey: 'amount', cell: ({ getValue }) => <span className="font-mono text-positive">{formatCurrency(getValue() as number)}</span>, size: 120 },
    { id: 'description', header: 'Description', accessorKey: 'description', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string}</span>, size: 300 },
  ], []);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-32" /><div className="skeleton h-[300px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Other Income" subtitle="Bookkeeping > Other Income" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} />
      <div className="grid grid-cols-2 gap-4 mb-6">
        <StatCard label="Total Entries" value={rows.length} format="number" />
        <StatCard label="Total Other Income" value={total} format="currency" accentColor="positive" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by type or description..." />
    </div>
  );
}
