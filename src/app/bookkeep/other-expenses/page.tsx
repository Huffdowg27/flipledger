'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate } from '@/lib/formatters';
import { Plus } from 'lucide-react';

interface ExpenseRow { id: number; date: string; category: string; amount: number; description: string; recurring: string; }

export default function OtherExpensesPage() {
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newExpense, setNewExpense] = useState({ date: new Date().toISOString().split('T')[0], category: 'Supplies', amount: '', description: '', recurring: 'one-time' });

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/other-expenses?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.items || data.rows || []);
    setTotals(data.totals || null);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleAddExpense() {
    if (!newExpense.amount) return;
    await fetch('/api/data/other-expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newExpense, amount: Math.round(parseFloat(newExpense.amount) * 100) }),
    });
    setShowAddForm(false);
    setNewExpense({ date: new Date().toISOString().split('T')[0], category: 'Supplies', amount: '', description: '', recurring: 'one-time' });
    fetchData();
  }

  const categories = ['Supplies', 'Mileage', 'Subscriptions', 'Storage', 'Packaging', 'Labels', 'Equipment', 'Insurance', 'Other'];

  const columns = useMemo<ColumnDef<ExpenseRow, any>[]>(() => [
    { id: 'date', header: 'Date', accessorKey: 'date', cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary">{formatDate(getValue() as string)}</span>, size: 120 },
    {
      id: 'category', header: 'Category', accessorKey: 'category',
      cell: ({ getValue }) => <span className="text-sm font-medium text-text-primary">{getValue() as string}</span>, size: 130,
    },
    { id: 'amount', header: 'Amount', accessorKey: 'amount', cell: ({ getValue }) => <span className="font-mono text-negative">{formatCurrency(getValue() as number)}</span>, size: 110 },
    { id: 'description', header: 'Description', accessorKey: 'description', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string}</span>, size: 300 },
    {
      id: 'recurring', header: 'Recurring', accessorKey: 'recurring',
      cell: ({ getValue }) => {
        const v = getValue() as string;
        return <span className={`text-xs font-medium px-2 py-0.5 rounded ${v === 'monthly' ? 'bg-accent-muted text-accent' : 'bg-bg-active text-text-tertiary'}`}>{v === 'monthly' ? 'Monthly' : 'One-time'}</span>;
      }, size: 90,
    },
  ], []);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-36" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Other Expenses" subtitle="Bookkeeping > Other Expenses" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} />

      <div className="grid grid-cols-2 gap-4 mb-6">
        <StatCard label="Total Expenses" value={totals?.totalExpenses || 0} format="currency" accentColor="negative" />
        <StatCard label="Total Entries" value={rows.length} format="number" />
      </div>

      {/* Add Expense Button */}
      <div className="mb-4">
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors"
        >
          <Plus size={14} />
          Add Expense
        </button>
      </div>

      {/* Add Expense Form */}
      {showAddForm && (
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-4 mb-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <input type="date" value={newExpense.date} onChange={e => setNewExpense(p => ({ ...p, date: e.target.value }))} className="h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary" />
            <select value={newExpense.category} onChange={e => setNewExpense(p => ({ ...p, category: e.target.value }))} className="h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary">
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="number" step="0.01" placeholder="Amount" value={newExpense.amount} onChange={e => setNewExpense(p => ({ ...p, amount: e.target.value }))} className="h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary" />
            <input type="text" placeholder="Description" value={newExpense.description} onChange={e => setNewExpense(p => ({ ...p, description: e.target.value }))} className="h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary" />
            <div className="flex gap-2">
              <select value={newExpense.recurring} onChange={e => setNewExpense(p => ({ ...p, recurring: e.target.value }))} className="h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary flex-1">
                <option value="one-time">One-time</option>
                <option value="monthly">Monthly</option>
              </select>
              <button onClick={handleAddExpense} className="h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors">Save</button>
            </div>
          </div>
        </div>
      )}

      <DataTable data={rows} columns={columns} searchPlaceholder="Search by category or description..." />
    </div>
  );
}
