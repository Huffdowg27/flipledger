'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/formatters';
import { Search, Printer, X, Check, CheckCircle2, RefreshCw, Copy, Download, Loader2, Package } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RowSource  = 'matched' | 'live_only' | 'local_only';
type LiveState  = 'active' | 'oos' | 'inactive' | 'not_listed';
type FilterView = 'live' | 'oos' | 'inactive' | 'local_only' | 'ready' | null;
type ReceiveStatus = 'pending' | 'received' | 'inspected' | 'ready';

interface MerchantRow {
  row_key: string;
  row_source: RowSource;

  // Identity
  asin: string;
  sku: string;

  // Amazon data — null for local_only rows
  ml_id: number | null;
  amazon_qty: number | null;
  amazon_status: string | null;
  amazon_list_price_cents: number | null;
  last_synced: string | null;
  live_state: LiveState;

  // Local lot data — null for live_only rows
  il_id: number | null;
  quantity: number | null;
  quantity_remaining: number | null;
  buy_price: number | null;
  date_purchased: string | null;
  bin_location: string | null;
  condition: string | null;
  quantity_received: number | null;
  received_at: string | null;
  inspected_at: string | null;
  receive_notes: string | null;
  il_list_price_cents: number | null;
  merchant_shipping_group_name: string | null;

  // Product metadata
  product_name: string | null;
  image_url: string | null;
  fnsku: string | null;
  supplier_name: string | null;
  category: string | null;

  // Parsed from MSKU — read-only, no DB source
  parsed_cost_cents: number | null;
  parsed_list_price_cents: number | null;
  parsed_order_qty: number | null;
  parsed_date: string | null;
  sku_parse_status: 'parsed' | 'unparsed';
}

// Activation preview/push UI lives in /mfn/batch — this page is read-only.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getReceiveStatus(row: MerchantRow): ReceiveStatus | null {
  if (row.il_id == null) return null;
  const received = (row.quantity_received ?? 0) > 0 && row.received_at != null;
  const inspected = received && row.inspected_at != null;
  const ready =
    inspected &&
    !!(row.bin_location?.trim()) &&
    !!(row.condition?.trim()) &&
    (row.il_list_price_cents ?? 0) > 0;
  if (ready) return 'ready';
  if (inspected) return 'inspected';
  if (received) return 'received';
  return 'pending';
}

function realFnsku(value: string | null | undefined): string | null {
  const f = String(value || '').trim().toUpperCase();
  return /^X00[A-Z0-9]+$/.test(f) ? f : null;
}

// Deep-link an MSKU to its listing in Seller Central inventory.
function sellerCentralSkuUrl(sku: string | null | undefined): string | null {
  const value = (sku ?? '').trim();
  return value
    ? `https://sellercentral.amazon.com/myinventory/inventory?searchField=all&searchTerm=${encodeURIComponent(value)}`
    : null;
}

// Labeled identifier with copy button — Prep Ship Hub-style product info block.
// When `href` is set, the value becomes a link (opens in a new tab).
function IdentifierChip({ label, value, href }: { label: string; value: string | null | undefined; href?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-1 min-w-0">
      <span className="text-text-tertiary/60 uppercase tracking-wide shrink-0">{label}</span>
      {href
        ? <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-accent truncate hover:underline"
            title={`Open ${label} in Seller Central: ${value}`}
          >
            {value}
          </a>
        : <span className="text-text-secondary truncate" title={value}>{value}</span>}
      <button
        onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(value); }}
        title={`Copy ${label}: ${value}`}
        className="shrink-0 text-text-tertiary/40 hover:text-text-tertiary transition-colors"
      >
        <Copy size={10} />
      </button>
    </div>
  );
}

function openPrintWindow(specs: LabelSpec[]) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(specs))));
  window.open(`/api/labels/print?d=${encodeURIComponent(encoded)}`, '_blank');
}

