'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatPercent, formatNumber } from '@/lib/formatters';

interface ValuationRow {
  asin: string;
  sku: string;
  productName: string;
  category: string;
  quantityOnHand: number;
  cogsPerUnit: number;
  totalCogsValue: number;
  expectedRevenue: number;
  expectedProfit: number;
  expectedRoi: number;
  salesRank: number | null;
  salesRankCategory: string | null;
  rankDelta7d: number | null;
  rankDelta30d: number | null;
}

export default function InventoryValuationPage() {
  const [rows, setRows] = useState<ValuationRow[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editItem, setEditItem] = useState<ValuationRow | null>(null);
  const [editCogs, setEditCogs] = useState('');
  const [editField, setEditField] = useState<'cogs' | 'price' | 'mfn'>('cogs');
  const [mfnSku, setMfnSku] = useState('');
  const [mfnQty, setMfnQty] = useState('');
  const [mfnMarketplace, setMfnMarketplace] = useState('amazon');
  const [showAddMfn, setShowAddMfn] = useState(false);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const res = await fetch(`/api/data/inventory-valuation?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.items || data.rows || []);
    setTotals(data.totals || null);
    if (!silent) setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo<ColumnDef<ValuationRow, any>[]>(() => [
    {
      id: 'product', header: 'Product', accessorFn: (row) => row.productName || row.asin,
      cell: ({ row }) => {
        const r = row.original as any;
        const isAmazon = r.marketplace === 'amazon' || (r.asin && r.asin.startsWith('B0'));
        const amazonUrl = isAmazon ? `https://www.amazon.com/dp/${r.asin}` : null;
        const walmartUrl = !isAmazon && r.walmartItemId ? `https://www.walmart.com/ip/${r.walmartItemId}` : null;
        const listingUrl = amazonUrl || walmartUrl;
        return (
          <div className="min-w-[200px]">
            <div className="text-sm text-text-primary truncate max-w-[280px]">
              {listingUrl ? (
                <a href={listingUrl} target="_blank" rel="noopener noreferrer" className="hover:text-accent transition-colors">{r.productName || r.asin}</a>
              ) : (
                r.productName || r.asin
              )}
            </div>
            <div className="text-xs text-text-tertiary font-mono">
              {isAmazon && r.asin ? (
                <a href={`https://www.amazon.com/dp/${r.asin}`} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{r.asin}</a>
              ) : r.asin}{' | '}{r.sku}
            </div>
          </div>
        );
      }, size: 280,
    },
    { id: 'category', header: 'Category', accessorKey: 'category', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string || '—'}</span>, size: 130 },
    {
      id: 'salesRank', header: 'BSR', accessorKey: 'salesRank',
      cell: ({ row }) => {
        const r = row.original;
        if (r.salesRank === null) return <span className="font-mono text-text-tertiary">—</span>;
        const delta = r.rankDelta7d;
        // Lower rank number = better. Negative delta = improving (good, green). Positive = worsening (red).
        const deltaColor = delta === null ? 'text-text-tertiary' : delta < 0 ? 'text-positive' : delta > 0 ? 'text-negative' : 'text-text-tertiary';
        const deltaPrefix = delta === null ? '' : delta < 0 ? '↑' : delta > 0 ? '↓' : '·';
        return (
          <div className="font-mono text-sm leading-tight">
            <div className="text-text-primary">#{formatNumber(r.salesRank)}</div>
            {delta !== null && (
              <div className={`text-[10px] ${deltaColor}`} title={`${delta > 0 ? '+' : ''}${formatNumber(delta)} vs 7d ago${r.rankDelta30d !== null ? ` · ${r.rankDelta30d > 0 ? '+' : ''}${formatNumber(r.rankDelta30d)} vs 30d` : ''}`}>
                {deltaPrefix} {formatNumber(Math.abs(delta))}
              </div>
            )}
          </div>
        );
      }, size: 90,
    },
    { id: 'quantityOnHand', header: 'Available', accessorKey: 'quantityOnHand', cell: ({ getValue }) => <span className="font-mono text-text-primary">{formatNumber(getValue() as number)}</span>, size: 80 },
    {
      id: 'inbound', header: 'Inbound', accessorKey: 'inboundQty',
      cell: ({ row }) => {
        const r = row.original as any;
        const total = (r.inboundWorking || 0) + (r.inboundShipped || 0) + (r.inboundReceiving || 0);
        if (total === 0) return <span className="font-mono text-text-tertiary">—</span>;
        return (
          <div className="font-mono text-sm">
            <span className="text-text-primary">{total}</span>
            {(r.inboundShipped > 0 || r.inboundReceiving > 0) && (
              <div className="text-[10px] text-text-tertiary">
                {r.inboundWorking > 0 && <span>Working: {r.inboundWorking} </span>}
                {r.inboundShipped > 0 && <span>Shipped: {r.inboundShipped} </span>}
                {r.inboundReceiving > 0 && <span>Receiving: {r.inboundReceiving}</span>}
              </div>
            )}
          </div>
        );
      }, size: 90,
    },
    {
      id: 'reserved', header: 'Reserved', accessorKey: 'reservedQty',
      cell: ({ row }) => {
        const r = row.original as any;
        const total = r.reservedQty || 0;
        if (total === 0) return <span className="font-mono text-text-tertiary">—</span>;
        return (
          <div className="font-mono text-sm">
            <span className="text-text-primary">{total}</span>
            <div className="text-[10px] text-text-tertiary">
              {r.reservedCustomerOrder > 0 && <span>Orders: {r.reservedCustomerOrder} </span>}
              {r.reservedFcTransfer > 0 && <span>FC Transfer: {r.reservedFcTransfer} </span>}
              {r.reservedFcProcessing > 0 && <span>Processing: {r.reservedFcProcessing}</span>}
            </div>
          </div>
        );
      }, size: 100,
    },
    {
      id: 'cogsPerUnit', header: 'COGS/Unit', accessorKey: 'cogsPerUnit',
      cell: ({ row }) => {
        const v = row.original.cogsPerUnit;
        if (v > 0) return <button onClick={() => handleEditCogs(row.original)} className="font-mono text-text-secondary hover:text-accent transition-colors">{formatCurrency(v)}</button>;
        return (
          <button
            onClick={() => handleEditCogs(row.original)}
            className="text-xs text-accent hover:text-accent-hover underline"
          >
            + Add COGS
          </button>
        );
      }, size: 100,
    },
    { id: 'totalCogsValue', header: 'Total COGS', accessorKey: 'totalCogsValue', cell: ({ getValue }) => <span className="font-mono text-text-primary">{formatCurrency(getValue() as number)}</span>, size: 110 },
    {
      id: 'expectedRevenue', header: 'Expected Revenue', accessorKey: 'expectedRevenue',
      cell: ({ row }) => {
        const r = row.original as any;
        if (!r.hasSalesHistory) return (
          <button onClick={() => handleEditPrice(r)} className="text-xs text-accent hover:text-accent-hover underline">+ Set price</button>
        );
        return <button onClick={() => handleEditPrice(r)} className="font-mono text-text-primary hover:text-accent transition-colors">{formatCurrency(r.expectedRevenue)}</button>;
      }, size: 130,
    },
    {
      id: 'expectedProfit', header: 'Expected Profit', accessorKey: 'expectedProfit',
      cell: ({ row }) => {
        const r = row.original as any;
        if (!r.hasSalesHistory) return <span className="text-text-tertiary">—</span>;
        return <span className={`font-mono font-medium ${r.expectedProfit >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(r.expectedProfit)}</span>;
      }, size: 120,
    },
    {
      id: 'expectedRoi', header: 'Expected ROI', accessorKey: 'expectedRoi',
      cell: ({ row }) => {
        const r = row.original as any;
        if (!r.hasSalesHistory) return <span className="text-text-tertiary">—</span>;
        return <span className={`font-mono ${r.expectedRoi >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(r.expectedRoi)}</span>;
      }, size: 100,
    },
  ], []);

  function handleEditCogs(item: ValuationRow) {
    setEditItem(item);
    setEditField('cogs');
    setEditCogs(item.cogsPerUnit > 0 ? (item.cogsPerUnit / 100).toFixed(2) : '');
  }

  function handleEditPrice(item: any) {
    setEditItem(item);
    setEditField('price');
    setEditCogs(item.listPrice > 0 ? (item.listPrice / 100).toFixed(2) : '');
  }

  async function handleSave() {
    if (!editItem) return;
    const val = parseFloat(editCogs);
    if (isNaN(val) || val < 0) return;

    if (editField === 'cogs') {
      await fetch('/api/data/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: editItem.sku, asin: editItem.asin, buyPrice: val }),
      });
      fetchData(true);
    } else {
      await fetch('/api/data/inventory-valuation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: editItem.sku, asin: editItem.asin, listPrice: val }),
      });
      fetchData(true);
    }

    setEditItem(null);
    setEditCogs('');
  }

  async function handleAddMfn() {
    if (!mfnSku || !mfnQty) return;
    await fetch('/api/data/inventory-valuation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: mfnSku, asin: mfnSku, quantity: parseInt(mfnQty), marketplace: mfnMarketplace, productName: '' }),
    });
    setShowAddMfn(false);
    setMfnSku('');
    setMfnQty('');
    fetchData(true);
  }

  function handleExport() {
    const headers = ['Product', 'ASIN', 'SKU', 'Category', 'On Hand', 'COGS/Unit', 'Total COGS', 'Expected Revenue', 'Expected Profit', 'Expected ROI'];
    const csvRows = rows.map(r => [
      `"${r.productName}"`, r.asin, r.sku, r.category, r.quantityOnHand,
      (r.cogsPerUnit / 100).toFixed(2), (r.totalCogsValue / 100).toFixed(2),
      (r.expectedRevenue / 100).toFixed(2), (r.expectedProfit / 100).toFixed(2), r.expectedRoi.toFixed(1),
    ].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'inventory-valuation.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-48" /><div className="skeleton h-[400px] w-full" /></div>;

  const footerRow = totals ? {
    product: <span className="font-semibold text-text-primary">Totals</span>,
    quantityOnHand: <span className="font-mono">{formatNumber(totals.totalUnits)}</span>,
    totalCogsValue: <span className="font-mono">{formatCurrency(totals.totalCogsValue)}</span>,
    expectedRevenue: <span className="font-mono">{formatCurrency(totals.totalExpectedRevenue)}</span>,
    expectedProfit: <span className={`font-mono font-medium ${totals.totalExpectedProfit >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(totals.totalExpectedProfit)}</span>,
  } : undefined;

  return (
    <div>
      <PageHeader title="Inventory Valuation" subtitle="Analyze > Inventory Valuation" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} onExport={handleExport} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Units" value={totals?.totalUnits || 0} format="number" />
        <StatCard label="Total COGS Value" value={totals?.totalCogsValue || 0} format="currency" accentColor="amazon" />
        <StatCard label="Expected Revenue" value={totals?.totalExpectedRevenue || 0} format="currency" />
        <StatCard label="Expected Profit" value={totals?.totalExpectedProfit || 0} format="currency" accentColor={(totals?.totalExpectedProfit || 0) >= 0 ? 'positive' : 'negative'} />
      </div>
      <div className="flex justify-end mb-3">
        <button onClick={() => setShowAddMfn(true)}
          className="flex items-center gap-1.5 h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors">
          + Add MFN Inventory
        </button>
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by product, ASIN, or category..." footerRow={footerRow} />

      {/* Edit COGS Modal */}
      {editItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditItem(null)}>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 w-96 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-text-primary mb-1">{editField === 'cogs' ? 'Edit COGS' : 'Set Sale Price'}</h3>
            <p className="text-xs text-text-tertiary mb-4 truncate">{editItem.productName || editItem.sku}</p>
            <div className="mb-4">
              <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
                {editField === 'cogs' ? 'Cost Per Unit ($)' : 'Sale Price Per Unit ($)'}
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={editCogs}
                onChange={e => setEditCogs(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSave()}
                autoFocus
                className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm font-mono text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
                placeholder="0.00"
              />
            </div>
            <div className="flex gap-2">
              <button onClick={handleSave}
                className="flex-1 h-9 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors">
                Save
              </button>
              <button onClick={() => setEditItem(null)}
                className="flex-1 h-9 bg-bg-elevated border border-border-default rounded-md text-sm text-text-secondary hover:bg-bg-hover transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Add MFN Inventory Modal */}
      {showAddMfn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowAddMfn(false)}>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 w-96 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-text-primary mb-4">Add Merchant Fulfilled Inventory</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">SKU</label>
                <input type="text" value={mfnSku} onChange={e => setMfnSku(e.target.value)} autoFocus
                  className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm font-mono text-text-primary focus:border-accent focus:outline-none" placeholder="Enter SKU" />
              </div>
              <div>
                <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">Quantity On Hand</label>
                <input type="number" min="0" value={mfnQty} onChange={e => setMfnQty(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddMfn()}
                  className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm font-mono text-text-primary focus:border-accent focus:outline-none" placeholder="0" />
              </div>
              <div>
                <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">Marketplace</label>
                <select value={mfnMarketplace} onChange={e => setMfnMarketplace(e.target.value)}
                  className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary focus:border-accent focus:outline-none">
                  <option value="amazon">Amazon (MFN)</option>
                  <option value="walmart">Walmart (Seller Fulfilled)</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={handleAddMfn} className="flex-1 h-9 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors">Add</button>
              <button onClick={() => setShowAddMfn(false)} className="flex-1 h-9 bg-bg-elevated border border-border-default rounded-md text-sm text-text-secondary hover:bg-bg-hover transition-colors">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
