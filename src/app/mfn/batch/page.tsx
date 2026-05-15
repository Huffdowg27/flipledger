'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { formatCurrency } from '@/lib/formatters';
import { Search, X, Plus, CheckCircle2, AlertCircle, Loader2, Save, PackagePlus, Printer, Send, Pencil } from 'lucide-react';
import { PreviewModal, type ActivationPreviewRow } from '@/components/activation/PreviewModal';

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
  fee_cents: number | null;
  referral_fee_cents: number | null;
  fee_list_price_cents: number | null;
  upc?: string | null;
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
  slow_save: boolean;            // true once save has been in-flight > 3s
  create_lot_state: CreateLotState;
  create_lot_error: string | null;
  slow_create_lot: boolean;      // true once create-lot has been in-flight > 3s
}

const CONDITIONS = [
  'New',
  'Used - Like New',
  'Used - Very Good',
  'Used - Good',
  'Used - Acceptable',
];

const DEFAULT_SHIPPING_TEMPLATE = 'DEFAULT MFN USE THIS ONE';

const SHIPPING_TEMPLATES = [
  'DEFAULT MFN USE THIS ONE',
  'DO NOT USE SSA ONLY',
  'Over 1lb 12.99 SSA',
  'SSA (Jason)',
  'Under 1lb 7.99',
  'Video Games $5.99',
] as const;

// ---------------------------------------------------------------------------
// Label printing
// ---------------------------------------------------------------------------

interface LabelSpec {
  labelMode: 'asin';
  size: '2x1';
  asin?: string;
  title?: string;
  condition?: string;
  bin?: string;
  showBin?: boolean;
}

function openLabelPrint(items: BatchItem[]): void {
  // One label per saved item by default. The print preview tab still has
  // browser-native controls to print multiple copies if the user needs more.
  const specs: LabelSpec[] = items.map(item => {
    const bin = item.draft_bin.trim() || item.bin_location || undefined;
    return {
      labelMode: 'asin',
      size: '2x1',
      asin: item.asin || undefined,
      title: item.product_name || undefined,
      condition: item.draft_condition.trim() || item.condition || undefined,
      bin,
      showBin: !!bin,
    };
  });
  if (specs.length === 0) return;
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(specs))));
  window.open(`/api/labels/print?d=${encodeURIComponent(encoded)}`, '_blank');
}

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
    slow_save:               false,
    create_lot_state:        'idle',
    create_lot_error:        null,
    slow_create_lot:         false,
  };
}

// ---------------------------------------------------------------------------
// Profit calculator (display only — no DB writes)
// ---------------------------------------------------------------------------

interface ProfitCalc {
  netCents: number | null;
  roiPct: number | null;
  marginPct: number | null;
  listCents: number | null;
  costCents: number | null;
  shipCents: number;
  // Fee breakdown (all adjusted to current list price):
  referralCents: number | null;  // referral % applied to current draft price
  referralRate: number | null;   // e.g. 0.15 for 15%
  vcfCents: number;              // per-item variable closing fee (flat; $1.80 for media, $0 otherwise)
  feeCents: number | null;       // total Amazon fee = referralCents + vcfCents
  hasFee: boolean;
  feeEstimatedAtCents: number | null; // price the cached fee was originally estimated at
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

  // Fee data from fee_estimates_cache
  const cachedReferral    = item.referral_fee_cents != null ? Number(item.referral_fee_cents) : null;
  const cachedTotal       = item.fee_cents != null ? Number(item.fee_cents) : null;
  const feeEstimatedAtCents = item.fee_list_price_cents != null ? Number(item.fee_list_price_cents) : null;

  // VCF = flat per-item component (e.g. $1.80 for media). Derived from cache.
  const vcfCents = (cachedTotal != null && cachedReferral != null)
    ? Math.max(0, cachedTotal - cachedReferral)
    : 0;

  // Referral rate — apply to CURRENT list price for accuracy
  const referralRate = (cachedReferral != null && feeEstimatedAtCents != null && feeEstimatedAtCents > 0)
    ? cachedReferral / feeEstimatedAtCents
    : null;

  const hasFee = referralRate != null;

  // Adjusted referral at current list price
  const referralCents = (referralRate != null && listCents != null)
    ? Math.round(referralRate * listCents)
    : null;

  // Total Amazon fee = adjusted referral + flat VCF
  const feeCents = referralCents != null ? referralCents + vcfCents : null;

  if (listCents == null || costCents == null) {
    return { netCents: null, roiPct: null, marginPct: null, listCents, costCents, shipCents,
             referralCents, referralRate, vcfCents, feeCents, hasFee, feeEstimatedAtCents };
  }

