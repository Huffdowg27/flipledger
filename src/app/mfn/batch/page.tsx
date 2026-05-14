'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { formatCurrency } from '@/lib/formatters';
import { Search, X, Plus, CheckCircle2, AlertCircle, Loader2, Save, PackagePlus } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  ml_id: number | null;
  il_id: number | null;
  asin: string;
  sku: string;
  amazon_qty: number | null;
  amazon_status: string | null;
  amazon_list_price_cents: number | null;
  product_name: string | null;
  image_url: string | null;
  buy_price: number | null;
  il_list_price_cents: number | null;
  bin_location: string | null;
  condition: string | null;
  quantity_received: number | null;
  quantity_remaining: number | null;
  received_at: string | null;
  inspected_at: string | null;
  merchant_shipping_group_name: string | null;
  parsed_cost_cents: number | null;
  parsed_list_price_cents: number | null;
  parsed_order_qty: number | null;
  sku_parse_status: 'parsed' | 'unparsed';
  referral_fee_cents: number | null;
  fee_list_price_cents: number | null;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type CreateLotState = 'idle' | 'creating' | 'error';

interface BatchItem extends SearchResult {
  draft_qty: string;
  draft_bin: string;
  draft_condition: string;
  draft_list_price: string;
  draft_buy_price: string;
  draft_shipping_template: string;
  draft_shipping_est: string;
  save_state: SaveState;
  save_error: string | null;
  create_lot_state: CreateLotState;
  create_lot_error: string | null;
}

const CONDITIONS = [
  'New',
  'Used - Like New',
  'Used - Very Good',
  'Used - Good',
  'Used - Acceptable',
];

const DEFAULT_SHIPPING_TEMPLATE = 'DEFAULT MFN USE THIS ONE';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function liveStateBadge(status: string | null, qty: number | null) {
  if (!status) return null;
  if (status === 'Active' && (qty ?? 0) > 0) {
    return <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/10 text-green-400 border border-green-500/20">Live</span>;
  }
  if (status === 'Active' && (qty ?? 0) === 0) {
    return <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">OOS</span>;
  }
  if (status === 'Inactive' || status === 'Incomplete') {
    return <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">{status}</span>;
  }
  return null;
}

function makeBatchItem(r: SearchResult): BatchItem {
  const costCents = r.buy_price ?? r.parsed_cost_cents;
  const priceCents = r.il_list_price_cents ?? r.amazon_list_price_cents ?? r.parsed_list_price_cents;
  return {
    ...r,
    draft_qty:               String(r.quantity_received ?? r.quantity_remaining ?? 1),
    draft_bin:               r.bin_location ?? '',
    draft_condition:         r.condition ?? '',
    draft_list_price:        priceCents != null ? (priceCents / 100).toFixed(2) : '',
    draft_buy_price:         costCents   != null ? (costCents  / 100).toFixed(2) : '',
    draft_shipping_template: r.merchant_shipping_group_name ?? DEFAULT_SHIPPING_TEMPLATE,
    draft_shipping_est:      '8.00',
    save_state:              'idle',
    save_error:              null,
    create_lot_state:        'idle',
    create_lot_error:        null,
  };
}

// ---------------------------------------------------------------------------
// Profit calculator (display only — no DB writes)
// ---------------------------------------------------------------------------

interface ProfitCalc {
  netCents: number | null;
  roiPct: number | null;
  listCents: number | null;
  costCents: number | null;
  shipCents: number;
  feeCents: number | null;
  hasFee: boolean;
}

