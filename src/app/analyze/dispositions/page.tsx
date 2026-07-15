'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrencyParens, formatDate } from '@/lib/formatters';

interface DispRow {
  id: number;
  dispDate: string;
  type: string;
  refId: string;
  productName: string;
  msku: string;
  asin: string;
  azDisposition: string;
  sellableQty: number;
  unsellableQty: number;
  buyCostAdj: number; // signed cents
  editedAt: string | null;
  source: 'current' | 'historical';
}

interface Totals {
  count: number;
  restockReversalCents: number;
  writeoffCents: number;
  byType: Record<string, number>;
  bySource?: Record<string, number>;
}

type SourceFilter = 'all' | 'current' | 'historical';

const TYPE_STYLES: Record<string, string> = {
  'MFN Return': 'bg-accent-muted text-accent',
  Removal: 'bg-warning-muted text-warning',
  Liquidate: 'bg-negative-muted text-negative',
  Disposal: 'bg-negative-muted text-negative',
};

export default function DispositionsPage() {
  const [rows, setRows] = useState<DispRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const { dateRange, setDateRange } = useFilters('1y');

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/dispositions?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}`);
    const data = await res.json();
    setRows(data.items || []);
    setTotals(data.totals || null);
    setLoading(false);
  }, [dateRange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const visibleRows = useMemo(() => (
    sourceFilter === 'all' ? rows : rows.filter((row) => row.source === sourceFilter)
  ), [rows, sourceFilter]);

  const visibleTotals = useMemo(() => {
    const restock = visibleRows.filter(r => r.buyCostAdj > 0).reduce((s, r) => s + r.buyCostAdj, 0);
    const writeoff = visibleRows.filter(r => r.buyCostAdj < 0).reduce((s, r) => s + (-r.buyCostAdj), 0);
    return { count: visibleRows.length, restockReversalCents: restock, writeoffCents: writeoff };
  }, [visibleRows]);

  // Persist one field for a current row, optimistically updating local state.
  const saveField = useCallback(async (row: Pick<DispRow, 'id' | 'source'>, patch: Partial<{ sellableQty: number; unsellableQty: number; buyCostAdjCents: number }>) => {
    if (row.source !== 'current') return;
    const id = row.id;
    setSavingId(id);
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      return {
        ...r,
        sellableQty: patch.sellableQty ?? r.sellableQty,
        unsellableQty: patch.unsellableQty ?? r.unsellableQty,
        buyCostAdj: patch.buyCostAdjCents ?? r.buyCostAdj,
      };
    }));
    try {
      await fetch('/api/data/dispositions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...patch }),
      });
      // Recompute totals from the (now updated) rows.
      setRows(prev => { recomputeTotals(prev, setTotals); return prev; });
    } finally {
      setSavingId(null);
    }
  }, [rows]);

  const exportCsv = useCallback(() => {
    const header = ['Date', 'Source', 'Type', 'ID', 'Title', 'MSKU', 'ASIN', 'AZ Disposition?', 'SellableQty', 'UnsellableQty', 'Buy Cost Adj'];
    const lines = visibleRows.map(r => [
      r.dispDate, r.source, r.type, r.refId, `"${(r.productName || '').replace(/"/g, '""')}"`, r.msku, r.asin,
      r.azDisposition, r.sellableQty, r.unsellableQty, (r.buyCostAdj / 100).toFixed(2),
    ].join(','));
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `dispositions_${dateRange.startDate}_${dateRange.endDate}.csv`; a.click();
    URL.revokeObjectURL(url);
  }, [visibleRows, dateRange]);

  const columns = useMemo<ColumnDef<DispRow, any>[]>(() => [
    { id: 'dispDate', header: 'Date', accessorKey: 'dispDate', cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary">{formatDate(getValue() as string)}</span>, size: 110 },
    {
      id: 'type', header: 'Type', accessorKey: 'type',
      cell: ({ getValue }) => { const v = getValue() as string; return <span className={`text-xs font-medium px-2 py-0.5 rounded ${TYPE_STYLES[v] || 'bg-surface-muted text-text-secondary'}`}>{v}</span>; },
      size: 110,
    },
    {
      id: 'source', header: 'Source', accessorKey: 'source',
      cell: ({ getValue }) => {
        const source = getValue() as DispRow['source'];
        return <span className={`text-xs font-medium px-2 py-0.5 rounded ${source === 'current' ? 'bg-accent-muted text-accent' : 'bg-surface-muted text-text-secondary'}`}>{source}</span>;
      },
      size: 100,
    },
    { id: 'refId', header: 'ID', accessorKey: 'refId', cell: ({ getValue }) => <span className="font-mono text-xs text-accent truncate inline-block max-w-[120px]">{getValue() as string}</span>, size: 130 },
    {
      id: 'product', header: 'Product', accessorFn: (row) => row.productName,
      cell: ({ row }) => (
        <div>
          <div className="text-sm text-text-primary truncate max-w-[240px]">{row.original.productName}</div>
          <div className="text-xs text-text-tertiary font-mono truncate max-w-[240px]">{row.original.msku}</div>
        </div>
      ), size: 260,
    },
    {
      id: 'sellableQty', header: 'Sellable', accessorKey: 'sellableQty',
      cell: ({ row, getValue }) => (
        <input type="number" min={0} defaultValue={getValue() as number}
          disabled={row.original.source === 'historical'}
          onBlur={(e) => { const v = parseInt(e.target.value || '0'); if (v !== row.original.sellableQty) saveField(row.original, { sellableQty: v }); }}
          className="w-14 bg-positive-muted text-positive font-mono text-sm rounded px-1.5 py-0.5 text-center disabled:opacity-60 disabled:cursor-not-allowed" />
      ), size: 80,
    },
    {
      id: 'unsellableQty', header: 'Unsellable', accessorKey: 'unsellableQty',
      cell: ({ row, getValue }) => (
        <input type="number" min={0} defaultValue={getValue() as number}
          disabled={row.original.source === 'historical'}
          onBlur={(e) => { const v = parseInt(e.target.value || '0'); if (v !== row.original.unsellableQty) saveField(row.original, { unsellableQty: v }); }}
          className="w-14 bg-negative-muted text-negative font-mono text-sm rounded px-1.5 py-0.5 text-center disabled:opacity-60 disabled:cursor-not-allowed" />
      ), size: 90,
    },
    {
      id: 'buyCostAdj', header: 'Buy Cost Adj', accessorKey: 'buyCostAdj',
      cell: ({ row, getValue }) => {
        const cents = getValue() as number;
        return (
          <div className="flex items-center gap-1">
            <input type="number" step="0.01" defaultValue={(cents / 100).toFixed(2)}
              disabled={row.original.source === 'historical'}
              onBlur={(e) => { const c = Math.round(parseFloat(e.target.value || '0') * 100); if (c !== row.original.buyCostAdj) saveField(row.original, { buyCostAdjCents: c }); }}
              className={`w-20 bg-surface-muted font-mono text-sm rounded px-1.5 py-0.5 text-right disabled:opacity-60 disabled:cursor-not-allowed ${cents < 0 ? 'text-negative' : cents > 0 ? 'text-positive' : 'text-text-secondary'}`} />
            <span className="text-[10px] text-text-tertiary w-12">{cents > 0 ? 'reverse' : cents < 0 ? 'write-off' : ''}</span>
          </div>
        );
      }, size: 150,
    },
    { id: 'editedAt', header: 'Edited', accessorKey: 'editedAt', cell: ({ getValue, row }) => <span className="font-mono text-xs text-text-tertiary">{savingId === row.original.id ? 'saving…' : (getValue() ? formatDate(getValue() as string) : '')}</span>, size: 90 },
  ], [saveField, savingId]);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-40" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Disposition Management" subtitle="Analyze > Dispositions" dateRange={dateRange} onDateRangeChange={setDateRange} />

      <div className="mb-4 text-sm text-text-secondary bg-surface-muted rounded-lg px-4 py-3 leading-relaxed">
        Buy Cost Adj drives the P&L: <span className="text-positive font-medium">positive</span> reverses COGS (sellable restock),{' '}
        <span className="text-negative font-medium">negative</span> books an Inventory Write-Off (unsellable removal/liquidation/disposal),
        zero leaves COGS unchanged. Edits here flow straight into the reconciled P&L.
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Dispositions" value={visibleTotals.count} format="number" />
        <StatCard label="COGS Reversal (restock)" value={visibleTotals.restockReversalCents} format="currency" accentColor="positive" />
        <StatCard label="Inventory Write-Off" value={visibleTotals.writeoffCents} format="currency" accentColor="negative" />
        <StatCard label="Net Inventory Impact" value={visibleTotals.restockReversalCents - visibleTotals.writeoffCents} format="currency" />
      </div>

      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex rounded-md border border-border-default bg-bg-surface p-0.5">
          {([
            ['all', `All (${totals?.count || 0})`],
            ['current', `Current (${totals?.bySource?.current || 0})`],
            ['historical', `Historical (${totals?.bySource?.historical || 0})`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setSourceFilter(value)}
              className={`h-7 px-3 rounded text-xs font-medium transition-colors ${sourceFilter === value ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button onClick={exportCsv} className="text-sm px-3 py-1.5 rounded bg-surface-muted hover:bg-surface-hover text-text-secondary border border-border">Export CSV</button>
      </div>

      <DataTable data={visibleRows} columns={columns} searchPlaceholder="Search by product, MSKU, ASIN, or ID..." />
    </div>
  );
}

function recomputeTotals(rows: DispRow[], setTotals: (t: Totals) => void) {
  const restock = rows.filter(r => r.buyCostAdj > 0).reduce((s, r) => s + r.buyCostAdj, 0);
  const writeoff = rows.filter(r => r.buyCostAdj < 0).reduce((s, r) => s + (-r.buyCostAdj), 0);
  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
  setTotals({ count: rows.length, restockReversalCents: restock, writeoffCents: writeoff, byType });
}
