'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
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
  refunds: number;
  revenue: number;
  fees: number;
  cogs: number;
  costPerUnit: number;
  profit: number;
  roi: number;
  margin: number;
  onHand: number;
  warehouse: number;
  inbound: number;
  onHandValueCents: number;
  shippingCost: number;
  shippingCharged: number;
}

interface Totals {
  orders: number;
  unitsSold: number;
  revenue: number;
  fees: number;
  cogs: number;
  shippingCost: number;
  profit: number;
  refunds: number;
  onHand: number;
  warehouse: number;
  inbound: number;
  onHandValueCents: number;
  roi: number;
  margin: number;
  costPerUnit: number;
}

type GroupBy = 'asin' | 'sku' | 'supplier' | 'category';

const TABS: { key: GroupBy; label: string }[] = [
  { key: 'asin', label: 'By ASIN' },
  { key: 'sku', label: 'By MSKU' },
  { key: 'supplier', label: 'By Supplier' },
  { key: 'category', label: 'By Category' },
];

const DIM_LABEL: Record<GroupBy, string> = { asin: 'ASIN', sku: 'MSKU', supplier: 'Supplier', category: 'Category' };

export default function ProfitabilityReportsPage() {
  const [groupBy, setGroupBy] = useState<GroupBy>('supplier');
  const [rows, setRows] = useState<ProfitRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/profitability?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}&groupBy=${groupBy}`);
    const data = await res.json();
    setRows(data.rows || []);
    setTotals(data.totals || null);
    setLoading(false);
  }, [dateRange, marketplaceParam, groupBy]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const money = (v: number) => <span className="font-mono text-text-primary">{formatCurrency(v)}</span>;
  const signed = (v: number) => <span className={`font-mono font-medium ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(v)}</span>;
  const pct = (v: number) => <span className={`font-mono ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(v)}</span>;
  const feePill = (v: number) => (
    <span className="inline-flex items-center gap-1 rounded-md bg-warning/15 px-2 py-0.5 font-mono text-xs text-warning">
      {formatCurrency(v)}
    </span>
  );

  const columns = useMemo<ColumnDef<ProfitRow, any>[]>(() => [
    {
      id: 'dimension',
      header: DIM_LABEL[groupBy],
      accessorKey: 'groupKey',
      cell: ({ row }) => {
        const r = row.original;
        const name = r.productName?.trim();
        return (
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-text-primary">{r.groupKey || 'Unknown'}</div>
            {name && (groupBy === 'asin' || groupBy === 'sku') && (
              <div className="truncate text-xs text-text-tertiary">{name}</div>
            )}
          </div>
        );
      },
      size: 240,
    },
    { id: 'qty', header: 'Qty', accessorKey: 'unitsSold', cell: ({ getValue }) => <span className="font-mono text-text-primary">{formatNumber(getValue() as number)}</span>, size: 70 },
    { id: 'fees', header: 'Order Fees', accessorKey: 'fees', cell: ({ getValue }) => feePill(getValue() as number), size: 120 },
    { id: 'mfnShipping', header: 'MFN Shipping', accessorKey: 'shippingCost', cell: ({ getValue }) => money(getValue() as number), size: 110 },
    { id: 'cogs', header: 'Total COGS', accessorKey: 'cogs', cell: ({ getValue }) => money(getValue() as number), size: 110 },
    { id: 'revenue', header: 'Revenue', accessorKey: 'revenue', cell: ({ getValue }) => money(getValue() as number), size: 110 },
    { id: 'profit', header: 'Contribution', accessorKey: 'profit', cell: ({ getValue }) => signed(getValue() as number), size: 110 },
    { id: 'roi', header: 'Contribution ROI%', accessorKey: 'roi', cell: ({ getValue }) => pct(getValue() as number), size: 130 },
    { id: 'margin', header: 'Contribution Margin%', accessorKey: 'margin', cell: ({ getValue }) => pct(getValue() as number), size: 150 },
    { id: 'inbound', header: 'Inbound', accessorKey: 'inbound', cell: ({ getValue }) => <span className="font-mono text-accent">{formatNumber(getValue() as number)}</span>, size: 80 },
    { id: 'warehouse', header: 'Warehouse', accessorKey: 'warehouse', cell: ({ getValue }) => { const v = getValue() as number; return <span className={`font-mono ${v > 0 ? 'text-warning' : 'text-text-tertiary'}`}>{formatNumber(v)}</span>; }, size: 90 },
  ], [groupBy]);

  function handleExport() {
    const headers = [DIM_LABEL[groupBy], 'Qty', 'Order Fees', 'MFN Shipping', 'Total COGS', 'Revenue', 'Contribution Profit', 'Contribution ROI %', 'Contribution Margin %', 'Inbound', 'Warehouse'];
    const csvRows = rows.map(r => [
      `"${r.groupKey}"`, r.unitsSold, (r.fees / 100).toFixed(2), (r.shippingCost / 100).toFixed(2),
      (r.cogs / 100).toFixed(2), (r.revenue / 100).toFixed(2), (r.profit / 100).toFixed(2),
      r.roi.toFixed(1), r.margin.toFixed(1), r.inbound, r.warehouse,
    ].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `profitability-by-${groupBy}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const footerRow = totals ? {
    dimension: <span className="font-semibold text-text-primary">Totals</span>,
    qty: <span className="font-mono">{formatNumber(totals.unitsSold)}</span>,
    fees: <span className="font-mono text-warning">{formatCurrency(totals.fees)}</span>,
    mfnShipping: <span className="font-mono">{formatCurrency(totals.shippingCost)}</span>,
    cogs: <span className="font-mono">{formatCurrency(totals.cogs)}</span>,
    revenue: <span className="font-mono">{formatCurrency(totals.revenue)}</span>,
    profit: <span className={`font-mono font-medium ${totals.profit >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(totals.profit)}</span>,
    roi: <span className={`font-mono ${totals.roi >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(totals.roi)}</span>,
    margin: <span className={`font-mono ${totals.margin >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(totals.margin)}</span>,
    inbound: <span className="font-mono text-accent">{formatNumber(totals.inbound)}</span>,
    warehouse: <span className="font-mono text-warning">{formatNumber(totals.warehouse)}</span>,
  } : undefined;

  return (
    <div>
      <PageHeader
        title="Profitability Reports"
        subtitle="Reports > Profitability"
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace}
        onExport={handleExport}
      />

      {/* Tabs */}
      <div className="mb-5 flex items-center gap-1 border-b border-border-subtle">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setGroupBy(t.key)}
            className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
              groupBy === t.key ? 'text-accent' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
            {groupBy === t.key && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-6">
        <StatCard label="Units Sold" value={totals?.unitsSold || 0} format="number" />
        <StatCard label="Revenue" value={totals?.revenue || 0} format="currency" />
        <StatCard label="Contribution Profit" value={totals?.profit || 0} format="currency" accentColor={(totals?.profit || 0) >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Contribution ROI" value={totals?.roi || 0} format="percent" accentColor={(totals?.roi || 0) >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Contribution Margin" value={totals?.margin || 0} format="percent" accentColor={(totals?.margin || 0) >= 0 ? 'positive' : 'negative'} />
        <StatCard label="On Hand Qty" value={totals?.onHand || 0} format="number" />
        <StatCard label="On Hand Value" value={totals?.onHandValueCents || 0} format="currency" accentColor="amazon" />
      </div>

      <p className="mb-4 text-xs text-text-tertiary">
        Contribution profit = product revenue + shipping charged − recognized COGS − order-linked fees − shipping cost.
        Recognized COGS includes confirmed sellable-return and disposition-restock reversals.
        Refund dollars, reimbursements, service fees, inventory write-offs, and business-wide expenses appear in Profit &amp; Loss, not here.
      </p>

      {loading ? (
        <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
          {Array.from({ length: 10 }).map((_, i) => <div key={i} className="skeleton mb-1 h-10 w-full" />)}
        </div>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          searchPlaceholder={`Search by ${DIM_LABEL[groupBy].toLowerCase()}...`}
          footerRow={footerRow}
        />
      )}
    </div>
  );
}