function calcProfit(item: BatchItem): ProfitCalc {
  const listRaw  = parseFloat(item.draft_list_price);
  const listCents = Number.isFinite(listRaw) && listRaw > 0 ? Math.round(listRaw * 100) : null;

  // For existing lots, cost is locked in from buy_price; for new lots use the draft field
  const costRaw  = item.il_id != null
    ? (item.buy_price ?? (item.draft_buy_price ? parseFloat(item.draft_buy_price) * 100 : null))
    : (item.draft_buy_price ? parseFloat(item.draft_buy_price) * 100 : null);
  const costCents = costRaw != null && Number.isFinite(costRaw) && costRaw >= 0
    ? Math.round(costRaw) : null;

  const shipRaw  = parseFloat(item.draft_shipping_est);
  const shipCents = Number.isFinite(shipRaw) && shipRaw >= 0 ? Math.round(shipRaw * 100) : 800;

  const feeCents = item.referral_fee_cents != null ? Number(item.referral_fee_cents) : null;
  const hasFee   = feeCents != null;

  if (listCents == null || costCents == null) {
    return { netCents: null, roiPct: null, listCents, costCents, shipCents, feeCents, hasFee };
  }

  const netCents = listCents - costCents - shipCents - (feeCents ?? 0);
  const roiPct   = costCents > 0 ? (netCents / costCents) * 100 : null;
  return { netCents, roiPct, listCents, costCents, shipCents, feeCents, hasFee };
}

// ---------------------------------------------------------------------------
// SearchResultCard
// ---------------------------------------------------------------------------

interface SearchResultCardProps {
  result: SearchResult;
  inBatch: boolean;
  onAdd: () => void;
}