  const netCents  = listCents - costCents - shipCents - (feeCents ?? 0);
  const roiPct    = costCents > 0 ? (netCents / costCents) * 100 : null;
  const marginPct = listCents > 0 ? (netCents / listCents) * 100 : null;

  return { netCents, roiPct, marginPct, listCents, costCents, shipCents,
           referralCents, referralRate, vcfCents, feeCents, hasFee, feeEstimatedAtCents };
}

// ---------------------------------------------------------------------------
// Warning chips — compact per-item status indicators for the batch row
// ---------------------------------------------------------------------------

type ChipTone = 'blocker' | 'warn';
interface Chip { label: string; tone: ChipTone; title?: string }

function chipsForResult(r: SearchResult): Chip[] {
  const chips: Chip[] = [];
  if (r.il_id == null) chips.push({ label: 'No lot', tone: 'blocker', title: 'No local inventory_ledger lot — create one to make this push-eligible' });
  if (r.amazon_status && r.amazon_status !== 'Active') chips.push({ label: 'Stale status', tone: 'warn', title: `Local Amazon status is "${r.amazon_status}" — may be out of sync with Seller Central` });
  if (r.referral_fee_cents == null) chips.push({ label: 'Fee unknown', tone: 'warn', title: 'No cached referral fee — ROI estimate excludes Amazon fee' });
  return chips;
}

type WarnLabel = 'No lot' | 'Not inspected' | 'Stale status' | 'No price' | 'Fee unknown' | 'No bin' | 'No condition';
const WARN_LABELS: WarnLabel[] = ['No lot', 'Not inspected', 'Stale status', 'No price', 'Fee unknown', 'No bin', 'No condition'];

interface BatchSummary {
  total: number;
  saved: number;
  unsaved: number;
  totalQty: number;
  totalListCents: number;
  totalCostCents: number;
  totalShipCents: number;
  totalFeeCents: number;
  totalNetCents: number;
  roiPct: number | null;
  marginPct: number | null;
  // True if any qty>0 item is missing fee (but has list+cost). Narrower flag for messaging.
  feeIncomplete: boolean;
  // True if any qty>0 item is missing list, cost, or net entirely. Broader flag.
  priceOrCostIncomplete: boolean;
  // Combined: drives the asterisk + amber color on Fees/Net/ROI/Margin.
  profitIncomplete: boolean;
  warnCounts: Record<WarnLabel, number>;
}

function summarizeBatch(items: BatchItem[]): BatchSummary {
  let totalQty = 0;
  let totalListCents = 0;
  let totalCostCents = 0;
  let totalShipCents = 0;
  let totalFeeCents = 0;
  let totalNetCents = 0;
  let feeIncomplete = false;
  let priceOrCostIncomplete = false;
  let saved = 0;
  const warnCounts: Record<WarnLabel, number> = {
    'No lot': 0, 'Not inspected': 0, 'Stale status': 0,
    'No price': 0, 'Fee unknown': 0, 'No bin': 0, 'No condition': 0,
  };

  for (const item of items) {
    if (item.save_state === 'saved') saved++;

    const p = calcProfit(item);
    // Saved items: use the persisted quantity_received. Otherwise the draft qty.
    const qty = (item.quantity_received ?? parseInt(item.draft_qty, 10)) || 0;
    totalQty += Math.max(qty, 0);

    if (qty > 0) {
      // Track WHICH inputs are missing so the footnote can be specific.
      if (p.listCents == null || p.costCents == null || p.netCents == null) {
        priceOrCostIncomplete = true;
      } else if (!p.hasFee) {
        feeIncomplete = true;
      }

      if (p.listCents != null) totalListCents += p.listCents * qty;
      if (p.costCents != null) totalCostCents += p.costCents * qty;
      totalShipCents += p.shipCents * qty;
      if (p.feeCents != null) totalFeeCents += p.feeCents * qty;
      if (p.netCents != null) totalNetCents += p.netCents * qty;
    }

    for (const c of chipsForBatchItem(item)) {
      if ((WARN_LABELS as string[]).includes(c.label)) {
        warnCounts[c.label as WarnLabel]++;
      }
    }
  }

  const roiPct    = totalCostCents > 0 ? (totalNetCents / totalCostCents) * 100 : null;
  const marginPct = totalListCents > 0 ? (totalNetCents / totalListCents) * 100 : null;
  const profitIncomplete = feeIncomplete || priceOrCostIncomplete;

  return {
    total: items.length, saved, unsaved: items.length - saved,
    totalQty, totalListCents, totalCostCents, totalShipCents, totalFeeCents,
    totalNetCents, roiPct, marginPct,
    feeIncomplete, priceOrCostIncomplete, profitIncomplete,
    warnCounts,
  };
}

