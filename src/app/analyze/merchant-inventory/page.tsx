'use client';

import { useEffect, useState, useMemo } from 'react';
import { formatCurrency, formatDate } from '@/lib/formatters';
import { Search, Printer, X } from 'lucide-react';

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
  fnsku: string | null;
}

type LabelMode = 'asin' | 'warehouse' | 'fnsku' | 'custom';

interface LabelSpec {
  labelMode: LabelMode;
  size: '2x1' | '4x6';
  title?: string;
  asin?: string;
  fnsku?: string;
  sku?: string;
  bin?: string;
  condition?: string;
  priceCents?: number;
  showPrice?: boolean;
  showBin?: boolean;
  subtitle?: string;
  notes?: string;
}

function openPrintWindow(specs: LabelSpec[]) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(specs))));
  window.open(`/api/labels/print?d=${encodeURIComponent(encoded)}`, '_blank');
}

interface PrintModalProps {
  selected: InventoryRow[];
  onClose: () => void;
}

const LABEL_MODES: { mode: LabelMode; label: string; desc: string }[] = [
  { mode: 'asin',      label: 'ASIN Label',              desc: 'Customer Safe' },
  { mode: 'warehouse', label: 'Internal Warehouse Label', desc: 'Internal use only' },
  { mode: 'fnsku',     label: 'FNSKU Label',              desc: 'Requires real FNSKU' },
  { mode: 'custom',    label: 'Custom Label',             desc: 'Free-text' },
];