// ---------------------------------------------------------------------------
// Activation CSV export — Phase 1: generate file for manual Seller Central upload.
// No Amazon writes. No DB writes. Pure client-side computation.
//
// Column names match Amazon's Inventory Loader flat file template exactly:
//   merchant-shipping-group-name — shipping template name (Seller Central
//     Settings → Shipping Settings → Shipping Templates). Must match the exact
//     template name on the account. Update DEFAULT_MFN_SHIPPING_TEMPLATE below.
//
// Price priority: receive-modal price (il_list_price_cents)
//                → Amazon current price (amazon_list_price_cents)
//                → MSKU-parsed estimate (parsed_list_price_cents)
// Quantity: quantity_received (physically inspected count) → quantity_remaining
// ---------------------------------------------------------------------------

// Update this constant to match the exact shipping template name in Seller Central.
// Seller Central → Settings → Shipping Settings → Shipping Templates.
// The template name seen in synced listing data for this account was:
//   'DEFAULT MFN USE THIS ONE'
// Verify it in Seller Central before uploading any CSV.
const DEFAULT_MFN_SHIPPING_TEMPLATE = 'DEFAULT MFN USE THIS ONE';

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

const RECEIVE_STATUS_STYLES: Record<ReceiveStatus, string> = {
  pending:   'bg-bg-elevated text-text-tertiary border-border-subtle',
  received:  'bg-blue-500/10 text-blue-400 border-blue-500/30',
  inspected: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  ready:     'bg-green-500/10 text-green-400 border-green-500/30',
};

const RECEIVE_STATUS_LABELS: Record<ReceiveStatus, string> = {
  pending: 'Pending', received: 'Received', inspected: 'Inspected', ready: 'Ready',
};

const LIVE_STATE_STYLES: Record<LiveState, string> = {
  active:     'bg-green-500/10 text-green-400 border-green-500/30',
  oos:        'bg-amber-500/10 text-amber-400 border-amber-500/30',
  inactive:   'bg-red-500/10 text-red-400 border-red-500/30',
  not_listed: 'bg-bg-elevated text-text-tertiary border-border-subtle',
};

const LIVE_STATE_LABELS: Record<LiveState, string> = {
  active:     'Live',
  oos:        'OOS',
  inactive:   'Inactive',
  not_listed: 'Not Listed',
};

// ---------------------------------------------------------------------------
// Badge components
// ---------------------------------------------------------------------------

