'use client';

import { useEffect, useState, useMemo } from 'react';
import { formatCurrency, formatDate } from '@/lib/formatters';
import { Search } from 'lucide-react';

interface InventoryRow {
  id: number;
  asin: string;
  sku: string | null;
  quantity: number;
  quantity_remaining: number;
  buy_price: number;
  date_purchased: string;
  bin_location: string | null;
  condition: string | null;
  notes: string | null;
  supplier_name: string | null;
  product_name: string | null;
  image_url: string | null;
  category: string | null;
}

export default function MerchantInventoryPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('/api/data/merchant-inventory')
      .then(r => r.json())
      .then(d => { setRows(d.items || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(r =>
      (r.product_name || '').toLowerCase().includes(q) ||
      (r.asin || '').toLowerCase().includes(q) ||
      (r.sku || '').toLowerCase().includes(q) ||
      (r.supplier_name || '').toLowerCase().includes(q) ||
      (r.bin_location || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const totalUnits = filtered.reduce((s, r) => s + r.quantity_remaining, 0);
  const totalCogs = filtered.reduce((s, r) => s + r.buy_price * r.quantity_remaining, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Merchant Inventory</h1>
          <p className="text-sm text-text-tertiary mt-0.5">In-stock MFN/E2A lots by bin location</p>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search title, ASIN, SKU, supplier, or bin…"
            className="h-9 pl-9 pr-4 w-80 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-1">In-Stock Lots</div>
            <div className="text-2xl font-semibold font-mono text-text-primary">{filtered.length}</div>
          </div>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-1">Total Units</div>
            <div className="text-2xl font-semibold font-mono text-text-primary">{totalUnits}</div>
          </div>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-1">COGS on Hand</div>
            <div className="text-2xl font-semibold font-mono text-text-primary">{formatCurrency(totalCogs)}</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-12 w-full mb-1" />
          ))}
        </div>
      ) : (
        <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-bg-elevated border-b border-border-subtle">
                <th className="px-3 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-10"></th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary">Product</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-36">SKU / MSKU</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-28">Supplier</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Bin</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Condition</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-16">Qty</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Cost / unit</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-28">Purchased</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-text-tertiary text-sm">
                    {search
                      ? 'No items match your search.'
                      : 'No in-stock inventory found. Add buy lots with a remaining quantity in Products & COGS.'}
                  </td>
                </tr>
              ) : (
                filtered.map(row => (
                  <tr key={row.id} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                    <td className="px-3 py-2">
                      {row.image_url
                        ? <img src={row.image_url} alt="" className="w-8 h-8 object-contain rounded" />
                        : <div className="w-8 h-8 bg-bg-elevated rounded" />}
                    </td>
                    <td className="px-4 py-2">
                      <div className="text-sm text-text-primary font-medium truncate max-w-[280px]" title={row.product_name || row.asin}>
                        {row.product_name || row.asin}
                      </div>
                      <div className="text-[11px] text-text-tertiary font-mono">{row.asin}</div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-text-secondary">{row.sku || '—'}</td>
                    <td className="px-4 py-2 text-sm text-text-secondary truncate max-w-[6rem]">{row.supplier_name || '—'}</td>
                    <td className="px-4 py-2">
                      {row.bin_location
                        ? <span className="inline-flex items-center px-2 py-0.5 rounded bg-accent/10 text-accent text-xs font-mono font-medium">{row.bin_location}</span>
                        : <span className="text-text-tertiary text-xs">—</span>}
                    </td>
                    <td className="px-4 py-2 text-sm text-text-secondary">{row.condition || '—'}</td>
                    <td className="px-4 py-2 text-right font-mono text-sm text-text-primary font-medium">{row.quantity_remaining}</td>
                    <td className="px-4 py-2 text-right font-mono text-sm text-text-primary">{formatCurrency(row.buy_price)}</td>
                    <td className="px-4 py-2 text-right text-xs text-text-tertiary font-mono">{formatDate(row.date_purchased)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {filtered.length > 0 && (
            <div className="px-4 py-2 border-t border-border-subtle bg-bg-elevated/40 text-xs text-text-tertiary flex gap-4">
              <span>{filtered.length} {filtered.length === 1 ? 'lot' : 'lots'}</span>
              <span>{totalUnits} units in stock</span>
              <span>{formatCurrency(totalCogs)} COGS on hand</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
