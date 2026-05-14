'use client';

import { useEffect, useState, useMemo } from 'react';
import { formatCurrency } from '@/lib/formatters';
import { Search, Printer, X, Check, CheckCircle2, RefreshCw } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  quantity_received: number | null;
  received_at: string | null;
  inspected_at: string | null;
  receive_notes: string | null;
  list_price_cents: number | null;
  // Live listing data from merchant_listings (null if never synced or no match)
  live_status: string | null;
  live_quantity: number | null;
  live_last_synced: string | null;
  live_list_price_cents: number | null;
  live_state: 'active' | 'inactive' | 'oos' | 'not_listed' | null;
}

type ReceiveStatus = 'pending' | 'received' | 'inspected' | 'ready';

function getStatus(row: InventoryRow): ReceiveStatus {
  const received = (row.quantity_received ?? 0) > 0 && row.received_at != null;
  const inspected = received && row.inspected_at != null;
  const ready =
    inspected &&
    !!(row.bin_location?.trim()) &&
    !!(row.condition?.trim()) &&
    (row.list_price_cents ?? 0) > 0;
  if (ready) return 'ready';
  if (inspected) return 'inspected';
  if (received) return 'received';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONDITIONS = [
  'New',
  'Used - Like New',
  'Used - Very Good',
  'Used - Good',
  'Used - Acceptable',
];

const STATUS_STYLES: Record<ReceiveStatus, string> = {
  pending:   'bg-bg-elevated text-text-tertiary border-border-subtle',
  received:  'bg-blue-500/10 text-blue-400 border-blue-500/30',
  inspected: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  ready:     'bg-green-500/10 text-green-400 border-green-500/30',
};

const STATUS_LABELS: Record<ReceiveStatus, string> = {
  pending: 'Pending', received: 'Received', inspected: 'Inspected', ready: 'Ready',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: ReceiveStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

// Live Amazon listing state badge
const LIVE_STATE_STYLES: Record<string, string> = {
  active:     'bg-green-500/10 text-green-400 border-green-500/30',
  oos:        'bg-amber-500/10 text-amber-400 border-amber-500/30',
  inactive:   'bg-red-500/10 text-red-400 border-red-500/30',
  not_listed: 'bg-bg-elevated text-text-tertiary border-border-subtle',
};
const LIVE_STATE_LABELS: Record<string, string> = {
  active:     'Active',
  oos:        'OOS',
  inactive:   'Inactive',
  not_listed: 'Not Listed',
};

function LiveStateBadge({ state }: { state: string | null }) {
  const key = state ?? 'not_listed';
  const style = LIVE_STATE_STYLES[key] ?? LIVE_STATE_STYLES.not_listed;
  const label = LIVE_STATE_LABELS[key] ?? 'Unknown';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${style}`}>
      {label}
    </span>
  );
}

function realFnsku(value: string | null | undefined): string | null {
  const f = String(value || '').trim().toUpperCase();
  return /^X00[A-Z0-9]+$/.test(f) ? f : null;
}

function openPrintWindow(specs: LabelSpec[]) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(specs))));
  window.open(`/api/labels/print?d=${encodeURIComponent(encoded)}`, '_blank');
}

// ---------------------------------------------------------------------------
// Label types (unchanged from prior session)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ReceiveModal
// ---------------------------------------------------------------------------

interface ReceiveModalProps {
  row: InventoryRow;
  onClose: () => void;
  onSaved: () => void;
}

function ReceiveModal({ row, onClose, onSaved }: ReceiveModalProps) {
  const status = getStatus(row);
  const isReceived = status !== 'pending';
  const isInspected = status === 'inspected' || status === 'ready';

  const [qtyReceived, setQtyReceived] = useState(
    row.quantity_received != null
      ? String(row.quantity_received)
      : String(row.quantity_remaining)
  );
  const [receiveNotes, setReceiveNotes] = useState(row.receive_notes ?? '');
  const [listPrice, setListPrice] = useState(
    row.list_price_cents != null ? (row.list_price_cents / 100).toFixed(2) : ''
  );
  const [bin, setBin] = useState(row.bin_location ?? '');
  const [condition, setCondition] = useState(row.condition ?? '');
  const [markInspected, setMarkInspected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qtyNum = Number(qtyReceived);
  const listPriceNum = parseFloat(listPrice);
  const willBeReceived = isReceived || (Number.isFinite(qtyNum) && qtyNum > 0);

  // Live readiness preview (reflects current form values)
  const preview = {
    qty: Number.isFinite(qtyNum) && qtyNum > 0,
    inspected: isInspected || (willBeReceived && markInspected),
    bin: !!(bin.trim()),
    condition: !!(condition.trim()),
    price: !!(listPrice.trim()) && Number.isFinite(listPriceNum) && listPriceNum > 0,
  };
  const allReady = Object.values(preview).every(Boolean);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      if (qtyReceived.trim() !== '' && (!Number.isFinite(qtyNum) || qtyNum < 0)) {
        setError('Quantity received must be a non-negative number');
        return;
      }
      if (listPrice.trim() !== '' && (!Number.isFinite(listPriceNum) || listPriceNum < 0)) {
        setError('List price must be a non-negative number');
        return;
      }

      const body: Record<string, unknown> = { id: row.id };

      if (qtyReceived.trim() !== '') body.quantityReceived = qtyNum;
      body.receiveNotes = receiveNotes.trim() || null;
      if (listPrice.trim() !== '') body.listPriceCents = Math.round(listPriceNum * 100);
      body.binLocation = bin.trim() || null;
      body.condition = condition.trim() || null;

      if (!isReceived && qtyNum > 0) body.markReceived = true;
      if (markInspected && !isInspected && willBeReceived) body.markInspected = true;

      const res = await fetch('/api/data/inventory-lots', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error || 'Save failed');
        return;
      }

      onSaved();
      onClose();
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-[480px] max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">Receive Inventory</h2>
            <p className="text-[11px] text-text-tertiary mt-0.5 truncate">
              {row.product_name || row.asin}
            </p>
          </div>
          <button onClick={onClose} className="ml-3 p-1 rounded hover:bg-bg-hover text-text-tertiary shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">

          {/* Lot summary */}
          <div className="flex items-center gap-3 py-2.5 px-3 bg-bg-elevated rounded-lg border border-border-subtle">
            {row.image_url
              ? <img src={row.image_url} alt="" className="w-10 h-10 object-contain rounded shrink-0" />
              : <div className="w-10 h-10 bg-bg-surface rounded shrink-0" />}
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="text-[11px] font-mono text-text-tertiary">{row.asin}</div>
              <div className="text-[11px] font-mono text-text-tertiary truncate">{row.sku || '—'}</div>
              <div className="text-[11px] text-text-secondary">
                {row.quantity} purchased · {formatCurrency(row.buy_price)}/unit
              </div>
            </div>
            <StatusBadge status={status} />
          </div>

          {/* Ready banner */}
          {allReady && (
            <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-xs font-medium">
              <CheckCircle2 size={14} />
              Ready to Activate — all required fields set
            </div>
          )}

          {/* Receive section */}
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2.5">Receive</div>
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">
                  Quantity Received
                  <span className="ml-1 text-text-tertiary/60">(default: {row.quantity_remaining} in stock)</span>
                </label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={qtyReceived}
                  onChange={e => setQtyReceived(e.target.value)}
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
                {row.quantity_received != null && row.quantity_received !== row.quantity && (
                  <p className="text-[11px] text-amber-400 mt-1">
                    Previously received {row.quantity_received} of {row.quantity} purchased
                  </p>
                )}
                {isReceived && row.received_at && (
                  <p className="text-[11px] text-text-tertiary mt-1">
                    Received on {new Date(row.received_at).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">Receive Notes (optional)</label>
                <input
                  type="text"
                  value={receiveNotes}
                  onChange={e => setReceiveNotes(e.target.value)}
                  placeholder="e.g. 2 units damaged, 1 missing"
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Details section */}
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2.5">Details</div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">List Price ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={listPrice}
                    onChange={e => setListPrice(e.target.value)}
                    placeholder="e.g. 29.99"
                    className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">Bin Location</label>
                  <input
                    type="text"
                    value={bin}
                    onChange={e => setBin(e.target.value)}
                    placeholder="e.g. S1-B3"
                    className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">Condition</label>
                <select
                  value={condition}
                  onChange={e => setCondition(e.target.value)}
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary focus:border-accent focus:outline-none"
                >
                  <option value="">— select condition —</option>
                  {CONDITIONS.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Inspection section */}
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2.5">Inspection</div>
            {isInspected && row.inspected_at ? (
              <div className="flex items-center gap-2 text-xs text-green-400">
                <Check size={13} />
                Inspected on {new Date(row.inspected_at).toLocaleDateString()}
              </div>
            ) : (
              <label className={`flex items-center gap-2.5 ${willBeReceived ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}>
                <input
                  type="checkbox"
                  checked={markInspected}
                  disabled={!willBeReceived}
                  onChange={e => setMarkInspected(e.target.checked)}
                  className="accent-accent"
                />
                <span className="text-xs text-text-secondary">
                  Mark as inspected
                  {!willBeReceived && (
                    <span className="text-text-tertiary ml-1">— receive first</span>
                  )}
                </span>
              </label>
            )}
          </div>

          {/* Readiness checklist */}
          {!allReady && (
            <div>
              <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2">
                Required for Ready to Activate
              </div>
              <div className="space-y-1.5">
                {[
                  { label: 'Quantity received', met: preview.qty },
                  { label: 'Inspected', met: preview.inspected },
                  { label: 'Bin location', met: preview.bin },
                  { label: 'Condition', met: preview.condition },
                  { label: 'List price', met: preview.price },
                ].map(({ label, met }) => (
                  <div
                    key={label}
                    className={`flex items-center gap-2 text-[11px] ${met ? 'text-green-400' : 'text-text-tertiary'}`}
                  >
                    {met
                      ? <Check size={11} />
                      : <span className="w-[11px] h-[11px] rounded-full border border-text-tertiary/40 inline-block shrink-0" />}
                    {label}
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 pb-5">
          <button
            onClick={onClose}
            className="flex-1 h-9 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 h-9 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PrintModal (unchanged)
// ---------------------------------------------------------------------------

const LABEL_MODES: { mode: LabelMode; label: string; desc: string }[] = [
  { mode: 'asin',      label: 'ASIN Label',              desc: 'Customer Safe' },
  { mode: 'warehouse', label: 'Internal Warehouse Label', desc: 'Internal use only' },
  { mode: 'fnsku',     label: 'FNSKU Label',              desc: 'Requires real FNSKU' },
  { mode: 'custom',    label: 'Custom Label',             desc: 'Free-text' },
];

interface PrintModalProps {
  selected: InventoryRow[];
  onClose: () => void;
}

function PrintModal({ selected, onClose }: PrintModalProps) {
  const [labelMode, setLabelMode] = useState<LabelMode>('asin');
  const [size, setSize] = useState<'2x1' | '4x6'>('2x1');
  const [showPrice, setShowPrice] = useState(false);
  const [showBin, setShowBin] = useState(false);
  const [custom, setCustom] = useState({ title: '', subtitle: '', notes: '', sku: '', asin: '', bin: '' });

  const fnskuCount = selected.filter(r => realFnsku(r.fnsku)).length;
  const hasFnsku = fnskuCount > 0;

  function handlePrint() {
    if (labelMode === 'custom') {
      openPrintWindow([{
        labelMode: 'custom', size,
        title:    custom.title    || undefined,
        subtitle: custom.subtitle || undefined,
        notes:    custom.notes    || undefined,
        sku:      custom.sku      || undefined,
        asin:     custom.asin     || undefined,
        bin:      custom.bin      || undefined,
      }]);
      return;
    }

    if (labelMode === 'asin') {
      const specs: LabelSpec[] = selected.map(r => {
        const spec: LabelSpec = {
          labelMode: 'asin', size,
          title: r.product_name || r.asin || '',
          asin: r.asin,
          condition: r.condition || undefined,
        };
        if (showBin && r.bin_location) { spec.showBin = true; spec.bin = r.bin_location; }
        return spec;
      });
      openPrintWindow(specs);
      return;
    }

    if (labelMode === 'fnsku') {
      const rowsWithFnsku = selected
        .map(r => ({ row: r, fnsku: realFnsku(r.fnsku) }))
        .filter((e): e is { row: InventoryRow; fnsku: string } => Boolean(e.fnsku));
      if (rowsWithFnsku.length === 0) { alert('No selected items have a real FNSKU yet.'); return; }
      openPrintWindow(rowsWithFnsku.map(({ row, fnsku }) => ({
        labelMode: 'fnsku', size,
        title: row.product_name || row.asin || '',
        asin: row.asin, fnsku,
        condition: row.condition || undefined,
      })));
      return;
    }

    openPrintWindow(selected.map(r => ({
      labelMode: 'warehouse', size,
      title: r.product_name || r.asin || '',
      asin: r.asin, sku: r.sku || undefined,
      bin: r.bin_location || undefined,
      condition: r.condition || undefined,
      priceCents: r.buy_price, showPrice,
    })));
  }

  const canPrint =
    labelMode === 'custom'
      ? !!(custom.title || custom.subtitle || custom.bin)
      : labelMode === 'fnsku'
        ? selected.length > 0 && selected.some(r => realFnsku(r.fnsku))
        : selected.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-[440px] max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
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
                      type="radio" name="labelMode" value={mode}
                      checked={labelMode === mode} disabled={disabled}
                      onChange={() => setLabelMode(mode)} className="accent-accent shrink-0"
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

          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2">Label Size</div>
            <div className="flex gap-2">
              {(['2x1', '4x6'] as const).map(s => (
                <button
                  key={s} onClick={() => setSize(s)}
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
              {fnskuCount} of {selected.length} selected item{selected.length !== 1 ? 's' : ''} have a real FNSKU.
              Items without FNSKU will be skipped.
            </p>
          )}

          {labelMode === 'custom' && (
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">
                  {size === '4x6' ? 'Large Text (e.g. bin name)' : 'Title'}
                </label>
                <input type="text" value={custom.title}
                  onChange={e => setCustom(c => ({ ...c, title: e.target.value }))}
                  placeholder={size === '4x6' ? 'S1-B3' : 'Label title'}
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">Subtitle</label>
                <input type="text" value={custom.subtitle}
                  onChange={e => setCustom(c => ({ ...c, subtitle: e.target.value }))}
                  placeholder="Optional subtitle"
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">Notes</label>
                <input type="text" value={custom.notes}
                  onChange={e => setCustom(c => ({ ...c, notes: e.target.value }))}
                  placeholder="Optional notes"
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">Bin / Location</label>
                  <input type="text" value={custom.bin}
                    onChange={e => setCustom(c => ({ ...c, bin: e.target.value }))}
                    placeholder="e.g. S1-B3"
                    className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">SKU (optional)</label>
                  <input type="text" value={custom.sku}
                    onChange={e => setCustom(c => ({ ...c, sku: e.target.value }))}
                    placeholder="SKU for barcode"
                    className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
            </div>
          )}

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
                    {realFnsku(r.fnsku) && (
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

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function MerchantInventoryPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [liveOnlyCount, setLiveOnlyCount] = useState(0);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [readyOnly, setReadyOnly] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [receiveRow, setReceiveRow] = useState<InventoryRow | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    fetch('/api/data/merchant-inventory')
      .then(r => r.json())
      .then(d => {
        setRows(d.items || []);
        setLiveOnlyCount((d.liveOnly || []).length);
        setLastSynced(d.lastSynced ?? null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [refreshKey]);

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch('/api/sync/merchant-listings', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setSyncError(data.error || 'Sync failed');
      } else {
        setRefreshKey(k => k + 1);
      }
    } catch {
      setSyncError('Network error');
    } finally {
      setSyncing(false);
    }
  }

  const filtered = useMemo(() => {
    let result = rows;
    if (readyOnly) result = result.filter(r => getStatus(r) === 'ready');
    if (!search.trim()) return result;
    const q = search.toLowerCase();
    return result.filter(r =>
      (r.product_name || '').toLowerCase().includes(q) ||
      (r.asin || '').toLowerCase().includes(q) ||
      (r.sku || '').toLowerCase().includes(q) ||
      (r.supplier_name || '').toLowerCase().includes(q) ||
      (r.bin_location || '').toLowerCase().includes(q)
    );
  }, [rows, search, readyOnly]);

  const readyCount = useMemo(() => rows.filter(r => getStatus(r) === 'ready').length, [rows]);
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
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(r => r.id)));
  }

  const selectedRows = filtered.filter(r => selected.has(r.id));

  function actionLabel(status: ReceiveStatus): string {
    if (status === 'pending') return 'Receive';
    if (status === 'received') return 'Inspect';
    return 'Edit';
  }

  function actionClass(status: ReceiveStatus): string {
    if (status === 'pending') return 'text-accent border-accent/40 hover:bg-accent/10';
    if (status === 'received') return 'text-amber-400 border-amber-400/40 hover:bg-amber-400/10';
    return 'text-text-tertiary border-border-subtle hover:bg-bg-hover';
  }

  return (
    <div>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Merchant Fulfilled Inventory</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Local FlipLedger lots (LV_ SKUs) · Amazon live status via Seller Central sync
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Sync button + status */}
          <div className="flex flex-col items-end gap-0.5">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing…' : 'Sync Amazon'}
            </button>
            {syncError && (
              <p className="text-[10px] text-red-400 max-w-[180px] text-right">{syncError}</p>
            )}
            {lastSynced && !syncError && (
              <p className="text-[10px] text-text-tertiary">
                Last synced {new Date(lastSynced).toLocaleDateString()} {new Date(lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
            {!lastSynced && !syncError && (
              <p className="text-[10px] text-text-tertiary">Not yet synced</p>
            )}
          </div>
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
              className="h-9 pl-9 pr-4 w-72 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Stats bar */}
      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-5 gap-4 mb-4">
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
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-1">Ready to Activate</div>
            <div className="text-2xl font-semibold font-mono text-green-400">{readyCount}</div>
          </div>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-1">Live on Amazon</div>
            <div className="flex items-end gap-2">
              <div className="text-2xl font-semibold font-mono text-text-primary">
                {lastSynced ? rows.filter(r => r.live_state === 'active').length : '—'}
              </div>
              {liveOnlyCount > 0 && (
                <div className="text-[10px] text-amber-400 mb-1 leading-tight">
                  +{liveOnlyCount} not in ledger
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Filter bar */}
      {!loading && rows.length > 0 && (
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => setReadyOnly(v => !v)}
            className={`h-8 px-3 rounded-md text-xs font-medium border transition-colors ${
              readyOnly
                ? 'bg-green-500/10 text-green-400 border-green-500/30'
                : 'bg-bg-elevated text-text-secondary border-border-subtle hover:border-border-default'
            }`}
          >
            {readyOnly ? '✓ Ready Only' : 'Show Ready Only'}
          </button>
          {readyOnly && (
            <span className="text-[11px] text-text-tertiary">
              {filtered.length} lot{filtered.length !== 1 ? 's' : ''} ready to activate
            </span>
          )}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-12 w-full mb-1" />
          ))}
        </div>
      ) : (
        <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-x-auto">
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
                <th className="px-3 py-2.5 w-10" />
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary">Product</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-28">Status</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-28">Amazon</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Bin</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Condition</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-16">Stock</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-16">Rcvd</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">List</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Cost</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-10 text-center text-text-tertiary text-sm">
                    {readyOnly
                      ? 'No lots are ready to activate yet. Receive and inspect inventory first.'
                      : search
                        ? 'No items match your search.'
                        : 'No in-stock inventory found.'}
                  </td>
                </tr>
              ) : (
                filtered.map(row => {
                  const isSelected = selected.has(row.id);
                  const status = getStatus(row);
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
                        <div className="text-sm text-text-primary font-medium truncate max-w-[240px]" title={row.product_name || row.asin}>
                          {row.product_name || row.asin}
                        </div>
                        <div className="text-[10px] text-text-tertiary font-mono">{row.asin}</div>
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge status={status} />
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex flex-col gap-0.5">
                          <LiveStateBadge state={row.live_state} />
                          {row.live_quantity != null && row.live_state !== 'not_listed' && (
                            <span className="text-[10px] font-mono text-text-tertiary">{row.live_quantity} live</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        {row.bin_location
                          ? <span className="inline-flex items-center px-2 py-0.5 rounded bg-accent/10 text-accent text-xs font-mono font-medium">{row.bin_location}</span>
                          : <span className="text-text-tertiary text-xs">—</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-text-secondary">{row.condition || '—'}</td>
                      <td className="px-4 py-2 text-right font-mono text-sm text-text-primary font-medium">{row.quantity_remaining}</td>
                      <td className="px-4 py-2 text-right font-mono text-sm">
                        {row.quantity_received != null
                          ? <span className={row.quantity_received < row.quantity ? 'text-amber-400' : 'text-text-secondary'}>
                              {row.quantity_received}
                            </span>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-sm">
                        {row.list_price_cents != null
                          ? <span className="text-text-primary">{formatCurrency(row.list_price_cents)}</span>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-sm text-text-secondary">{formatCurrency(row.buy_price)}</td>
                      <td className="px-4 py-2 text-right" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => setReceiveRow(row)}
                          className={`h-7 px-3 rounded-md text-xs font-medium border transition-colors ${actionClass(status)}`}
                        >
                          {actionLabel(status)}
                        </button>
                      </td>
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
              {readyCount > 0 && (
                <span className="text-green-400">{readyCount} ready to activate</span>
              )}
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

      {receiveRow && (
        <ReceiveModal
          row={receiveRow}
          onClose={() => setReceiveRow(null)}
          onSaved={() => { setRefreshKey(k => k + 1); setReceiveRow(null); }}
        />
      )}
    </div>
  );
}