function ReceiveStatusBadge({ status }: { status: ReceiveStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${RECEIVE_STATUS_STYLES[status]}`}>
      {RECEIVE_STATUS_LABELS[status]}
    </span>
  );
}

function LiveStateBadge({ state }: { state: LiveState }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${LIVE_STATE_STYLES[state]}`}>
      {LIVE_STATE_LABELS[state]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Label types
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
  row: MerchantRow;
  title?: string;
  onClose: () => void;
  onSaved: () => void;
}

function ReceiveModal({ row, title = 'Update Stock', onClose, onSaved }: ReceiveModalProps) {
  const status = getReceiveStatus(row) ?? 'pending';
  const isReceived = status !== 'pending';
  const isInspected = status === 'inspected' || status === 'ready';

  const [qtyReceived, setQtyReceived] = useState(
    row.quantity_received != null
      ? String(row.quantity_received)
      : String(row.quantity_remaining ?? 0)
  );
  const [receiveNotes, setReceiveNotes] = useState(row.receive_notes ?? '');
  const [listPrice, setListPrice] = useState(
    row.il_list_price_cents != null ? (row.il_list_price_cents / 100).toFixed(2) : ''
  );
  const [bin, setBin] = useState(row.bin_location ?? '');
  const [condition, setCondition] = useState(row.condition ?? '');
  const [markInspected, setMarkInspected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qtyNum = Number(qtyReceived);
  const listPriceNum = parseFloat(listPrice);
  const willBeReceived = isReceived || (Number.isFinite(qtyNum) && qtyNum > 0);

  const preview = {
    qty:       Number.isFinite(qtyNum) && qtyNum > 0,
    inspected: isInspected || (willBeReceived && markInspected),
    bin:       !!(bin.trim()),
    condition: !!(condition.trim()),
    price:     !!(listPrice.trim()) && Number.isFinite(listPriceNum) && listPriceNum > 0,
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

      const body: Record<string, unknown> = { id: row.il_id };

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
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
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
              {sellerCentralSkuUrl(row.sku)
                ? <a
                    href={sellerCentralSkuUrl(row.sku)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="block text-[11px] font-mono text-accent truncate hover:underline"
                    title={`Open MSKU in Seller Central: ${row.sku}`}
                  >
                    {row.sku}
                  </a>
                : <div className="text-[11px] font-mono text-text-tertiary truncate">{row.sku}</div>}
              {row.quantity != null && row.buy_price != null && (
                <div className="text-[11px] text-text-secondary">
                  {row.quantity} purchased · {formatCurrency(row.buy_price)}/unit
                </div>
              )}
            </div>
            <ReceiveStatusBadge status={status} />
          </div>

          {allReady && (
            <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-xs font-medium">
              <CheckCircle2 size={14} />
              Ready to Activate — all required fields set
            </div>
          )}

          {/* Receive */}
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2.5">Receive</div>
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">
                  Quantity Received
                  <span className="ml-1 text-text-tertiary/60">
                    (default: {row.quantity_remaining ?? 0} in stock)
                  </span>
                </label>
                <input
                  type="number" min="0" step="1"
                  value={qtyReceived}
                  onChange={e => setQtyReceived(e.target.value)}
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
                {row.quantity_received != null && row.quantity != null && row.quantity_received !== row.quantity && (
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

          {/* Details */}
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2.5">Details</div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">List Price ($)</label>
                  <input
                    type="number" min="0" step="0.01"
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
                  {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Inspection */}
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
                  {!willBeReceived && <span className="text-text-tertiary ml-1">— receive first</span>}
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
                  { label: 'Inspected',         met: preview.inspected },
                  { label: 'Bin location',       met: preview.bin },
                  { label: 'Condition',          met: preview.condition },
                  { label: 'List price',         met: preview.price },
                ].map(({ label, met }) => (
                  <div key={label} className={`flex items-center gap-2 text-[11px] ${met ? 'text-green-400' : 'text-text-tertiary'}`}>
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
// PrintModal
// ---------------------------------------------------------------------------

const LABEL_MODES: { mode: LabelMode; label: string; desc: string }[] = [
  { mode: 'asin',      label: 'ASIN Label',              desc: 'Customer Safe' },
  { mode: 'warehouse', label: 'Internal Warehouse Label', desc: 'Internal use only' },
  { mode: 'fnsku',     label: 'FNSKU Label',              desc: 'Requires real FNSKU' },
  { mode: 'custom',    label: 'Custom Label',             desc: 'Free-text' },
];

interface PrintModalProps {
  selected: MerchantRow[];
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
          title: r.product_name || r.asin,
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
        .filter((e): e is { row: MerchantRow; fnsku: string } => Boolean(e.fnsku));
      if (rowsWithFnsku.length === 0) { alert('No selected items have a real FNSKU yet.'); return; }
      openPrintWindow(rowsWithFnsku.map(({ row, fnsku }) => ({
        labelMode: 'fnsku', size,
        title: row.product_name || row.asin,
        asin: row.asin, fnsku,
        condition: row.condition || undefined,
      })));
      return;
    }

    openPrintWindow(selected.map(r => ({
      labelMode: 'warehouse', size,
      title: r.product_name || r.asin,
      asin: r.asin, sku: r.sku || undefined,
      bin: r.bin_location || undefined,
      condition: r.condition || undefined,
      priceCents: r.buy_price ?? 0,
      showPrice,
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
                <div key={r.row_key} className="flex items-center gap-2 py-1 border-b border-border-subtle/50 last:border-0">
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
  const [listedRows, setListedRows]     = useState<MerchantRow[]>([]);
  const [localOnlyRows, setLocalOnlyRows] = useState<MerchantRow[]>([]);
  const [lastSynced, setLastSynced]     = useState<string | null>(null);
  const [loading, setLoading]           = useState(true);
  const [syncing, setSyncing]           = useState(false);
  const [syncError, setSyncError]       = useState<string | null>(null);
  const [search, setSearch]             = useState('');
  const [filterView, setFilterView]     = useState<FilterView>('live');
  const [selected, setSelected]         = useState<Set<string>>(new Set());
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [receiveRow, setReceiveRow]         = useState<MerchantRow | null>(null);
  const [receiveModalTitle, setReceiveModalTitle] = useState('Update Stock');
  const [refreshKey, setRefreshKey]         = useState(0);
  const [lightbox, setLightbox]             = useState<{ src: string; title: string; asin: string | null; sku: string | null } | null>(null);
  const [backfilling, setBackfilling]       = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{ done: number; remaining: number } | null>(null);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  async function handleBackfillImages() {
    setBackfilling(true);
    setBackfillProgress(null);
    let done = 0;
    try {
      for (let i = 0; i < 200; i++) {
        const res = await fetch('/api/data/merchant-inventory/backfill-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 100 }),
        });
        const data = await res.json();
        if (!res.ok) break;
        done += data.updated ?? 0;
        setBackfillProgress({ done, remaining: data.remaining ?? 0 });
        if ((data.remaining ?? 0) <= 0 || (data.processed ?? 0) === 0) break;
      }
      setRefreshKey(k => k + 1);
    } catch {
      /* network error — stop the loop */
    } finally {
      setBackfilling(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    fetch('/api/data/merchant-inventory')
      .then(r => r.json())
      .then(d => {
        setListedRows(d.listed || []);
        setLocalOnlyRows(d.localOnly || []);
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

  // Counts (always from full datasets, unaffected by filter/search)
  const liveCount      = useMemo(() => listedRows.filter(r => r.live_state === 'active').length,   [listedRows]);
  const oosCount       = useMemo(() => listedRows.filter(r => r.live_state === 'oos').length,      [listedRows]);
  const inactiveCount  = useMemo(() => listedRows.filter(r => r.live_state === 'inactive').length, [listedRows]);
  const localOnlyCount = localOnlyRows.length;
  // Per-tile units + inventory cost (open local lots at buy price, integer cents)
  const tileStats = useMemo(() => {
    const mk = () => ({ units: 0, costCents: 0 });
    const acc: Record<string, { units: number; costCents: number }> = {
      all: mk(), live: mk(), oos: mk(), inactive: mk(), local_only: mk(),
    };
    const add = (key: string, r: MerchantRow) => {
      const q = r.quantity_remaining ?? 0;
      if (q <= 0) return;
      acc[key].units += q;
      acc[key].costCents += q * (r.buy_price ?? 0);
    };
    for (const r of listedRows) {
      add('all', r);
      if (r.live_state === 'active') add('live', r);
      else if (r.live_state === 'oos') add('oos', r);
      else if (r.live_state === 'inactive') add('inactive', r);
    }
    for (const r of localOnlyRows) add('local_only', r);
    return acc;
  }, [listedRows, localOnlyRows]);

  // Display rows based on active filter.
  // null = All Amazon listings (the broadest view).
  // Default on page load is 'live' so the working view is immediately useful.
  const baseRows = useMemo((): MerchantRow[] => {
    switch (filterView) {
      case 'live':      return listedRows.filter(r => r.live_state === 'active');
      case 'oos':       return listedRows.filter(r => r.live_state === 'oos');
      case 'inactive':  return listedRows.filter(r => r.live_state === 'inactive');
      case 'local_only':return localOnlyRows;
      case 'ready':     return [...listedRows, ...localOnlyRows].filter(r => getReceiveStatus(r) === 'ready');
      default:          return listedRows; // null = All Amazon listings
    }
  }, [listedRows, localOnlyRows, filterView]);

  const displayRows = useMemo(() => {
    if (!search.trim()) return baseRows;
    const q = search.toLowerCase();
    return baseRows.filter(r =>
      (r.product_name || '').toLowerCase().includes(q) ||
      r.asin.toLowerCase().includes(q) ||
      r.sku.toLowerCase().includes(q) ||
      (r.bin_location || '').toLowerCase().includes(q)
    );
  }, [baseRows, search]);

  function setFilter(v: FilterView) {
    setFilterView(prev => prev === v ? null : v);
    setSelected(new Set());
  }

  function toggleRow(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === displayRows.length) setSelected(new Set());
    else setSelected(new Set(displayRows.map(r => r.row_key)));
  }

  const selectedRows = displayRows.filter(r => selected.has(r.row_key));

  // Rows available for activation export: selection-scoped when rows are selected,
  // otherwise all displayed rows when the Ready filter is active.
  // Stock action — determines the Action column button for each row.
  // Rules:
  //   no il_id        → null (no local lot, can't edit)
  //   active (live)   → Edit Stock (neutral)
  //   oos             → Restock (amber — highest priority workflow)
  //   inactive        → Review (neutral, low priority)
  //   not_listed      → Receive / Inspect / Edit based on receive status
  function getStockAction(row: MerchantRow): {
    label: string;
    cls: string;
    modalTitle: string;
  } | null {
    if (row.il_id == null) return null;

    if (row.live_state === 'active') {
      // Live rows: only prompt action if local receive work is still needed
      const status = getReceiveStatus(row);
      if (!status) return null;
      return {
        label: status === 'pending' ? 'Receive' : status === 'received' ? 'Inspect' : 'Edit Local',
        cls:
          status === 'pending'
            ? 'text-accent border-accent/40 hover:bg-accent/10'
            : status === 'received'
              ? 'text-amber-400 border-amber-400/40 hover:bg-amber-400/10'
              : 'text-text-tertiary border-border-subtle hover:bg-bg-hover',
        modalTitle: 'Update Stock',
      };
    }
    if (row.live_state === 'oos') {
      const status = getReceiveStatus(row);
      return {
        label: !status || status === 'pending' ? 'Receive' : status === 'received' ? 'Inspect' : 'Edit Local',
        cls:
          !status || status === 'pending'
            ? 'text-amber-400 border-amber-400/40 hover:bg-amber-400/10'
            : status === 'received'
              ? 'text-amber-400 border-amber-400/40 hover:bg-amber-400/10'
              : 'text-text-tertiary border-border-subtle hover:bg-bg-hover',
        modalTitle: 'Restock Item',
      };
    }
    if (row.live_state === 'inactive') {
      const status = getReceiveStatus(row);
      return {
        label: !status || status === 'pending' ? 'Receive' : status === 'received' ? 'Inspect' : 'Edit Local',
        cls:
          !status || status === 'pending'
            ? 'text-accent border-accent/40 hover:bg-accent/10'
            : status === 'received'
              ? 'text-amber-400 border-amber-400/40 hover:bg-amber-400/10'
              : 'text-text-tertiary border-border-subtle hover:bg-bg-hover',
        modalTitle: 'Update Stock',
      };
    }
    // not_listed (local_only)
    const status = getReceiveStatus(row);
    if (!status) return null;
    return {
      label: status === 'pending' ? 'Receive' : status === 'received' ? 'Inspect' : 'Edit Local',
      cls:
        status === 'pending'
          ? 'text-accent border-accent/40 hover:bg-accent/10'
          : status === 'received'
            ? 'text-amber-400 border-amber-400/40 hover:bg-amber-400/10'
            : 'text-text-tertiary border-border-subtle hover:bg-bg-hover',
      modalTitle: 'Receive Inventory',
    };
  }

  const hasData = !loading && (listedRows.length > 0 || localOnlyRows.length > 0);

  return (
    <div>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Merchant Inventory</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Read-only visibility · Amazon MFN listings (LV_ SKUs) enriched with local lot data · receive and push happen in <Link href="/list" className="text-accent hover:underline">Batches</Link>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Sync */}
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
            {lastSynced && !syncError && (() => {
              const ageMs = Date.now() - new Date(lastSynced).getTime();
              const stale = ageMs > 2 * 3600 * 1000;
              return (
                <p className={`text-[10px] ${stale ? 'text-amber-400' : 'text-text-tertiary'}`}>
                  {stale && '⚠ Stale — '}Synced {new Date(lastSynced).toLocaleDateString()} {new Date(lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              );
            })()}
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
            onClick={handleBackfillImages}
            disabled={backfilling}
            className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-60"
            title="Fetch missing product images from Amazon's catalog"
          >
            {backfilling ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {backfilling
              ? `Fetching images… ${backfillProgress ? `${backfillProgress.done} done, ${backfillProgress.remaining} left` : ''}`
              : 'Backfill Images'}
          </button>
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
              placeholder="Search title, ASIN, SKU, or bin…"
              className="h-9 pl-9 pr-4 w-64 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Filter / stat cards — clicking selects the filter; clicking again returns to Live */}
      {hasData && (
        <div className="grid grid-cols-5 gap-2.5 mb-6">
          {([
            { id: null         as FilterView, label: 'All Listings',      count: listedRows.length, activeColor: 'border-text-tertiary/40 bg-bg-elevated shadow-sm',  numColor: 'text-text-primary'   },
            { id: 'live'       as FilterView, label: 'Live on Amazon',    count: liveCount,          activeColor: 'border-green-500 bg-green-500/10 shadow-sm',        numColor: 'text-green-400'      },
            { id: 'oos'        as FilterView, label: 'OOS',               count: oosCount,           activeColor: 'border-amber-500 bg-amber-500/10 shadow-sm',        numColor: 'text-amber-400'      },
            { id: 'inactive'   as FilterView, label: 'Inactive',          count: inactiveCount,      activeColor: 'border-red-500 bg-red-500/10 shadow-sm',            numColor: 'text-red-400'        },
            { id: 'local_only' as FilterView, label: 'Local Not Listed',  count: localOnlyCount,     activeColor: 'border-border-default bg-bg-elevated shadow-sm',    numColor: 'text-text-secondary' },
          ] as const).map(card => {
            const isActive = filterView === card.id;
            return (
              <button
                key={String(card.id)}
                onClick={() => setFilter(card.id)}
                className={`text-left p-3.5 rounded-lg transition-all ${
                  isActive
                    ? `border-2 ${card.activeColor}`
                    : 'border border-border-subtle bg-bg-surface hover:border-border-default hover:bg-bg-hover'
                }`}
              >
                <div className="text-[10px] uppercase tracking-widest text-text-tertiary mb-1 truncate">{card.label}</div>
                <div className={`text-2xl font-semibold font-mono ${isActive ? card.numColor : 'text-text-primary'}`}>
                  {lastSynced || card.id === 'local_only' || card.id === null ? card.count : '—'}
                </div>
                {(() => {
                  const s = tileStats[card.id === null ? 'all' : card.id];
                  return s && (s.units > 0 || s.costCents > 0) ? (
                    <div className="text-[10px] font-mono text-text-tertiary mt-0.5 truncate">
                      {s.units.toLocaleString()} units · {'$' + Math.round(s.costCents / 100).toLocaleString('en-US')}
                    </div>
                  ) : null;
                })()}
                {isActive && (
                  <div className="text-[10px] text-text-tertiary mt-1">active</div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* OOS restock banner */}
      {filterView === 'oos' && !loading && (
        <div className="mb-4 flex items-start gap-2.5 px-3.5 py-2.5 bg-amber-500/5 border border-amber-500/20 rounded-lg text-xs text-text-secondary">
          <RefreshCw size={13} className="text-amber-400 shrink-0 mt-0.5" />
          <span>
            <span className="font-medium text-text-primary">Out of Stock on Amazon</span>{' '}
            — these listings are Active but Amazon quantity is 0.
            Click <span className="font-medium text-amber-400">Restock</span> to enter received quantity, bin location, condition, and list price.
            Once all fields are set, push it live from <span className="font-medium text-text-primary">MFN Batch Receive</span>.
          </span>
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
                    checked={displayRows.length > 0 && selected.size === displayRows.length}
                    ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < displayRows.length; }}
                    onChange={toggleAll}
                    className="accent-accent cursor-pointer"
                  />
                </th>
                <th className="px-3 py-2.5 w-20" />
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary">Product</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Amazon</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-28">Receive</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Bin</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-28">Condition</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-16">Amz Qty</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-16">Local</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">List</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Cost</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Action</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-10 text-center text-text-tertiary text-sm">
                    {!lastSynced
                      ? 'No Amazon data yet — click Sync Amazon to pull live MFN listings.'
                      : filterView === 'live'
                        ? 'No live Amazon listings found.'
                        : filterView === 'oos'
                          ? 'No out-of-stock Amazon listings.'
                          : filterView === 'inactive'
                            ? 'No inactive listings found.'
                            : filterView === 'local_only'
                              ? 'All local lots have a matching Amazon listing.'
                              : filterView === 'ready'
                                ? 'No lots are ready to activate yet.'
                                : search
                                  ? 'No items match your search.'
                                  : 'No MFN listings found.'}
                  </td>
                </tr>
              ) : (
                displayRows.map(row => {
                  const isSelected = selected.has(row.row_key);
                  const stockAction = getStockAction(row);
                  const localReceiveStatus = row.il_id != null ? getReceiveStatus(row) : null;
                  // List price: Amazon source of truth first, then parsed from MSKU, then ledger value.
                  const listPrice = row.amazon_list_price_cents ?? row.parsed_list_price_cents ?? row.il_list_price_cents;
                  // Cost: ledger buy_price is authoritative; fall back to MSKU-parsed cost.
                  const displayCost = row.buy_price ?? row.parsed_cost_cents;

                  return (
                    <tr
                      key={row.row_key}
                      onClick={() => toggleRow(row.row_key)}
                      className={`border-b border-border-subtle/50 cursor-pointer transition-colors ${
                        isSelected ? 'bg-accent/5 hover:bg-accent/10' : 'hover:bg-bg-hover'
                      }`}
                    >
                      <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(row.row_key)}
                          className="accent-accent cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-3">
                        {row.image_url
                          ? <button
                              onClick={e => { e.stopPropagation(); setLightbox({ src: row.image_url!, title: row.product_name || row.asin, asin: row.asin, sku: row.sku }); }}
                              className="block cursor-zoom-in"
                              title="View larger image"
                            >
                              <img src={row.image_url} alt="" className="w-16 h-16 object-contain rounded-lg bg-white border border-border-subtle p-1 hover:border-accent transition-colors" />
                            </button>
                          : <div className="w-16 h-16 bg-bg-elevated rounded-lg border border-border-subtle flex items-center justify-center"><Package size={20} className="text-text-tertiary/40" /></div>}
                      </td>
                      <td className="px-4 py-3 max-w-[360px]">
                        <a
                          href={`https://www.amazon.com/dp/${row.asin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-sm text-accent font-medium leading-snug line-clamp-2 hover:underline"
                          title={row.product_name || row.asin}
                        >
                          {row.product_name || row.asin}
                        </a>
                        <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] font-mono">
                          <IdentifierChip label="ASIN" value={row.asin} />
                          <IdentifierChip label="MSKU" value={row.sku} href={sellerCentralSkuUrl(row.sku)} />
                          {realFnsku(row.fnsku) && <IdentifierChip label="FNSKU" value={realFnsku(row.fnsku)} />}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <LiveStateBadge state={row.live_state} />
                      </td>
                      <td className="px-4 py-2">
                        {localReceiveStatus != null
                          ? <ReceiveStatusBadge status={localReceiveStatus} />
                          : row.il_id == null
                            ? <span className="text-text-tertiary text-[10px] italic">No local lot</span>
                            : <span className="text-text-tertiary text-xs">—</span>}
                      </td>
                      <td className="px-4 py-2">
                        {row.bin_location
                          ? <span className="inline-flex items-center px-2 py-0.5 rounded bg-accent/10 text-accent text-xs font-mono font-medium">{row.bin_location}</span>
                          : <span className="text-text-tertiary text-xs">—</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-text-secondary">
                        {row.condition || <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-sm">
                        {row.amazon_qty != null
                          ? <span className={row.amazon_qty === 0 ? 'text-amber-400' : 'text-text-primary font-medium'}>{row.amazon_qty}</span>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-sm">
                        {row.quantity_remaining != null
                          ? <span className="text-text-secondary">{row.quantity_remaining}</span>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-sm">
                        {listPrice != null
                          ? <span className="text-text-primary">{formatCurrency(listPrice)}</span>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-sm">
                        {displayCost != null
                          ? <span className={`${row.buy_price == null ? 'text-text-tertiary/70' : 'text-text-secondary'}`} title={row.buy_price == null ? 'Estimated from MSKU' : undefined}>
                              {formatCurrency(displayCost)}
                            </span>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right" onClick={e => e.stopPropagation()}>
                        {stockAction ? (
                          <button
                            onClick={() => {
                              setReceiveModalTitle(stockAction.modalTitle);
                              setReceiveRow(row);
                            }}
                            className={`h-7 px-3 rounded-md text-xs font-medium border transition-colors ${stockAction.cls}`}
                          >
                            {stockAction.label}
                          </button>
                        ) : row.il_id == null ? (
                          <span className="text-text-tertiary text-[10px]">No local lot</span>
                        ) : (
                          <span className="text-text-tertiary text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

          {displayRows.length > 0 && (
            <div className="px-4 py-2 border-t border-border-subtle bg-bg-elevated/40 text-xs text-text-tertiary flex gap-4 items-center">
              <span>{displayRows.length} {displayRows.length === 1 ? 'listing' : 'listings'}</span>
              {filterView && (
                <button
                  onClick={() => setFilter(filterView)}
                  className="text-accent hover:underline"
                >
                  Clear filter
                </button>
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
          title={receiveModalTitle}
          onClose={() => setReceiveRow(null)}
          onSaved={() => { setRefreshKey(k => k + 1); setReceiveRow(null); }}
        />
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setLightbox(null)}
        >
          <div
            className="relative flex flex-col bg-white rounded-xl overflow-hidden shadow-2xl max-w-[92vw] max-h-[92vh]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 bg-bg-elevated border-b border-border-subtle px-5 py-3.5">
              <div className="min-w-0">
                <div className="text-text-primary text-base font-semibold leading-snug line-clamp-2">{lightbox.title}</div>
                <div className="mt-1 flex gap-4 text-[11px] font-mono text-text-tertiary">
                  {lightbox.asin && <span>ASIN {lightbox.asin}</span>}
                  {lightbox.sku && (
                    sellerCentralSkuUrl(lightbox.sku)
                      ? <a href={sellerCentralSkuUrl(lightbox.sku)!} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline" title={`Open MSKU in Seller Central: ${lightbox.sku}`}>MSKU {lightbox.sku}</a>
                      : <span>MSKU {lightbox.sku}</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setLightbox(null)}
                className="ml-auto shrink-0 flex items-center justify-center w-9 h-9 rounded-full text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
                title="Close (Esc)"
              >
                <X size={20} />
              </button>
            </div>
            <img
              src={lightbox.src.replace(/\._[A-Z0-9,]+_\.(jpg|jpeg|png)/i, '.$1')}
              alt={lightbox.title}
              className="h-[80vh] w-auto max-w-[92vw] object-contain bg-white"
            />
          </div>
        </div>
      )}

    </div>
  );
}