function PrintModal({ selected, onClose }: PrintModalProps) {
  const [labelMode, setLabelMode] = useState<LabelMode>('asin');
  const [size, setSize] = useState<'2x1' | '4x6'>('2x1');
  const [showPrice, setShowPrice] = useState(false);
  const [showBin, setShowBin] = useState(false);
  const [custom, setCustom] = useState({ title: '', subtitle: '', notes: '', sku: '', asin: '', bin: '' });

  const hasFnsku = selected.some(r => r.fnsku);

  function handlePrint() {
    if (labelMode === 'custom') {
      openPrintWindow([{
        labelMode: 'custom',
        size,
        title:    custom.title    || undefined,
        subtitle: custom.subtitle || undefined,
        notes:    custom.notes    || undefined,
        sku:      custom.sku      || undefined,
        asin:     custom.asin     || undefined,
        bin:      custom.bin      || undefined,
      }]);
      return;
    }

    const specs: LabelSpec[] = selected.map(r => ({
      labelMode,
      size,
      title:      r.product_name || r.asin || '',
      asin:       r.asin,
      fnsku:      r.fnsku || undefined,
      sku:        labelMode === 'warehouse' ? (r.sku || undefined) : undefined,
      bin:        r.bin_location || undefined,
      condition:  r.condition || undefined,
      priceCents: r.buy_price,
      showPrice:  labelMode === 'warehouse' ? showPrice : false,
      showBin:    labelMode === 'asin' ? showBin : undefined,
    }));
    openPrintWindow(specs);
  }

  const canPrint =
    labelMode === 'custom'
      ? !!(custom.title || custom.subtitle || custom.bin)
      : labelMode === 'fnsku'
        ? selected.length > 0 && hasFnsku
        : selected.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-[440px] max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Printer size={15} className="text-text-tertiary" />
            Print Labels
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-hover text-text-tertiary">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">

          {/* Label type selector */}
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2">Label Type</div>
            <div className="space-y-1.5">
              {LABEL_MODES.map(({ mode, label, desc }) => {
                const disabled = mode === 'fnsku' && !hasFnsku;
                return (
                  <label
                    key={mode}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-md border transition-colors cursor-pointer ${
                      disabled
                        ? 'opacity-40 cursor-not-allowed border-border-subtle'
                        : labelMode === mode
                          ? 'border-accent/50 bg-accent/5'
                          : 'border-border-subtle hover:border-border-default hover:bg-bg-hover'
                    }`}
                  >
                    <input
                      type="radio"
                      name="labelMode"
                      value={mode}
                      checked={labelMode === mode}
                      disabled={disabled}
                      onChange={() => setLabelMode(mode)}
                      className="accent-accent shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-text-primary">{label}</div>
                      <div className="text-[11px] text-text-tertiary">{desc}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            {labelMode === 'asin' && (
              <p className="text-[11px] text-text-tertiary mt-2 pl-1">
                Customer Safe — excludes MSKU, cost, supplier, and purchase details.
              </p>
            )}
          </div>

          {/* Size picker */}
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2">Label Size</div>
            <div className="flex gap-2">
              {(['2x1', '4x6'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setSize(s)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                    size === s
                      ? 'bg-accent/10 text-accent border-accent/40'
                      : 'bg-bg-elevated text-text-secondary border-border-subtle hover:border-border-default'
                  }`}
                >
                  {s === '2x1' ? '2" × 1" (thermal)' : '4" × 6" (bin/shelf)'}
                </button>
              ))}
            </div>
          </div>

          {/* Mode-specific options */}
          {labelMode === 'asin' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={showBin} onChange={e => setShowBin(e.target.checked)} className="accent-accent" />
              <span className="text-xs text-text-secondary">Include bin location (for internal picking)</span>
            </label>
          )}
          {labelMode === 'warehouse' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={showPrice} onChange={e => setShowPrice(e.target.checked)} className="accent-accent" />
              <span className="text-xs text-text-secondary">Show buy price on label</span>
            </label>
          )}
          {labelMode === 'fnsku' && hasFnsku && (
            <p className="text-[11px] text-text-tertiary">
              {selected.filter(r => r.fnsku).length} of {selected.length} selected item{selected.length !== 1 ? 's' : ''} have a real FNSKU.
              Items without FNSKU will be skipped.
            </p>
          )}

          {/* Custom label fields */}
          {labelMode === 'custom' && (
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">
                  {size === '4x6' ? 'Large Text (e.g. bin name)' : 'Title'}
                </label>
                <input
                  type="text"
                  value={custom.title}
                  onChange={e => setCustom(c => ({ ...c, title: e.target.value }))}
                  placeholder={size === '4x6' ? 'S1-B3' : 'Label title'}
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">Subtitle</label>
                <input
                  type="text"
                  value={custom.subtitle}
                  onChange={e => setCustom(c => ({ ...c, subtitle: e.target.value }))}
                  placeholder="Optional subtitle"
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">Notes</label>
                <input
                  type="text"
                  value={custom.notes}
                  onChange={e => setCustom(c => ({ ...c, notes: e.target.value }))}
                  placeholder="Optional notes"
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">Bin / Location</label>
                  <input
                    type="text"
                    value={custom.bin}
                    onChange={e => setCustom(c => ({ ...c, bin: e.target.value }))}
                    placeholder="e.g. S1-B3"
                    className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">SKU (optional)</label>
                  <input
                    type="text"
                    value={custom.sku}
                    onChange={e => setCustom(c => ({ ...c, sku: e.target.value }))}
                    placeholder="SKU for barcode"
                    className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Selected items preview (non-custom modes) */}
          {labelMode !== 'custom' && selected.length > 0 && (
            <div className="space-y-1 max-h-36 overflow-y-auto">
              <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-1.5">
                {selected.length} item{selected.length !== 1 ? 's' : ''} selected
              </div>
              {selected.map(r => (
                <div key={r.id} className="flex items-center gap-2 py-1 border-b border-border-subtle/50 last:border-0">
                  {r.image_url
                    ? <img src={r.image_url} alt="" className="w-7 h-7 object-contain rounded shrink-0" />
                    : <div className="w-7 h-7 bg-bg-elevated rounded shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-text-primary truncate">{r.product_name || r.asin}</div>
                    <div className="text-[10px] font-mono text-text-tertiary">{r.asin}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {r.bin_location && (
                      <span className="text-[10px] font-mono font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                        {r.bin_location}
                      </span>
                    )}
                    {r.fnsku && (
                      <span className="text-[10px] font-mono text-text-tertiary bg-bg-elevated px-1.5 py-0.5 rounded">
                        FNSKU
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 pb-4">
          <button
            onClick={onClose}
            className="flex-1 h-9 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handlePrint}
            disabled={!canPrint}
            className="flex-1 h-9 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
          >
            <Printer size={14} />
            Print
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MerchantInventoryPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showPrintModal, setShowPrintModal] = useState(false);

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
  const totalCogs  = filtered.reduce((s, r) => s + r.buy_price * r.quantity_remaining, 0);

  function toggleRow(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(r => r.id)));
    }
  }

  const selectedRows = filtered.filter(r => selected.has(r.id));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Local / E2A Inventory</h1>
          <p className="text-sm text-text-tertiary mt-0.5">Local FlipLedger lots (LV_ SKUs) · Amazon live MFN status not synced</p>
        </div>
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <button
              onClick={() => setShowPrintModal(true)}
              className="flex items-center gap-1.5 h-9 px-3 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors"
            >
              <Printer size={14} />
              Print Labels ({selected.size})
            </button>
          )}
          <button
            onClick={() => { setSelected(new Set()); setShowPrintModal(true); }}
            className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <Printer size={14} />
            Custom Label
          </button>
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
                <th className="px-3 py-2.5 w-8">
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && selected.size === filtered.length}
                    ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < filtered.length; }}
                    onChange={toggleAll}
                    className="accent-accent cursor-pointer"
                  />
                </th>
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
                  <td colSpan={10} className="px-4 py-10 text-center text-text-tertiary text-sm">
                    {search
                      ? 'No items match your search.'
                      : 'No in-stock inventory found. Add buy lots with a remaining quantity in Products & COGS.'}
                  </td>
                </tr>
              ) : (
                filtered.map(row => {
                  const isSelected = selected.has(row.id);
                  return (
                    <tr
                      key={row.id}
                      onClick={() => toggleRow(row.id)}
                      className={`border-b border-border-subtle/50 cursor-pointer transition-colors ${
                        isSelected ? 'bg-accent/5 hover:bg-accent/10' : 'hover:bg-bg-hover'
                      }`}
                    >
                      <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(row.id)}
                          className="accent-accent cursor-pointer"
                        />
                      </td>
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
                  );
                })
              )}
            </tbody>
          </table>
          {filtered.length > 0 && (
            <div className="px-4 py-2 border-t border-border-subtle bg-bg-elevated/40 text-xs text-text-tertiary flex gap-4">
              <span>{filtered.length} {filtered.length === 1 ? 'lot' : 'lots'}</span>
              <span>{totalUnits} units in stock</span>
              <span>{formatCurrency(totalCogs)} COGS on hand</span>
              {selected.size > 0 && (
                <span className="ml-auto text-accent">{selected.size} selected</span>
              )}
            </div>
          )}
        </div>
      )}

      {showPrintModal && (
        <PrintModal
          selected={selectedRows}
          onClose={() => setShowPrintModal(false)}
        />
      )}
    </div>
  );
}
