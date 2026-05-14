'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { formatCurrency } from '@/lib/formatters';
import { Search, X, Plus, CheckCircle2, AlertCircle, Loader2, Save } from 'lucide-react';

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
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface BatchItem extends SearchResult {
  draft_qty: string;
  draft_bin: string;
  draft_condition: string;
  draft_list_price: string;
  draft_shipping_template: string;
  save_state: SaveState;
  save_error: string | null;
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
  return {
    ...r,
    draft_qty:               String(r.quantity_received ?? r.quantity_remaining ?? 1),
    draft_bin:               r.bin_location ?? '',
    draft_condition:         r.condition ?? '',
    draft_list_price:        r.il_list_price_cents != null
                               ? (r.il_list_price_cents / 100).toFixed(2)
                               : r.amazon_list_price_cents != null
                                 ? (r.amazon_list_price_cents / 100).toFixed(2)
                                 : r.parsed_list_price_cents != null
                                   ? (r.parsed_list_price_cents / 100).toFixed(2)
                                   : '',
    draft_shipping_template: r.merchant_shipping_group_name ?? DEFAULT_SHIPPING_TEMPLATE,
    save_state:              'idle',
    save_error:              null,
  };
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
}

function BatchItemCard({ item, onChange, onRemove, onSave }: BatchItemCardProps) {
  const displayCost = item.buy_price ?? item.parsed_cost_cents;

  return (
    <div className={`rounded-xl border p-4 transition-colors ${
      item.save_state === 'saved'
        ? 'border-green-500/30 bg-green-500/5'
        : item.save_state === 'error'
          ? 'border-red-500/30 bg-red-500/5'
          : 'border-border-subtle bg-bg-surface'
    }`}>
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        {item.image_url
          ? <img src={item.image_url} alt="" className="w-10 h-10 object-contain rounded shrink-0 bg-bg-elevated" />
          : <div className="w-10 h-10 bg-bg-elevated rounded shrink-0" />}

        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary leading-tight truncate" title={item.product_name ?? item.asin}>
            {item.product_name || item.asin}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className="text-[10px] font-mono text-accent">{item.asin}</span>
            {liveStateBadge(item.amazon_status, item.amazon_qty)}
            {item.amazon_qty != null && (
              <span className="text-[10px] text-text-tertiary">Amz: {item.amazon_qty}</span>
            )}
            {displayCost != null && (
              <span className="text-[10px] text-text-tertiary">Cost: {formatCurrency(displayCost)}</span>
            )}
          </div>
          <div className="text-[10px] font-mono text-text-tertiary/60 truncate mt-0.5" title={item.sku}>
            {item.sku}
          </div>
        </div>

        <button
          onClick={onRemove}
          className="shrink-0 p-1 text-text-tertiary/50 hover:text-text-tertiary rounded transition-colors"
          title="Remove from batch"
        >
          <X size={14} />
        </button>
      </div>

      {/* No il_id warning */}
      {item.il_id == null && (
        <div className="flex items-center gap-1.5 mb-3 px-2.5 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded text-[11px] text-amber-400">
          <AlertCircle size={11} />
          No local lot — cannot save without a ledger entry
        </div>
      )}

      {/* Editable fields */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">Qty Received</label>
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

      {/* Save row */}
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
        </div>
        <button
          onClick={onSave}
          disabled={item.il_id == null || item.save_state === 'saving' || item.save_state === 'saved'}
          className={`flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium border transition-colors ${
            item.save_state === 'saved'
              ? 'border-green-500/30 text-green-400 cursor-default'
              : item.il_id == null
                ? 'border-border-subtle text-text-tertiary/40 cursor-not-allowed'
                : 'border-accent/50 text-accent hover:bg-accent/10'
          }`}
        >
          {item.save_state === 'saving'
            ? <><Loader2 size={11} className="animate-spin" /> Saving…</>
            : item.save_state === 'saved'
              ? <><CheckCircle2 size={11} /> Saved</>
              : <><Save size={11} /> Save</>}
        </button>
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
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