function chipsForBatchItem(item: BatchItem): Chip[] {
  const chips: Chip[] = [];
  if (item.il_id == null) {
    chips.push({ label: 'No lot', tone: 'blocker', title: 'No local lot yet — create one before save/push' });
  } else if (!item.inspected_at) {
    chips.push({ label: 'Not inspected', tone: 'blocker', title: 'Inspection required before pushing to Amazon' });
  }
  // List price is a true push blocker — surface it as red.
  const priceNum = parseFloat(item.draft_list_price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    chips.push({ label: 'No price', tone: 'blocker', title: 'No list price set — required to push' });
  }
  if (item.amazon_status && item.amazon_status !== 'Active') {
    chips.push({ label: 'Stale status', tone: 'warn', title: `Local Amazon status is "${item.amazon_status}" — push will still attempt qty/price update` });
  }
  if (item.referral_fee_cents == null) {
    chips.push({ label: 'Fee unknown', tone: 'warn', title: 'No cached referral fee — ROI excludes Amazon fee' });
  }
  const binSet = !!(item.bin_location || item.draft_bin.trim());
  if (!binSet) chips.push({ label: 'No bin', tone: 'warn', title: 'Bin location not set' });
  const condSet = !!(item.condition || item.draft_condition.trim());
  if (!condSet) chips.push({ label: 'No condition', tone: 'warn', title: 'Condition not set' });
  return chips;
}

function WarningChip({ chip }: { chip: Chip }) {
  const cls = chip.tone === 'blocker'
    ? 'bg-red-500/10 text-red-400 border-red-500/30'
    : 'bg-amber-500/10 text-amber-400/90 border-amber-500/25';
  return (
    <span
      className={`inline-flex items-center px-1.5 h-4 rounded text-[9px] font-medium border tabular-nums ${cls}`}
      title={chip.title}
    >
      {chip.label}
    </span>
  );
}