function SearchResultCard({ result, inBatch, onAdd }: SearchResultCardProps) {
  const displayCost = result.buy_price ?? result.parsed_cost_cents;
  const displayPrice = result.amazon_list_price_cents ?? result.parsed_list_price_cents ?? result.il_list_price_cents;

  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
      inBatch ? 'border-accent/30 bg-accent/5' : 'border-border-subtle bg-bg-surface hover:bg-bg-hover'
    }`}>
      {result.image_url
        ? <img src={result.image_url} alt="" className="w-12 h-12 object-contain rounded shrink-0 bg-bg-elevated" />
        : <div className="w-12 h-12 bg-bg-elevated rounded shrink-0" />}

      <div className="min-w-0 flex-1">
        <div className="text-sm text-text-primary font-medium leading-tight truncate" title={result.product_name ?? result.asin}>
          {result.product_name || result.asin}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <span className="text-[10px] font-mono text-accent">{result.asin}</span>
          {liveStateBadge(result.amazon_status, result.amazon_qty)}
          {result.amazon_qty != null && (
            <span className="text-[10px] text-text-tertiary">Amz: {result.amazon_qty}</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {displayCost != null && (
            <span className="text-[10px] text-text-tertiary">Cost: {formatCurrency(displayCost)}</span>
          )}
          {displayPrice != null && (
            <span className="text-[10px] text-text-tertiary">List: {formatCurrency(displayPrice)}</span>
          )}
          {result.il_id == null && (
            <span className="text-[10px] text-amber-400/80">No local lot</span>
          )}
        </div>
      </div>

      <button
        onClick={onAdd}
        disabled={inBatch}
        className={`shrink-0 h-8 px-2.5 rounded-md text-xs font-medium border transition-colors flex items-center gap-1 ${
          inBatch
            ? 'border-accent/30 text-accent/60 cursor-default'
            : 'border-accent/50 text-accent hover:bg-accent/10'
        }`}
      >
        {inBatch ? <CheckCircle2 size={12} /> : <Plus size={12} />}
        {inBatch ? 'Added' : 'Add'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BatchItemCard
// ---------------------------------------------------------------------------

interface BatchItemCardProps {
  item: BatchItem;
  onChange: (updates: Partial<BatchItem>) => void;
  onRemove: () => void;
  onSave: () => void;
  onCreateLot: () => void;
}

function BatchItemCard({ item, onChange, onRemove, onSave, onCreateLot }: BatchItemCardProps) {
  const noLot = item.il_id == null;
  const profit = calcProfit(item);

  const borderClass = item.save_state === 'saved'
    ? 'border-green-500/30 bg-green-500/5'
    : item.save_state === 'error'
      ? 'border-red-500/30 bg-red-500/5'
      : noLot
        ? 'border-amber-500/20 bg-bg-surface'
        : 'border-border-subtle bg-bg-surface';

  return (
    <div className={`rounded-xl border p-4 transition-colors ${borderClass}`}>

      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        {item.image_url
          ? <img src={item.image_url} alt="" className="w-12 h-12 object-contain rounded shrink-0 bg-bg-elevated" />
          : <div className="w-12 h-12 bg-bg-elevated rounded shrink-0" />}

        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary leading-snug line-clamp-2" title={item.product_name ?? item.asin}>
            {item.product_name || item.asin}
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className="text-[10px] font-mono text-accent">{item.asin}</span>
            {liveStateBadge(item.amazon_status, item.amazon_qty)}
            {item.amazon_qty != null && (
              <span className="text-[10px] text-text-tertiary">Amz qty: {item.amazon_qty}</span>
            )}
          </div>
          <div className="text-[10px] font-mono text-text-tertiary/50 truncate mt-0.5" title={item.sku}>
            {item.sku}
          </div>
        </div>

        <button
          onClick={onRemove}
          className="shrink-0 p-1 text-text-tertiary/40 hover:text-text-tertiary rounded transition-colors"
          title="Remove from batch"
        >
          <X size={14} />
        </button>
      </div>

      {/* No-lot banner */}
      {noLot && (
        <div className="flex items-start gap-1.5 mb-3 px-2.5 py-2 bg-amber-500/8 border border-amber-500/20 rounded text-[11px] text-amber-400/90 leading-snug">
          <AlertCircle size={11} className="shrink-0 mt-0.5" />
          <span>No local lot. Fill in fields below and click <strong>Create Local Lot</strong> — does not update Amazon.</span>
        </div>
      )}

      {/* Profit strip */}
      {profit.listCents != null && profit.costCents != null && (
        <div className="mb-3 px-3 py-2.5 bg-bg-elevated rounded-lg border border-border-subtle">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-baseline gap-2">
              <span className={`text-base font-semibold tabular-nums ${
                profit.netCents != null && profit.netCents > 0 ? 'text-green-400' : 'text-red-400'
              }`}>
                {profit.netCents != null ? formatCurrency(profit.netCents) : '—'}
              </span>
              {profit.roiPct != null && (
                <span className={`text-xs font-medium ${profit.roiPct > 0 ? 'text-green-400/80' : 'text-red-400/80'}`}>
                  {profit.roiPct.toFixed(0)}% ROI
                </span>
              )}
            </div>
            {!profit.hasFee && (
              <span className="text-[10px] text-text-tertiary/50 italic">excl. Amazon fee</span>
            )}
          </div>
          <div className="flex items-center gap-1 text-[10px] text-text-tertiary flex-wrap">
            <span>List {formatCurrency(profit.listCents)}</span>
            <span className="text-text-tertiary/30">−</span>
            <span>Cost {formatCurrency(profit.costCents)}</span>
            <span className="text-text-tertiary/30">−</span>
            <span>Ship {formatCurrency(profit.shipCents)}</span>
            {profit.feeCents != null && (
              <>
                <span className="text-text-tertiary/30">−</span>
                <span>
                  Fee {formatCurrency(profit.feeCents)}
                  {item.fee_list_price_cents != null && (
                    <span className="text-text-tertiary/50"> at {formatCurrency(item.fee_list_price_cents)}</span>
                  )}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Input grid */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">
            {noLot ? 'Qty on Hand' : 'Qty Received'}
          </label>
          <input
            type="number" min="0" step="1"
            value={item.draft_qty}
            onChange={e => onChange({ draft_qty: e.target.value, save_state: 'idle' })}
            className="w-full h-8 px-2.5 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">Bin Location</label>
          <input
            type="text"
            value={item.draft_bin}
            onChange={e => onChange({ draft_bin: e.target.value, save_state: 'idle' })}
            placeholder="e.g. S1-B3"
            className="w-full h-8 px-2.5 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">List Price ($)</label>
          <input
            type="number" min="0" step="0.01"
            value={item.draft_list_price}
            onChange={e => onChange({ draft_list_price: e.target.value, save_state: 'idle' })}
            placeholder="0.00"
            className="w-full h-8 px-2.5 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">Condition</label>
          <select
            value={item.draft_condition}
            onChange={e => onChange({ draft_condition: e.target.value, save_state: 'idle' })}
            className="w-full h-8 px-2 bg-bg-elevated border border-border-default rounded-md text-xs text-text-primary focus:border-accent focus:outline-none"
          >
            <option value="">— select —</option>
            {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">
            {noLot
              ? <span>Cost ($) <span className="text-amber-400/80 normal-case font-normal">required</span></span>
              : 'Cost (locked)'}
          </label>
          <input
            type="number" min="0" step="0.01"
            value={item.draft_buy_price}
            onChange={e => noLot ? onChange({ draft_buy_price: e.target.value }) : undefined}
            readOnly={!noLot}
            placeholder="0.00"
            className={`w-full h-8 px-2.5 rounded-md text-sm font-mono placeholder:text-text-tertiary focus:outline-none ${
              noLot
                ? 'bg-bg-elevated border border-amber-500/30 text-text-primary focus:border-accent'
                : 'bg-bg-elevated/40 border border-border-subtle text-text-tertiary cursor-default'
            }`}
          />
        </div>
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">Est. Shipping ($)</label>
          <input
            type="number" min="0" step="0.01"
            value={item.draft_shipping_est}
            onChange={e => onChange({ draft_shipping_est: e.target.value })}
            placeholder="8.00"
            className="w-full h-8 px-2.5 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      <div className="mb-3">
        <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">Shipping Template</label>
        <input
          type="text"
          value={item.draft_shipping_template}
          onChange={e => onChange({ draft_shipping_template: e.target.value, save_state: 'idle' })}
          className="w-full h-8 px-2.5 bg-bg-elevated border border-border-default rounded-md text-xs font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
        />
      </div>

      {/* Action row */}
      <div className="flex items-center justify-between">
        <div className="text-[10px]">
          {item.save_state === 'saved' && (
            <span className="flex items-center gap-1 text-green-400">
              <CheckCircle2 size={11} /> Saved to FlipLedger
            </span>
          )}
          {item.save_state === 'error' && (
            <span className="text-red-400">{item.save_error || 'Save failed'}</span>
          )}
          {item.create_lot_state === 'error' && (
            <span className="text-red-400">{item.create_lot_error || 'Create failed'}</span>
          )}
        </div>

        {noLot ? (
          <button
            onClick={onCreateLot}
            disabled={item.create_lot_state === 'creating'}
            className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
          >
            {item.create_lot_state === 'creating'
              ? <><Loader2 size={11} className="animate-spin" /> Creating…</>
              : <><PackagePlus size={11} /> Create Local Lot</>}
          </button>
        ) : (
          <button
            onClick={onSave}
            disabled={item.save_state === 'saving' || item.save_state === 'saved'}
            className={`flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium border transition-colors ${
              item.save_state === 'saved'
                ? 'border-green-500/30 text-green-400 cursor-default'
                : 'border-accent/50 text-accent hover:bg-accent/10'
            }`}
          >
            {item.save_state === 'saving'
              ? <><Loader2 size={11} className="animate-spin" /> Saving…</>
              : item.save_state === 'saved'
                ? <><CheckCircle2 size={11} /> Saved</>
                : <><Save size={11} /> Save</>}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function MfnBatchReceivePage() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery]         = useState('');
  const [results, setResults]     = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [batch, setBatch]         = useState<Map<string, BatchItem>>(new Map());
  const [savingAll, setSavingAll] = useState(false);

  // Auto-focus search on mount
  useEffect(() => { searchInputRef.current?.focus(); }, []);

  // Debounced search
  const doSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setResults([]); return; }
    setSearching(true);
    try {
      const res = await fetch(`/api/data/mfn-search?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => doSearch(query), 220);
    return () => clearTimeout(t);
  }, [query, doSearch]);

  function addToBatch(result: SearchResult) {
    setBatch(prev => {
      if (prev.has(result.sku)) return prev;
      const next = new Map(prev);
      next.set(result.sku, makeBatchItem(result));
      return next;
    });
  }

  function updateBatchItem(sku: string, updates: Partial<BatchItem>) {
    setBatch(prev => {
      const item = prev.get(sku);
      if (!item) return prev;
      const next = new Map(prev);
      next.set(sku, { ...item, ...updates });
      return next;
    });
  }

  function removeFromBatch(sku: string) {
    setBatch(prev => {
      const next = new Map(prev);
      next.delete(sku);
      return next;
    });
  }

  async function saveItem(sku: string) {
    const item = batch.get(sku);
    if (!item || item.il_id == null) return;

    updateBatchItem(sku, { save_state: 'saving', save_error: null });

    const qtyNum    = parseInt(item.draft_qty, 10);
    const priceNum  = parseFloat(item.draft_list_price);

    const body: Record<string, unknown> = { id: item.il_id };
    if (Number.isFinite(qtyNum) && qtyNum >= 0)  body.quantityReceived = qtyNum;
    if (item.draft_bin.trim())                    body.binLocation      = item.draft_bin.trim();
    if (item.draft_condition.trim())              body.condition        = item.draft_condition.trim();
    if (Number.isFinite(priceNum) && priceNum > 0) body.listPriceCents  = Math.round(priceNum * 100);
    if (item.draft_shipping_template.trim())       body.merchantShippingGroupName = item.draft_shipping_template.trim();
    if (Number.isFinite(qtyNum) && qtyNum > 0)   body.markReceived     = true;

    try {
      const res = await fetch('/api/data/inventory-lots', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        updateBatchItem(sku, { save_state: 'error', save_error: (d as { error?: string }).error || 'Save failed' });
      } else {
        updateBatchItem(sku, { save_state: 'saved', save_error: null });
      }
    } catch {
      updateBatchItem(sku, { save_state: 'error', save_error: 'Network error' });
    }
  }

  async function createLot(sku: string) {
    const item = batch.get(sku);
    if (!item || item.il_id != null) return;

    updateBatchItem(sku, { create_lot_state: 'creating', create_lot_error: null });

    const qtyNum      = parseInt(item.draft_qty, 10);
    const buyNum      = parseFloat(item.draft_buy_price);
    const priceNum    = parseFloat(item.draft_list_price);

    const body: Record<string, unknown> = {
      sku,
      asin:     item.asin || undefined,
      quantity: Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1,
      buyCents: Number.isFinite(buyNum) && buyNum >= 0 ? Math.round(buyNum * 100) : 0,
      markReceived: true,
    };
    if (Number.isFinite(priceNum) && priceNum > 0) body.listPriceCents = Math.round(priceNum * 100);
    if (item.draft_condition.trim())               body.condition      = item.draft_condition.trim();
    if (item.draft_bin.trim())                     body.binLocation    = item.draft_bin.trim();
    if (item.draft_shipping_template.trim())       body.merchantShippingGroupName = item.draft_shipping_template.trim();

    try {
      const res = await fetch('/api/data/inventory-lots/create-mfn-local-lot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        updateBatchItem(sku, {
          create_lot_state: 'error',
          create_lot_error: (d.error as string | undefined) || 'Create failed',
        });
        return;
      }
      const lot = d.lot as Record<string, unknown>;
      updateBatchItem(sku, {
        il_id:                        Number(lot.id),
        buy_price:                    lot.buy_price != null ? Number(lot.buy_price) : item.buy_price,
        il_list_price_cents:          lot.list_price_cents != null ? Number(lot.list_price_cents) : item.il_list_price_cents,
        bin_location:                 lot.bin_location != null ? String(lot.bin_location) : item.bin_location,
        condition:                    lot.condition != null ? String(lot.condition) : item.condition,
        quantity_received:            lot.quantity_received != null ? Number(lot.quantity_received) : item.quantity_received,
        quantity_remaining:           lot.quantity_remaining != null ? Number(lot.quantity_remaining) : item.quantity_remaining,
        received_at:                  lot.received_at != null ? String(lot.received_at) : item.received_at,
        merchant_shipping_group_name: lot.merchant_shipping_group_name != null ? String(lot.merchant_shipping_group_name) : item.merchant_shipping_group_name,
        create_lot_state:             'idle',
        create_lot_error:             null,
        save_state:                   'saved',
      });
    } catch {
      updateBatchItem(sku, { create_lot_state: 'error', create_lot_error: 'Network error' });
    }
  }

  async function saveAll() {
    const toSave = Array.from(batch.values()).filter(i => i.il_id != null && i.save_state !== 'saved');
    if (toSave.length === 0) return;
    setSavingAll(true);
    await Promise.all(toSave.map(i => saveItem(i.sku)));
    setSavingAll(false);
  }

  const batchArray   = Array.from(batch.values());
  const savedCount   = batchArray.filter(i => i.save_state === 'saved').length;
  const saveable     = batchArray.filter(i => i.il_id != null && i.save_state !== 'saved');
  const hasUnsaved   = saveable.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">MFN Batch Receive</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Scan or search to add items → fill fields → save to FlipLedger
          </p>
        </div>
        <div className="flex items-center gap-2">
          {batchArray.length > 0 && (
            <>
              <span className="text-xs text-text-tertiary">
                {batchArray.length} in batch{savedCount > 0 ? ` · ${savedCount} saved` : ''}
              </span>
              {hasUnsaved && (
                <button
                  onClick={saveAll}
                  disabled={savingAll}
                  className="flex items-center gap-1.5 h-9 px-4 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
                >
                  {savingAll ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {savingAll ? 'Saving…' : `Save All (${saveable.length})`}
                </button>
              )}
              <button
                onClick={() => setBatch(new Map())}
                className="h-9 px-3 rounded-md border border-border-subtle text-sm text-text-tertiary hover:bg-bg-hover transition-colors"
              >
                Clear batch
              </button>
            </>
          )}
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex gap-5 flex-1 min-h-0">
        {/* Left: Search + results */}
        <div className="w-[400px] shrink-0 flex flex-col gap-3">
          {/* Search input */}
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
            {searching && (
              <Loader2 size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary animate-spin" />
            )}
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && results.length > 0) {
                  addToBatch(results[0]);
                  setQuery('');
                  setResults([]);
                }
              }}
              placeholder="ASIN, MSKU, or title… (Enter adds first result)"
              className="w-full h-11 pl-9 pr-9 bg-bg-elevated border border-border-default rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
            />
          </div>

          {/* Search results */}
          <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
            {query.trim().length >= 2 && !searching && results.length === 0 && (
              <div className="text-center text-text-tertiary text-sm py-8">No results for "{query}"</div>
            )}
            {results.map(r => (
              <SearchResultCard
                key={r.sku}
                result={r}
                inBatch={batch.has(r.sku)}
                onAdd={() => addToBatch(r)}
              />
            ))}
          </div>
        </div>

        {/* Right: Batch */}
        <div className="flex-1 flex flex-col min-h-0">
          {batchArray.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center border border-dashed border-border-subtle rounded-xl text-text-tertiary">
              <Search size={32} className="mb-3 opacity-20" />
              <p className="text-sm font-medium">Batch is empty</p>
              <p className="text-xs mt-1 max-w-[200px]">Search for items on the left and add them to this batch</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-3 min-h-0 pr-1">
              {batchArray.map(item => (
                <BatchItemCard
                  key={item.sku}
                  item={item}
                  onChange={updates => updateBatchItem(item.sku, updates)}
                  onRemove={() => removeFromBatch(item.sku)}
                  onSave={() => saveItem(item.sku)}
                  onCreateLot={() => createLot(item.sku)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