function UpcChip({ upc }: { upc: string }) {
  return (
    <span
      className="inline-flex items-center px-1.5 h-4 rounded text-[9px] font-mono font-medium border bg-bg-elevated text-text-tertiary border-border-subtle"
      title="UPC"
    >
      UPC {upc}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SearchResultCard
// ---------------------------------------------------------------------------

interface SearchResultCardProps {
  result: SearchResult;
  inBatch: boolean;
  onAdd: () => void;
  onImageClick: () => void;
}

function SearchResultCard({ result, inBatch, onAdd, onImageClick }: SearchResultCardProps) {
  const displayCost = result.buy_price ?? result.parsed_cost_cents;
  const displayPrice = result.amazon_list_price_cents ?? result.parsed_list_price_cents ?? result.il_list_price_cents;

  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
      inBatch ? 'border-accent/30 bg-accent/5' : 'border-border-subtle bg-bg-surface hover:bg-bg-hover'
    }`}>
      {result.image_url
        ? (
            <button
              type="button"
              onClick={onImageClick}
              className="shrink-0 rounded overflow-hidden bg-bg-elevated hover:ring-2 hover:ring-accent/40 transition-shadow"
              title="View larger"
            >
              <img src={result.image_url} alt="" className="w-14 h-14 object-contain block" />
            </button>
          )
        : <div className="w-14 h-14 bg-bg-elevated rounded shrink-0" />}

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
          {result.upc && <UpcChip upc={result.upc} />}
          {chipsForResult(result).map(c => <WarningChip key={c.label} chip={c} />)}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {displayCost != null && (
            <span className="text-[10px] text-text-tertiary">Cost: {formatCurrency(displayCost)}</span>
          )}
          {displayPrice != null && (
            <span className="text-[10px] text-text-tertiary">List: {formatCurrency(displayPrice)}</span>
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
  onPrintLabel: () => void;
  onEdit: () => void;
  onImageClick: () => void;
  focusQty: boolean;
  onQtyFocused: () => void;
}

function BatchItemCard({ item, onChange, onRemove, onSave, onCreateLot, onPrintLabel, onEdit, onImageClick, focusQty, onQtyFocused }: BatchItemCardProps) {
  const noLot = item.il_id == null;
  const profit = calcProfit(item);

  const qtyRef              = useRef<HTMLInputElement>(null);
  const binRef              = useRef<HTMLInputElement>(null);
  const listPriceRef        = useRef<HTMLInputElement>(null);
  const conditionRef        = useRef<HTMLSelectElement>(null);
  const shippingTemplateRef = useRef<HTMLSelectElement>(null);
  const saveRef             = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (focusQty && qtyRef.current) {
      qtyRef.current.focus();
      qtyRef.current.select();
      onQtyFocused();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusQty]);

  // Collapsed view for saved items — keeps the batch scannable
  if (item.save_state === 'saved') {
    const savedQty   = item.quantity_received ?? (parseInt(item.draft_qty, 10) || null);
    const savedPrice = item.il_list_price_cents
      ?? (item.draft_list_price ? Math.round(parseFloat(item.draft_list_price) * 100) : null);
    const savedBin   = item.bin_location || item.draft_bin.trim() || null;
    const savedCond  = item.condition    || item.draft_condition.trim() || null;
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-xl border border-green-500/20 bg-green-500/5">
        {item.image_url
          ? (
              <button
                type="button"
                onClick={onImageClick}
                className="shrink-0 rounded overflow-hidden bg-bg-elevated hover:ring-2 hover:ring-accent/40 transition-shadow"
                title="View larger"
              >
                <img src={item.image_url} alt="" className="w-8 h-8 object-contain block" />
              </button>
            )
          : <div className="w-8 h-8 bg-bg-elevated rounded shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <CheckCircle2 size={11} className="text-green-400 shrink-0" />
            <div className="text-xs font-medium text-text-primary truncate" title={item.product_name ?? item.asin}>
              {item.product_name || item.asin}
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-text-tertiary flex-wrap">
            <span className="font-mono text-accent/80">{item.asin}</span>
            <span className="font-mono text-text-tertiary/60 truncate max-w-[140px]" title={item.sku}>{item.sku}</span>
            {savedQty != null && <span className="font-mono">Qty {savedQty}</span>}
            {savedBin && <span>Bin <span className="font-mono text-text-secondary">{savedBin}</span></span>}
            {savedCond && <span className="text-text-secondary">{savedCond}</span>}
            {savedPrice != null && <span className="font-mono text-text-secondary">{formatCurrency(savedPrice)}</span>}
            {item.upc && <UpcChip upc={item.upc} />}
            {chipsForBatchItem(item).map(c => <WarningChip key={c.label} chip={c} />)}
          </div>
        </div>
        <button
          onClick={onPrintLabel}
          className="shrink-0 p-1 text-text-tertiary/60 hover:text-accent rounded transition-colors"
          title="Print ASIN label"
        >
          <Printer size={14} />
        </button>
        <button
          onClick={onEdit}
          className="shrink-0 p-1 text-text-tertiary/60 hover:text-accent rounded transition-colors"
          title="Edit (reopens this card)"
        >
          <Pencil size={14} />
        </button>
        <button onClick={onRemove} className="shrink-0 p-1 text-text-tertiary/40 hover:text-text-tertiary rounded" title="Remove">
          <X size={14} />
        </button>
      </div>
    );
  }

  const borderClass = item.save_state === 'error'
    ? 'border-red-500/30 bg-red-500/5'
    : noLot
      ? 'border-amber-500/20 bg-bg-surface'
      : 'border-border-subtle bg-bg-surface';

  return (
    <div className={`rounded-xl border p-4 transition-colors ${borderClass}`}>

      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        {item.image_url
          ? (
              <button
                type="button"
                onClick={onImageClick}
                className="shrink-0 rounded overflow-hidden bg-bg-elevated hover:ring-2 hover:ring-accent/40 transition-shadow"
                title="View larger"
              >
                <img src={item.image_url} alt="" className="w-16 h-16 object-contain block" />
              </button>
            )
          : <div className="w-16 h-16 bg-bg-elevated rounded shrink-0" />}

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
            {item.upc && <UpcChip upc={item.upc} />}
          </div>
          <div className="text-[10px] font-mono text-text-tertiary/50 truncate mt-0.5" title={item.sku}>
            {item.sku}
          </div>
          {(() => {
            const chips = chipsForBatchItem(item);
            return chips.length > 0 ? (
              <div className="flex items-center gap-1 mt-1 flex-wrap">
                {chips.map(c => <WarningChip key={c.label} chip={c} />)}
              </div>
            ) : null;
          })()}
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
          {/* Top row: net profit + ROI + margin */}
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-baseline gap-2">
              <span className={`text-base font-semibold tabular-nums ${
                !profit.hasFee
                  ? 'text-amber-400'
                  : profit.netCents != null && profit.netCents > 0 ? 'text-green-400' : 'text-red-400'
              }`}>
                {profit.netCents != null ? formatCurrency(profit.netCents) : '—'}
              </span>
              {profit.roiPct != null && (
                <span className={`text-xs font-medium ${
                  !profit.hasFee ? 'text-amber-400/80' : profit.roiPct > 0 ? 'text-green-400/80' : 'text-red-400/80'
                }`}>
                  {profit.roiPct.toFixed(1)}%{!profit.hasFee ? '?' : ''} ROI
                </span>
              )}
              {profit.marginPct != null && profit.hasFee && (
                <span className={`text-[10px] ${profit.marginPct > 0 ? 'text-text-tertiary' : 'text-red-400/70'}`}>
                  {profit.marginPct.toFixed(1)}% margin
                </span>
              )}
            </div>
            {!profit.hasFee && (
              <span className="flex items-center gap-1 text-[10px] text-amber-400/80 font-medium">
                <AlertCircle size={10} /> Fee unknown
              </span>
            )}
          </div>
          {/* Breakdown line */}
          <div className="flex items-center gap-1 text-[10px] text-text-tertiary flex-wrap">
            <span>List {formatCurrency(profit.listCents)}</span>
            <span className="text-text-tertiary/30">−</span>
            <span>Cost {formatCurrency(profit.costCents)}</span>
            <span className="text-text-tertiary/30">−</span>
            <span>Ship {formatCurrency(profit.shipCents)}</span>
            <span className="text-text-tertiary/30">−</span>
            {profit.referralCents != null ? (
              <>
                <span>
                  Referral{profit.referralRate != null
                    ? ` (${(profit.referralRate * 100).toFixed(0)}%)`
                    : ''} {formatCurrency(profit.referralCents)}
                </span>
                {profit.vcfCents > 0 && (
                  <>
                    <span className="text-text-tertiary/30">−</span>
                    <span>VCF {formatCurrency(profit.vcfCents)}</span>
                  </>
                )}
              </>
            ) : (
              <span className="text-amber-400/70 font-medium">Fee missing</span>
            )}
          </div>
        </div>
      )}

      {/* Input grid — keyboard flow: Qty → Bin → List Price → Condition → Shipping Template → Save */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">
            {noLot ? 'Qty on Hand' : 'Qty Received'}
          </label>
          <input
            ref={qtyRef}
            type="number" min="0" step="1"
            value={item.draft_qty}
            onChange={e => onChange({ draft_qty: e.target.value, save_state: 'idle' })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); binRef.current?.focus(); } }}
            className="w-full h-8 px-2.5 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">Bin Location</label>
          <input
            ref={binRef}
            type="text"
            value={item.draft_bin}
            onChange={e => onChange({ draft_bin: e.target.value, save_state: 'idle' })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); listPriceRef.current?.focus(); } }}
            placeholder="e.g. S1-B3"
            className="w-full h-8 px-2.5 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">List Price ($)</label>
          <input
            ref={listPriceRef}
            type="number" min="0" step="0.01"
            value={item.draft_list_price}
            onChange={e => onChange({ draft_list_price: e.target.value, save_state: 'idle' })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); conditionRef.current?.focus(); } }}
            placeholder="0.00"
            className="w-full h-8 px-2.5 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1 uppercase tracking-wide">Condition</label>
          <select
            ref={conditionRef}
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
            tabIndex={noLot ? 0 : -1}
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
        <select
          ref={shippingTemplateRef}
          value={SHIPPING_TEMPLATES.includes(item.draft_shipping_template as typeof SHIPPING_TEMPLATES[number])
            ? item.draft_shipping_template
            : DEFAULT_SHIPPING_TEMPLATE}
          onChange={e => onChange({ draft_shipping_template: e.target.value, save_state: 'idle' })}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveRef.current?.click(); } }}
          className="w-full h-8 px-2.5 bg-bg-elevated border border-border-default rounded-md text-xs font-mono text-text-primary focus:border-accent focus:outline-none appearance-none cursor-pointer"
        >
          {SHIPPING_TEMPLATES.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      {/* Error message */}
      {(item.save_state === 'error' || item.create_lot_state === 'error') && (
        <p className="text-[10px] text-red-400 mb-2">
          {item.save_state === 'error' ? (item.save_error || 'Save failed') : (item.create_lot_error || 'Create failed')}
        </p>
      )}

      {/* Save / Create button — full width, prominent */}
      {noLot ? (
        <>
          <button
            onClick={onCreateLot}
            disabled={item.create_lot_state === 'creating'}
            className="w-full h-9 flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium border border-amber-500/50 text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
          >
            {item.create_lot_state === 'creating'
              ? <><Loader2 size={13} className="animate-spin" /> Creating…</>
              : <><PackagePlus size={13} /> Create Local Lot</>}
          </button>
          {item.create_lot_state === 'creating' && item.slow_create_lot && (
            <p className="text-[10px] text-text-tertiary italic mt-1.5 text-center">
              Still working — creating local lot…
            </p>
          )}
        </>
      ) : (
        <>
          <button
            ref={saveRef}
            onClick={onSave}
            disabled={item.save_state === 'saving'}
            className="w-full h-9 flex items-center justify-center gap-1.5 rounded-lg text-sm font-semibold bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-60"
          >
            {item.save_state === 'saving'
              ? <><Loader2 size={13} className="animate-spin" /> Saving…</>
              : <><Save size={13} /> Save to FlipLedger</>}
          </button>
          {item.save_state === 'saving' && item.slow_save && (
            <p className="text-[10px] text-text-tertiary italic mt-1.5 text-center">
              Still working — saving…
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function MfnBatchReceivePage() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery]           = useState('');
  const [results, setResults]       = useState<SearchResult[]>([]);
  const [searching, setSearching]   = useState(false);
  const [batch, setBatch]           = useState<Map<string, BatchItem>>(new Map());
  const [savingAll, setSavingAll]   = useState(false);
  const [focusQtySku, setFocusQtySku] = useState<string | null>(null);
  const [printAllMsg, setPrintAllMsg] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; title: string; asin: string; sku: string } | null>(null);
  const [previewOpen, setPreviewOpen]       = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRows, setPreviewRows]       = useState<ActivationPreviewRow[]>([]);
  const [previewTemplate, setPreviewTemplate] = useState('');
  const [previewError, setPreviewError]     = useState<string | null>(null);

  // Auto-focus search on mount
  useEffect(() => { searchInputRef.current?.focus(); }, []);

  // Esc closes the lightbox
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

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

  function addToBatch(result: SearchResult, focusOnAdd = false) {
    setBatch(prev => {
      if (prev.has(result.sku)) return prev;
      const next = new Map(prev);
      next.set(result.sku, makeBatchItem(result));
      return next;
    });
    if (focusOnAdd) setFocusQtySku(result.sku);
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

    const t0 = Date.now();
    console.log(`[saveItem] start sku=${sku} il_id=${item.il_id}`);

    updateBatchItem(sku, { save_state: 'saving', save_error: null, slow_save: false });

    const slowTimer = setTimeout(() => {
      console.warn(`[saveItem] slow >3s sku=${sku}`);
      updateBatchItem(sku, { slow_save: true });
    }, 3000);

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
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        let errMsg = 'Save failed';
        try { errMsg = JSON.parse(bodyText).error || errMsg; } catch { /* keep default */ }
        console.error(`[saveItem] fail sku=${sku} status=${res.status} elapsed=${elapsed}ms body=${bodyText}`);
        updateBatchItem(sku, { save_state: 'error', save_error: `${errMsg} (HTTP ${res.status})` });
      } else {
        console.log(`[saveItem] ok sku=${sku} elapsed=${elapsed}ms`);
        updateBatchItem(sku, { save_state: 'saved', save_error: null });
      }
    } catch (err) {
      const elapsed = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[saveItem] network sku=${sku} elapsed=${elapsed}ms err=${msg}`);
      updateBatchItem(sku, { save_state: 'error', save_error: `Network error: ${msg}` });
    } finally {
      clearTimeout(slowTimer);
      // Defense-in-depth: never leave the slow indicator on
      updateBatchItem(sku, { slow_save: false });
    }
  }

  async function createLot(sku: string) {
    const item = batch.get(sku);
    if (!item || item.il_id != null) return;

    const t0 = Date.now();
    console.log(`[createLot] start sku=${sku} asin=${item.asin}`);

    updateBatchItem(sku, { create_lot_state: 'creating', create_lot_error: null, slow_create_lot: false });

    const slowTimer = setTimeout(() => {
      console.warn(`[createLot] slow >3s sku=${sku}`);
      updateBatchItem(sku, { slow_create_lot: true });
    }, 3000);

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
      const elapsed = Date.now() - t0;
      const bodyText = await res.text().catch(() => '');
      let d: Record<string, unknown> = {};
      try { d = JSON.parse(bodyText) as Record<string, unknown>; } catch { /* leave empty */ }

      if (!res.ok) {
        const errMsg = (d.error as string | undefined) || 'Create failed';
        console.error(`[createLot] fail sku=${sku} status=${res.status} elapsed=${elapsed}ms body=${bodyText}`);
        updateBatchItem(sku, {
          create_lot_state: 'error',
          create_lot_error: `${errMsg} (HTTP ${res.status})`,
        });
        return;
      }
      console.log(`[createLot] ok sku=${sku} elapsed=${elapsed}ms existingLotUsed=${d.existingLotUsed}`);
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
    } catch (err) {
      const elapsed = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[createLot] network sku=${sku} elapsed=${elapsed}ms err=${msg}`);
      updateBatchItem(sku, { create_lot_state: 'error', create_lot_error: `Network error: ${msg}` });
    } finally {
      clearTimeout(slowTimer);
      // Defense-in-depth: never leave the slow indicator on
      updateBatchItem(sku, { slow_create_lot: false });
    }
  }

  async function saveAll() {
    const toSave = Array.from(batch.values()).filter(i => i.il_id != null && i.save_state !== 'saved');
    if (toSave.length === 0) return;
    setSavingAll(true);
    await Promise.all(toSave.map(i => saveItem(i.sku)));
    setSavingAll(false);
  }

  function printAll() {
    const all    = Array.from(batch.values());
    const saved  = all.filter(i => i.save_state === 'saved' && i.asin);
    const skipped = all.length - saved.length;
    if (saved.length === 0) return;
    openLabelPrint(saved);
    if (skipped > 0) {
      const msg = `Skipped ${skipped} unsaved item${skipped !== 1 ? 's' : ''}`;
      setPrintAllMsg(msg);
      setTimeout(() => setPrintAllMsg(null), 4000);
    }
  }

  async function previewAndPush() {
    const savedSkus = Array.from(batch.values())
      .filter(i => i.save_state === 'saved' && i.il_id != null)
      .map(i => i.sku);
    if (savedSkus.length === 0) return;

    setPreviewLoading(true);
    setPreviewError(null);
    const t0 = Date.now();
    console.log(`[previewAndPush] start skus=${savedSkus.length}`);
    try {
      const res = await fetch('/api/data/merchant-inventory/activation-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: savedSkus }),
      });
      const data = await res.json();
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        console.error(`[previewAndPush] fail status=${res.status} elapsed=${elapsed}ms`, data);
        setPreviewError((data as { error?: string }).error || `Preview failed (HTTP ${res.status})`);
        return;
      }
      console.log(`[previewAndPush] ok elapsed=${elapsed}ms rows=${(data.rows ?? []).length}`);
      setPreviewRows(data.rows || []);
      setPreviewTemplate(data.shippingTemplate || '');
      setPreviewOpen(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[previewAndPush] network', msg);
      setPreviewError(`Network error: ${msg}`);
    } finally {
      setPreviewLoading(false);
    }
  }

  const batchArray   = Array.from(batch.values());
  const savedCount   = batchArray.filter(i => i.save_state === 'saved').length;
  const summary      = summarizeBatch(batchArray);
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
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-xs text-text-tertiary">
                  {batchArray.length} in batch{savedCount > 0 ? ` · ${savedCount} saved` : ''}
                </span>
                {printAllMsg && (
                  <span className="text-[10px] text-text-tertiary/70">{printAllMsg}</span>
                )}
              </div>
              {savedCount > 0 && (
                <button
                  onClick={printAll}
                  className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-border-subtle text-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
                >
                  <Printer size={14} />
                  Print All ({savedCount})
                </button>
              )}
              {savedCount > 0 && (
                <button
                  onClick={previewAndPush}
                  disabled={previewLoading}
                  className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-blue-500/50 text-blue-400 text-sm font-medium hover:bg-blue-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {previewLoading
                    ? <Loader2 size={14} className="animate-spin" />
                    : <Send size={14} />}
                  {previewLoading ? 'Loading…' : `Preview & Push (${savedCount})`}
                </button>
              )}
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
                  addToBatch(results[0], true);
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
                onImageClick={() => r.image_url && setLightbox({
                  src: r.image_url,
                  title: r.product_name || r.asin || r.sku,
                  asin: r.asin || '',
                  sku: r.sku,
                })}
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
            <>
              {/* Compact summary bar */}
              <div className="mb-2 px-3 py-2 rounded-lg bg-bg-elevated border border-border-subtle text-[11px] text-text-secondary">
                <div className="flex items-center gap-x-4 gap-y-1 flex-wrap">
                  <span className="text-text-tertiary">
                    <span className="text-text-primary font-medium">{summary.total}</span> item{summary.total !== 1 ? 's' : ''}
                    {summary.saved > 0 && <span className="text-text-tertiary"> · <span className="text-green-400/90">{summary.saved} saved</span></span>}
                    {summary.unsaved > 0 && <span className="text-text-tertiary"> · <span className="text-amber-400/80">{summary.unsaved} unsaved</span></span>}
                  </span>
                  <span className="text-text-tertiary">Qty <span className="text-text-primary font-mono">{summary.totalQty}</span></span>
                  <span className="text-text-tertiary">Rev <span className="text-text-primary font-mono">{formatCurrency(summary.totalListCents)}</span></span>
                  <span className="text-text-tertiary">Cost <span className="text-text-primary font-mono">{formatCurrency(summary.totalCostCents)}</span></span>
                  <span className="text-text-tertiary">Ship <span className="text-text-primary font-mono">{formatCurrency(summary.totalShipCents)}</span></span>
                  <span className="text-text-tertiary">
                    Fees{summary.profitIncomplete ? '*' : ''} <span className={`font-mono ${summary.profitIncomplete ? 'text-amber-400' : 'text-text-primary'}`}>{formatCurrency(summary.totalFeeCents)}</span>
                  </span>
                  <span className="text-text-tertiary">
                    Net <span className={`font-mono font-semibold ${
                      summary.profitIncomplete
                        ? 'text-amber-400'
                        : summary.totalNetCents > 0 ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {formatCurrency(summary.totalNetCents)}{summary.profitIncomplete ? '*' : ''}
                    </span>
                  </span>
                  {summary.roiPct != null && (
                    <span className="text-text-tertiary">
                      ROI <span className={`font-mono ${summary.profitIncomplete ? 'text-amber-400/90' : summary.roiPct > 0 ? 'text-green-400/90' : 'text-red-400/90'}`}>
                        {summary.roiPct.toFixed(1)}%{summary.profitIncomplete ? '*' : ''}
                      </span>
                    </span>
                  )}
                  {summary.marginPct != null && (
                    <span className="text-text-tertiary">
                      Margin <span className={`font-mono ${summary.profitIncomplete ? 'text-amber-400/90' : 'text-text-secondary'}`}>
                        {summary.marginPct.toFixed(1)}%{summary.profitIncomplete ? '*' : ''}
                      </span>
                    </span>
                  )}
                </div>
                {/* Warning counts — only render the labels that have a non-zero count */}
                {WARN_LABELS.some(l => summary.warnCounts[l] > 0) && (
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {WARN_LABELS.filter(l => summary.warnCounts[l] > 0).map(l => {
                      const isBlocker = l === 'No lot' || l === 'Not inspected' || l === 'No price';
                      const cls = isBlocker
                        ? 'bg-red-500/10 text-red-400 border-red-500/30'
                        : 'bg-amber-500/10 text-amber-400/90 border-amber-500/25';
                      return (
                        <span key={l} className={`inline-flex items-center px-1.5 h-4 rounded text-[9px] font-medium border ${cls}`}>
                          {l} <span className="ml-1 font-mono opacity-80">×{summary.warnCounts[l]}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
                {summary.profitIncomplete && (
                  <div className="text-[10px] text-amber-400/70 mt-1.5 italic">
                    {summary.priceOrCostIncomplete
                      ? '* Some items are missing price, cost, or Amazon fee — profit totals are estimates.'
                      : '* Some items have no cached Amazon fee — net/ROI/margin are estimates.'}
                  </div>
                )}
              </div>

            <div className="flex-1 overflow-y-auto space-y-3 min-h-0 pr-1">
              {batchArray.map(item => (
                <BatchItemCard
                  key={item.sku}
                  item={item}
                  onChange={updates => updateBatchItem(item.sku, updates)}
                  onRemove={() => removeFromBatch(item.sku)}
                  onSave={() => saveItem(item.sku)}
                  onCreateLot={() => createLot(item.sku)}
                  onPrintLabel={() => openLabelPrint([item])}
                  onEdit={() => updateBatchItem(item.sku, { save_state: 'idle', save_error: null })}
                  onImageClick={() => item.image_url && setLightbox({
                    src: item.image_url,
                    title: item.product_name || item.asin || item.sku,
                    asin: item.asin || '',
                    sku: item.sku,
                  })}
                  focusQty={focusQtySku === item.sku}
                  onQtyFocused={() => setFocusQtySku(null)}
                />
              ))}
            </div>
            </>
          )}
        </div>
      </div>

      {previewError && (
        <div className="fixed bottom-4 right-4 z-40 max-w-md px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400 shadow-lg flex items-start gap-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span className="flex-1">{previewError}</span>
          <button onClick={() => setPreviewError(null)} className="shrink-0 p-1 hover:bg-red-500/10 rounded">
            <X size={12} />
          </button>
        </div>
      )}

      {previewOpen && previewRows.length > 0 && (
        <PreviewModal
          rows={previewRows}
          shippingTemplate={previewTemplate}
          onClose={() => setPreviewOpen(false)}
          onPushComplete={() => { setPreviewOpen(false); }}
        />
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setLightbox(null)}
        >
          <div
            className="bg-bg-surface border border-border-subtle rounded-xl shadow-2xl max-w-[560px] w-full overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-4 py-3 border-b border-border-subtle gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-primary leading-snug line-clamp-2" title={lightbox.title}>
                  {lightbox.title}
                </div>
                <div className="flex items-center gap-2 mt-1 text-[10px] font-mono text-text-tertiary">
                  {lightbox.asin && <span className="text-accent/80">{lightbox.asin}</span>}
                  <span className="truncate" title={lightbox.sku}>{lightbox.sku}</span>
                </div>
              </div>
              <button
                onClick={() => setLightbox(null)}
                className="shrink-0 p-1.5 rounded hover:bg-bg-hover text-text-tertiary"
                title="Close (Esc)"
              >
                <X size={16} />
              </button>
            </div>
            <div className="bg-bg-elevated flex items-center justify-center p-4">
              <img
                src={lightbox.src}
                alt={lightbox.title}
                className="max-w-full max-h-[60vh] object-contain"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
