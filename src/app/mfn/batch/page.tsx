'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { formatCurrency } from '@/lib/formatters';
import { Search, X, Plus, CheckCircle2, AlertCircle, Loader2, Save, PackagePlus, Printer, Send, Pencil, Info } from 'lucide-react';
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
  fulfillment_channel: string | null;
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
  marking_inspected: boolean;
  mark_inspect_error: string | null;
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
    marking_inspected:       false,
    mark_inspect_error:      null,
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

// Independent receive-state predicates for the filter strip. Each predicate
// is evaluated per item independently — buckets are NOT mutually exclusive
// (e.g. a clean 1/1 saved row is both Complete and Ready to push). Print All
// and Preview & Push do NOT use these — they keep their own eligibility
// logic on the full batch.
type FilterKey = 'over' | 'needs-work' | 'complete' | 'ready';

function isOverReceived(item: BatchItem): boolean {
  const p = getReceiveProgress(item);
  return p != null && p.isOver;
}

// Complete = saved row whose receive progress hit 100% and is not over.
// Can overlap with Ready to push — that's intentional.
function isComplete(item: BatchItem): boolean {
  if (item.save_state !== 'saved') return false;
  const p = getReceiveProgress(item);
  return p != null && p.pct >= 100 && !p.isOver;
}

// Ready to push = saved + has local lot + quantity_received > 0 +
// inspected_at + valid price. Stale local Amazon status does NOT
// disqualify. A 100%-received row is still Ready (overlaps with Complete).
function isReadyToPush(item: BatchItem): boolean {
  if (item.save_state !== 'saved') return false;
  if (item.il_id == null) return false;
  const qty = item.quantity_received != null ? Number(item.quantity_received) : 0;
  if (qty <= 0) return false;
  if (!item.inspected_at) return false;
  const priceNum = parseFloat(item.draft_list_price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) return false;
  return true;
}

// Needs work = unsaved (needs a Save click before Print All / Preview &
// Push will include it), OR any hard blocker chip (No lot / Not inspected
// / No price), OR missing operational field chip (No bin / No condition).
function needsWork(item: BatchItem): boolean {
  if (item.save_state !== 'saved') return true;
  const chips = chipsForBatchItem(item);
  if (chips.some(c => c.tone === 'blocker')) return true;
  if (chips.some(c => c.label === 'No bin' || c.label === 'No condition')) return true;
  return false;
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

// Renders a flat list of WarningChip elements. Callers own the wrapping
// container (gap, flex, null-guard) so this stays layout-agnostic.
function BatchItemChips({ chips }: { chips: Chip[] }) {
  return <>{chips.map(c => <WarningChip key={c.label} chip={c} />)}</>;
}

// Compact chip strip for saved-row Zone 7.
// Always shows all blockers (No lot / Not inspected / No price) first,
// then up to 1 warn chip, then a "+N" overflow badge listing hidden labels.
// Full chips are still shown in expanded cards and the detail drawer.
function RowChips({ chips }: { chips: Chip[] }) {
  if (chips.length === 0) return null;
  const blockers = chips.filter(c => c.tone === 'blocker');
  const warns    = chips.filter(c => c.tone === 'warn');
  const shown    = [...blockers, ...warns.slice(0, 1)];
  const hidden   = warns.slice(1);
  return (
    <>
      {shown.map(c => <WarningChip key={c.label} chip={c} />)}
      {hidden.length > 0 && (
        <span
          className="inline-flex items-center px-1.5 h-4 rounded text-[9px] font-medium border bg-bg-elevated border-border-subtle text-text-tertiary"
          title={hidden.map(c => c.label).join(', ')}
        >
          +{hidden.length}
        </span>
      )}
    </>
  );
}

// Channel badge — DEFAULT = MFN, AMAZON_NA = FBA. Sourced from
// merchant_listings.fulfillment_channel. Display only.
function ChannelBadge({ channel }: { channel: string | null | undefined }) {
  if (!channel) return null;
  const isFba = channel === 'AMAZON_NA';
  const label = isFba ? 'FBA' : channel === 'DEFAULT' ? 'MFN' : channel;
  const cls = isFba
    ? 'bg-sky-500/10 text-sky-400 border-sky-500/30'
    : 'bg-purple-500/10 text-purple-400 border-purple-500/30';
  return (
    <span className={`inline-flex items-center px-1.5 h-4 rounded text-[9px] font-medium border ${cls}`} title={`Fulfillment channel: ${channel}`}>
      {label}
    </span>
  );
}

// Receive progress derived from existing fields — display only.
// total    = parsed_order_qty (from MSKU) ?? quantity_received (best local proxy)
// received = quantity_received
// remaining = max(0, total - received)
// Returns null when there's no lot OR no usable signal for total.
interface ReceiveProgress { total: number; received: number; remaining: number; pct: number; isOver: boolean }

function getReceiveProgress(item: BatchItem): ReceiveProgress | null {
  if (item.il_id == null) return null;
  const parsedTotal = item.parsed_order_qty != null && item.parsed_order_qty > 0 ? Number(item.parsed_order_qty) : null;
  const received    = item.quantity_received != null ? Math.max(0, Number(item.quantity_received)) : 0;
  const total       = parsedTotal ?? (received > 0 ? received : null);
  if (total == null || total <= 0) return null;
  // Keep `received` as the actual quantity_received. Cap the bar's pct at 100% but
  // surface the over-receive condition so callers can flag it visually.
  const remaining = Math.max(0, total - received);
  const pct = Math.min(100, Math.round((Math.min(received, total) / total) * 100));
  const isOver = received > total;
  return { total, received, remaining, pct, isOver };
}

function ReceiveProgressBar({ progress, variant = 'compact' }: { progress: ReceiveProgress; variant?: 'compact' | 'full' }) {
  const fillCls = progress.isOver
    ? 'bg-amber-500/70'
    : progress.pct >= 100 ? 'bg-green-500/70' : 'bg-amber-500/70';
  const recvCls = progress.isOver ? 'text-amber-400 font-medium' : 'text-text-tertiary';
  const overTitle = progress.isOver
    ? `Over-received: ${progress.received - progress.total} extra (received ${progress.received} of ${progress.total})`
    : `Received ${progress.received} of ${progress.total} · ${progress.remaining} remaining`;

  if (variant === 'compact') {
    return (
      <span className="inline-flex items-center gap-1.5" title={overTitle}>
        <span className={`font-mono ${recvCls}`}>
          Recv {progress.received}/{progress.total}{progress.isOver ? ' · Over' : ''}
        </span>
        <span className="inline-block w-12 h-1 bg-bg-elevated rounded-full overflow-hidden">
          <span className={`block h-full rounded-full transition-all ${fillCls}`} style={{ width: `${progress.pct}%` }} />
        </span>
      </span>
    );
  }
  return (
    <div className="mb-3 px-3 py-2 bg-bg-elevated/50 rounded-lg border border-border-subtle">
      <div className="flex items-center justify-between text-[11px] mb-1.5">
        <span className="text-text-tertiary">
          Receive progress
          {progress.isOver && (
            <span className="ml-2 text-amber-400/90 font-medium" title={overTitle}>
              · Over by {progress.received - progress.total}
            </span>
          )}
        </span>
        <span className="tabular-nums">
          <span className={`font-mono ${progress.isOver ? 'text-amber-400/90' : 'text-green-400/90'}`}>
            Received {progress.received}
          </span>
          <span className="text-text-tertiary/50 mx-1.5">·</span>
          <span className={`font-mono ${progress.remaining > 0 ? 'text-amber-400/80' : 'text-text-tertiary'}`}>
            Remaining {progress.remaining}
          </span>
          <span className="text-text-tertiary/50 mx-1.5">/</span>
          <span className="font-mono text-text-secondary">{progress.total}</span>
        </span>
      </div>
      <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${fillCls}`} style={{ width: `${progress.pct}%` }} />
      </div>
    </div>
  );
}

// Inline qty quick-edit for the saved row. Local UI state; commits via
// the parent's onSave (which only touches quantity_received via the
// existing inventory-lots PATCH route).
interface InlineQtyEditProps {
  value: number | null;
  onSave: (newQty: number) => Promise<{ ok: boolean; error?: string }>;
  forceOpen?: boolean;
  onOpened?: () => void;
}

function InlineQtyEdit({ value, onSave, forceOpen, onOpened }: InlineQtyEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  // Guards Enter + blur double-fire (and rapid clicks). Reset on each open.
  const committedRef = useRef(false);

  function start() {
    if (saving) return;
    setDraft(String(value ?? 0));
    committedRef.current = false;
    setError(null);
    setEditing(true);
  }

  function cancel() {
    committedRef.current = true;
    setEditing(false);
    setError(null);
  }

  async function commit() {
    if (committedRef.current) return;
    committedRef.current = true;
    // Strict whole-integer validation. Rejects blank, decimal, negative,
    // Infinity, NaN, scientific notation, signs, and any non-digit.
    const trimmed = draft.trim();
    if (!/^\d+$/.test(trimmed)) {
      setError('Whole number ≥ 0');
      committedRef.current = false; // keep open, allow retry
      return;
    }
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 0) {
      setError('Whole number ≥ 0');
      committedRef.current = false;
      return;
    }
    if (n === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await onSave(n);
    setSaving(false);
    if (result.ok) {
      setEditing(false);
    } else {
      setError(result.error ?? 'Save failed');
      // Allow retry — clear the guard so Enter/blur can re-fire on the next attempt.
      committedRef.current = false;
    }
  }

  // Opens the editor imperatively when the parent signals focusQty for this row.
  // autoFocus on the input handles actual DOM focus once editing=true renders.
  useEffect(() => {
    if (forceOpen) { start(); onOpened?.(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceOpen]);

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          type="number" min="0" step={1} inputMode="numeric" autoFocus
          value={draft}
          onChange={e => { setDraft(e.target.value); if (error) setError(null); }}
          onKeyDown={e => {
            if (e.key === 'Enter')      { e.preventDefault(); commit(); }
            else if (e.key === 'Escape'){ e.preventDefault(); cancel(); }
          }}
          onBlur={() => commit()}
          disabled={saving}
          aria-invalid={error ? true : undefined}
          className={`w-12 h-5 px-1.5 bg-bg-elevated rounded text-[10px] font-mono text-text-primary focus:outline-none disabled:opacity-50 border ${
            error ? 'border-red-500/60 focus:border-red-500' : 'border-accent/40 focus:border-accent'
          }`}
        />
        {saving && <Loader2 size={9} className="animate-spin text-text-tertiary/70" />}
        {error && <span className="text-[9px] text-red-400" title={error}>!</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      className="font-mono inline-flex items-center hover:text-text-secondary px-1 -mx-1 rounded hover:bg-bg-elevated/50 transition-colors"
      title="Click to edit received qty"
    >
      Qty {value ?? '—'}
    </button>
  );
}

// Discriminator: a BatchItem has draft_* fields and save_state; a bare
// SearchResult does not. Used by the details drawer to render fewer
// sections when opened from a search result that hasn't been added.
function isBatchItem(item: SearchResult | BatchItem): item is BatchItem {
  return 'draft_qty' in item;
}

// Read-only details flyout. No API calls; reuses ChannelBadge,
// WarningChip, ReceiveProgressBar, calcProfit, formatCurrency. Doesn't
// mutate save_state or touch any draft_* fields.
interface ItemDetailDrawerProps {
  item: SearchResult | BatchItem;
  onImageClick: () => void;
  onPrintLabel?: () => void;
  onEdit?: () => void;
  onClose: () => void;
}

function ItemDetailDrawer({ item, onImageClick, onPrintLabel, onEdit, onClose }: ItemDetailDrawerProps) {
  const inBatch = isBatchItem(item);
  const progress = inBatch ? getReceiveProgress(item) : null;
  const profit   = inBatch ? calcProfit(item) : null;
  const chips    = inBatch ? chipsForBatchItem(item) : chipsForResult(item);

  // Saved-field fallback display values (prefer persisted, then drafts).
  const condDisplay = (item.condition || (inBatch ? item.draft_condition.trim() : '')) || null;
  const binDisplay  = (item.bin_location || (inBatch ? item.draft_bin.trim() : '')) || null;
  const tmplDisplay = (item.merchant_shipping_group_name || (inBatch ? item.draft_shipping_template.trim() : '')) || null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="bg-bg-surface border-l border-border-subtle shadow-2xl w-[400px] max-w-full h-full overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start gap-3 px-4 py-3 bg-bg-surface border-b border-border-subtle">
          {item.image_url
            ? <button type="button" onClick={onImageClick} className="shrink-0 rounded overflow-hidden bg-bg-elevated hover:ring-2 hover:ring-accent/40 transition-shadow" title="View larger">
                <img src={item.image_url} alt="" className="w-14 h-14 object-contain block" />
              </button>
            : <div className="w-14 h-14 bg-bg-elevated rounded shrink-0" />}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-primary leading-snug line-clamp-3" title={item.product_name ?? item.asin}>
              {item.product_name || item.asin}
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap text-[10px] text-text-tertiary">
              <span className="font-mono text-accent">{item.asin}</span>
              <ChannelBadge channel={item.fulfillment_channel} />
              {liveStateBadge(item.amazon_status, item.amazon_qty)}
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 p-1 rounded hover:bg-bg-hover text-text-tertiary" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-3 space-y-4 text-[11px]">
          {/* Identifiers */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Identifiers</div>
            <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-3">
              <span className="text-text-tertiary">ASIN</span><span className="font-mono text-text-secondary">{item.asin}</span>
              {item.upc && (<><span className="text-text-tertiary">UPC</span><span className="font-mono text-text-secondary">{item.upc}</span></>)}
              <span className="text-text-tertiary">MSKU</span>
              <span className="font-mono text-text-secondary break-all">{item.sku}</span>
            </div>
          </section>

          {/* Amazon snapshot */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Amazon (local snapshot)</div>
            <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-3">
              <span className="text-text-tertiary">Status</span><span className="text-text-secondary">{item.amazon_status ?? '—'}</span>
              <span className="text-text-tertiary">Amz qty</span><span className="font-mono text-text-secondary">{item.amazon_qty ?? '—'}</span>
              {item.amazon_list_price_cents != null && (<><span className="text-text-tertiary">Amz price</span><span className="font-mono text-text-secondary">{formatCurrency(item.amazon_list_price_cents)}</span></>)}
            </div>
          </section>

          {/* Receive */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Receive</div>
            <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-3 mb-2">
              <span className="text-text-tertiary">Received</span><span className="font-mono text-text-secondary">{item.quantity_received ?? '—'}</span>
              <span className="text-text-tertiary">Order qty</span><span className="font-mono text-text-secondary">{item.parsed_order_qty ?? '—'}</span>
              <span className="text-text-tertiary" title="inventory_ledger.quantity_remaining — sellable units left in the lot, not 'remaining to receive'">Unsold qty</span><span className="font-mono text-text-secondary">{item.quantity_remaining ?? '—'}</span>
              <span className="text-text-tertiary">Inspected</span><span className="text-text-secondary">{item.inspected_at ? '✓ ' + item.inspected_at.slice(0, 10) : '—'}</span>
            </div>
            {progress && <ReceiveProgressBar progress={progress} variant="full" />}
          </section>

          {/* Money — only for items in the batch with draft fields */}
          {inBatch && profit && profit.listCents != null && profit.costCents != null && (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Profit estimate</div>
              <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-3">
                <span className="text-text-tertiary">List</span><span className="font-mono text-text-secondary">{formatCurrency(profit.listCents)}</span>
                <span className="text-text-tertiary">Cost</span><span className="font-mono text-text-secondary">{formatCurrency(profit.costCents)}</span>
                <span className="text-text-tertiary">Ship est</span><span className="font-mono text-text-secondary">{formatCurrency(profit.shipCents)}</span>
                <span className="text-text-tertiary">{profit.referralRate != null ? `Referral (${(profit.referralRate * 100).toFixed(0)}%)` : 'Fee'}</span>
                <span className={`font-mono ${profit.hasFee ? 'text-text-secondary' : 'text-amber-400/80'}`}>
                  {profit.referralCents != null ? formatCurrency(profit.referralCents) : 'unknown'}
                </span>
                {profit.vcfCents > 0 && (<><span className="text-text-tertiary">VCF</span><span className="font-mono text-text-secondary">{formatCurrency(profit.vcfCents)}</span></>)}
                <span className="text-text-tertiary">Net</span>
                <span className={`font-mono font-medium ${
                  !profit.hasFee ? 'text-amber-400' : profit.netCents != null && profit.netCents > 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {profit.netCents != null ? formatCurrency(profit.netCents) : '—'}{!profit.hasFee ? '*' : ''}
                </span>
                {profit.roiPct != null && (<><span className="text-text-tertiary">ROI</span>
                  <span className={`font-mono ${!profit.hasFee ? 'text-amber-400/90' : profit.roiPct > 0 ? 'text-green-400/90' : 'text-red-400/90'}`}>
                    {profit.roiPct.toFixed(1)}%{!profit.hasFee ? '*' : ''}
                  </span></>)}
                {profit.marginPct != null && (<><span className="text-text-tertiary">Margin</span>
                  <span className={`font-mono ${!profit.hasFee ? 'text-amber-400/90' : 'text-text-secondary'}`}>
                    {profit.marginPct.toFixed(1)}%{!profit.hasFee ? '*' : ''}
                  </span></>)}
              </div>
              {!profit.hasFee && (
                <p className="text-[10px] text-amber-400/70 italic mt-1.5">* No cached Amazon fee — net/ROI/margin are estimates.</p>
              )}
            </section>
          )}

          {/* Saved fields */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Saved fields</div>
            <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-3">
              <span className="text-text-tertiary">Condition</span><span className="text-text-secondary">{condDisplay ?? '—'}</span>
              <span className="text-text-tertiary">Bin</span><span className="font-mono text-text-secondary">{binDisplay ?? '—'}</span>
              <span className="text-text-tertiary">Template</span><span className="font-mono text-text-secondary text-[10px] break-all">{tmplDisplay ?? '—'}</span>
            </div>
          </section>

          {/* Warnings */}
          {chips.length > 0 && (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Warnings</div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {chips.map(c => <WarningChip key={c.label} chip={c} />)}
              </div>
            </section>
          )}
        </div>

        {/* Footer actions */}
        <div className="sticky bottom-0 px-4 py-3 bg-bg-surface border-t border-border-subtle flex items-center justify-end gap-2">
          {onPrintLabel && (
            <button
              onClick={onPrintLabel}
              className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-subtle text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
            >
              <Printer size={12} /> Print label
            </button>
          )}
          {onEdit && (
            <button
              onClick={onEdit}
              className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-subtle text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
            >
              <Pencil size={12} /> Edit
            </button>
          )}
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-bg-elevated text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
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
  onShowDetail: () => void;
}

function SearchResultCard({ result, inBatch, onAdd, onImageClick, onShowDetail }: SearchResultCardProps) {
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
          <ChannelBadge channel={result.fulfillment_channel} />
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

      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onShowDetail}
          className="p-1.5 rounded-md text-text-tertiary/60 hover:text-accent hover:bg-bg-elevated transition-colors"
          title="View details"
        >
          <Info size={13} />
        </button>
        <button
          onClick={onAdd}
          disabled={inBatch}
          className={`h-8 px-2.5 rounded-md text-xs font-medium border transition-colors flex items-center gap-1 ${
            inBatch
              ? 'border-accent/30 text-accent/60 cursor-default'
              : 'border-accent/50 text-accent hover:bg-accent/10'
          }`}
        >
          {inBatch ? <CheckCircle2 size={12} /> : <Plus size={12} />}
          {inBatch ? 'Added' : 'Add'}
        </button>
      </div>
    </div>
  );
}

// Derives display values for a saved/collapsed BatchItemCard row.
// Fallback priority: persisted DB field → draft field → null.
// Pure helper — no side effects, safe to call from any render context.
function getSavedDisplay(item: BatchItem) {
  return {
    savedQty:   item.quantity_received ?? (parseInt(item.draft_qty, 10) || null),
    savedPrice: item.il_list_price_cents
      ?? (item.draft_list_price ? Math.round(parseFloat(item.draft_list_price) * 100) : null),
    savedBin:   item.bin_location || item.draft_bin.trim() || null,
    savedCond:  item.condition    || item.draft_condition.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// BatchItemRow — collapsed view for saved items
// ---------------------------------------------------------------------------

interface BatchItemRowProps {
  item: BatchItem;
  onRemove: () => void;
  onPrintLabel: () => void;
  onEdit: () => void;
  onSaveQty: (newQty: number) => Promise<{ ok: boolean; error?: string }>;
  onMarkInspected: () => void;
  onImageClick: () => void;
  onShowDetail: () => void;
  focusQty: boolean;
  onQtyFocused: () => void;
}

function BatchItemRow({ item, onRemove, onPrintLabel, onEdit, onSaveQty, onMarkInspected, onImageClick, onShowDetail, focusQty, onQtyFocused }: BatchItemRowProps) {
  const { savedQty, savedPrice, savedBin, savedCond } = getSavedDisplay(item);
  const receiveProgress = getReceiveProgress(item);
  const chips = chipsForBatchItem(item);
  const showMarkInspected = item.il_id != null && (item.quantity_received ?? 0) > 0 && !item.inspected_at;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-green-500/20 bg-green-500/5">

      {/* Zone 1 — image (32px fixed) */}
      {item.image_url
        ? (
            <button type="button" onClick={onImageClick}
              className="shrink-0 rounded overflow-hidden bg-bg-elevated hover:ring-2 hover:ring-accent/40 transition-shadow"
              title="View larger">
              <img src={item.image_url} alt="" className="w-8 h-8 object-contain block" />
            </button>
          )
        : <div className="w-8 h-8 bg-bg-elevated rounded shrink-0" />}

      {/* Zone 2 — product identity (flex-1, truncates): name + ASIN + channel */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <CheckCircle2 size={10} className="text-green-400 shrink-0" />
          <span className="text-xs font-medium text-text-primary truncate" title={item.product_name ?? item.asin}>
            {item.product_name || item.asin}
          </span>
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="font-mono text-[10px] text-accent/80 shrink-0">{item.asin}</span>
          <ChannelBadge channel={item.fulfillment_channel} />
        </div>
      </div>

      {/* Zone 3 — MSKU (112px, truncates) */}
      <div className="w-28 shrink-0">
        <span className="font-mono text-[9px] text-text-tertiary/50 truncate block" title={item.sku}>{item.sku}</span>
      </div>

      {/* Zone 4 — qty + receive progress (stacked, stable width) */}
      <div className="shrink-0 flex flex-col items-start gap-0.5">
        <InlineQtyEdit value={savedQty} onSave={onSaveQty} forceOpen={focusQty} onOpened={onQtyFocused} />
        {receiveProgress && <ReceiveProgressBar progress={receiveProgress} variant="compact" />}
      </div>

      {/* Zone 5 — bin / condition (present only when set) */}
      {(savedBin || savedCond) && (
        <div className="shrink-0 text-[10px] leading-tight">
          {savedBin && <div className="text-text-tertiary">Bin <span className="font-mono text-text-secondary">{savedBin}</span></div>}
          {savedCond && <div className="text-text-secondary max-w-[72px] truncate">{savedCond}</div>}
        </div>
      )}

      {/* Zone 6 — list price (right-aligned, stable tab stop) */}
      {savedPrice != null && (
        <div className="shrink-0 w-14 text-right">
          <span className="font-mono text-[11px] text-text-secondary">{formatCurrency(savedPrice)}</span>
        </div>
      )}

      {/* Zone 7 — UPC chip + warning chips + mark-inspected fallback (no wrap) */}
      {(item.upc || chips.length > 0 || showMarkInspected || item.mark_inspect_error) && (
        <div className="flex items-center gap-1 shrink-0">
          {item.upc && <UpcChip upc={item.upc} />}
          <RowChips chips={chips} />
          {showMarkInspected && (
            <button type="button" onClick={onMarkInspected} disabled={item.marking_inspected}
              className="inline-flex items-center gap-0.5 px-1.5 h-4 rounded text-[9px] font-medium border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-50"
              title="Marks this local lot inspected. Does not update Amazon.">
              {item.marking_inspected && <Loader2 size={8} className="animate-spin" />}
              Mark inspected
            </button>
          )}
          {item.mark_inspect_error && (
            <span className="text-[9px] text-red-400" title={item.mark_inspect_error}>!</span>
          )}
        </div>
      )}

      {/* Zone 8 — actions (pinned right) */}
      <button onClick={onShowDetail} className="shrink-0 p-1 text-text-tertiary/60 hover:text-accent rounded transition-colors" title="View details"><Info size={13} /></button>
      <button onClick={onPrintLabel} className="shrink-0 p-1 text-text-tertiary/60 hover:text-accent rounded transition-colors" title="Print ASIN label"><Printer size={13} /></button>
      <button onClick={onEdit} className="shrink-0 p-1 text-text-tertiary/60 hover:text-accent rounded transition-colors" title="Edit (reopens this card)"><Pencil size={13} /></button>
      <button onClick={onRemove} className="shrink-0 p-1 text-text-tertiary/40 hover:text-text-tertiary rounded" title="Remove"><X size={13} /></button>
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
  onSaveQty: (newQty: number) => Promise<{ ok: boolean; error?: string }>;
  onMarkInspected: () => void;
  onImageClick: () => void;
  onShowDetail: () => void;
  focusQty: boolean;
  onQtyFocused: () => void;
}

function BatchItemCard({ item, onChange, onRemove, onSave, onCreateLot, onPrintLabel, onEdit, onSaveQty, onMarkInspected, onImageClick, onShowDetail, focusQty, onQtyFocused }: BatchItemCardProps) {
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

  // Collapsed view delegates to BatchItemRow — keeps BatchItemCard focused on the edit path.
  if (item.save_state === 'saved') {
    return (
      <BatchItemRow
        item={item}
        onRemove={onRemove}
        onPrintLabel={onPrintLabel}
        onEdit={onEdit}
        onSaveQty={onSaveQty}
        onMarkInspected={onMarkInspected}
        onImageClick={onImageClick}
        onShowDetail={onShowDetail}
        focusQty={focusQty}
        onQtyFocused={onQtyFocused}
      />
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
            <ChannelBadge channel={item.fulfillment_channel} />
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
                <BatchItemChips chips={chips} />
              </div>
            ) : null;
          })()}
        </div>

        <button
          onClick={onShowDetail}
          className="shrink-0 p-1 text-text-tertiary/60 hover:text-accent rounded transition-colors"
          title="View details"
        >
          <Info size={14} />
        </button>
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

      {/* Receive progress — only when there's a lot AND a usable total signal */}
      {(() => { const p = getReceiveProgress(item); return p ? <ReceiveProgressBar progress={p} variant="full" /> : null; })()}

      {/* Mark inspected — only when received but not yet inspected */}
      {item.il_id != null && (item.quantity_received ?? 0) > 0 && !item.inspected_at && (
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={onMarkInspected}
            disabled={item.marking_inspected}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-50"
            title="Marks this local lot inspected. Does not update Amazon."
          >
            {item.marking_inspected
              ? <Loader2 size={11} className="animate-spin" />
              : <CheckCircle2 size={11} />}
            Mark inspected
          </button>
          <span className="text-[10px] text-text-tertiary/50">Local only</span>
          {item.mark_inspect_error && (
            <span className="text-[10px] text-red-400">{item.mark_inspect_error}</span>
          )}
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
  const searchInputRef     = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const multiMatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery]           = useState('');
  const [results, setResults]       = useState<SearchResult[]>([]);
  const [searching, setSearching]   = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [multiMatchNote, setMultiMatchNote] = useState(false);
  const [batch, setBatch]           = useState<Map<string, BatchItem>>(new Map());
  const [savingAll, setSavingAll]   = useState(false);
  const [focusQtySku, setFocusQtySku] = useState<string | null>(null);
  const [printAllMsg, setPrintAllMsg] = useState<string | null>(null);
  // Client-only receive-state filter for the visible batch list. Defaults
  // to 'all' so newly added items are never accidentally hidden.
  const [receiveFilter, setReceiveFilter] = useState<'all' | FilterKey>('all');
  const [lightbox, setLightbox] = useState<{ src: string; title: string; asin: string; sku: string } | null>(null);
  // Read-only details flyout. Keyed by sku + source so a re-render uses the
  // current state of the item from the right collection.
  const [detailDrawer, setDetailDrawer] = useState<{ sku: string; source: 'batch' | 'search' } | null>(null);
  const [previewOpen, setPreviewOpen]       = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRows, setPreviewRows]       = useState<ActivationPreviewRow[]>([]);
  const [previewTemplate, setPreviewTemplate] = useState('');
  const [previewError, setPreviewError]     = useState<string | null>(null);

  // Auto-focus search on mount
  useEffect(() => { searchInputRef.current?.focus(); }, []);

  // Close search dropdown when clicking outside the search container
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // Cleanup multi-match note timer on unmount
  useEffect(() => () => { if (multiMatchTimerRef.current) clearTimeout(multiMatchTimerRef.current); }, []);

  // Esc closes the lightbox
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // Esc closes the details drawer
  useEffect(() => {
    if (!detailDrawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetailDrawer(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailDrawer]);

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
    if (Number.isFinite(qtyNum) && qtyNum > 0) { body.markReceived = true; body.markInspected = true; }

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
        // Mirror just-saved drafts back onto the local row so the
        // collapsed view and batch summary reflect the new values
        // without waiting for a refetch. Only mirror fields that were
        // actually sent (same conditionals as the PATCH body above).
        const mirror: Partial<BatchItem> = { save_state: 'saved', save_error: null };
        if (Number.isFinite(qtyNum) && qtyNum >= 0) {
          mirror.quantity_received = qtyNum;
          if (qtyNum > 0) {
            const now = new Date().toISOString();
            if (!item.received_at)  mirror.received_at  = now;
            if (!item.inspected_at) mirror.inspected_at = now;
          }
        }
        if (item.draft_bin.trim())       mirror.bin_location = item.draft_bin.trim();
        if (item.draft_condition.trim()) mirror.condition    = item.draft_condition.trim();
        if (Number.isFinite(priceNum) && priceNum > 0) {
          mirror.il_list_price_cents = Math.round(priceNum * 100);
        }
        if (item.draft_shipping_template.trim()) {
          mirror.merchant_shipping_group_name = item.draft_shipping_template.trim();
        }
        updateBatchItem(sku, mirror);
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
      asin:         item.asin || undefined,
      quantity:     Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1,
      buyCents:     Number.isFinite(buyNum) && buyNum >= 0 ? Math.round(buyNum * 100) : 0,
      markReceived:  true,
      markInspected: true,
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
        inspected_at:                 lot.inspected_at != null ? String(lot.inspected_at) : item.inspected_at,
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

  // Inline qty edit on saved rows — narrow PATCH that only updates
  // quantity_received (and received_at once if missing). Does NOT touch
  // save_state, so the row stays collapsed. Bin/condition/price/template
  // are not sent — the route's per-field `!== undefined` gate leaves
  // those columns alone. Returns { ok, error? } so InlineQtyEdit can
  // restore the previous value on failure.
  async function saveQtyOnly(sku: string, newQty: number): Promise<{ ok: boolean; error?: string }> {
    const item = batch.get(sku);
    if (!item || item.il_id == null) return { ok: false, error: 'No lot' };

    const t0 = Date.now();
    console.log(`[saveQtyOnly] start sku=${sku} il_id=${item.il_id} qty=${newQty}`);

    const body: Record<string, unknown> = {
      id: item.il_id,
      quantityReceived: newQty,
      markReceived: newQty > 0,
    };

    try {
      const res = await fetch('/api/data/inventory-lots', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let errMsg = 'Save failed';
        try { errMsg = JSON.parse(text).error || errMsg; } catch { /* keep default */ }
        console.error(`[saveQtyOnly] fail sku=${sku} status=${res.status} elapsed=${elapsed}ms body=${text}`);
        return { ok: false, error: `${errMsg} (HTTP ${res.status})` };
      }
      console.log(`[saveQtyOnly] ok sku=${sku} elapsed=${elapsed}ms`);

      // Mirror the just-saved qty back onto the local row so the saved
      // row, summary, progress, and warning chips reflect the new value
      // immediately. Keep draft_qty in sync too so a later Edit opens
      // with the right number.
      const mirror: Partial<BatchItem> = {
        quantity_received: newQty,
        draft_qty: String(newQty),
      };
      if (newQty > 0 && !item.received_at) {
        mirror.received_at = new Date().toISOString();
      }
      updateBatchItem(sku, mirror);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[saveQtyOnly] network sku=${sku} err=${msg}`);
      return { ok: false, error: `Network error: ${msg}` };
    }
  }

  async function markInspected(sku: string) {
    const item = batch.get(sku);
    if (!item || item.il_id == null) return;

    updateBatchItem(sku, { marking_inspected: true, mark_inspect_error: null });

    const t0 = Date.now();
    console.log(`[markInspected] start sku=${sku} il_id=${item.il_id}`);

    try {
      const res = await fetch('/api/data/inventory-lots', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.il_id, markReceived: true, markInspected: true }),
      });
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let errMsg = 'Mark inspected failed';
        try { errMsg = JSON.parse(text).error || errMsg; } catch { /* keep default */ }
        console.error(`[markInspected] fail sku=${sku} status=${res.status} elapsed=${elapsed}ms body=${text}`);
        updateBatchItem(sku, { marking_inspected: false, mark_inspect_error: errMsg });
        return;
      }
      console.log(`[markInspected] ok sku=${sku} elapsed=${elapsed}ms`);

      const now = new Date().toISOString();
      const mirror: Partial<BatchItem> = {
        marking_inspected: false,
        mark_inspect_error: null,
        inspected_at: now,
      };
      if (!item.received_at) mirror.received_at = now;
      updateBatchItem(sku, mirror);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[markInspected] network sku=${sku} err=${msg}`);
      updateBatchItem(sku, { marking_inspected: false, mark_inspect_error: `Network error: ${msg}` });
    }
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

  // Receive-state counts — independent predicates, may overlap (e.g. a
  // clean 1/1 saved row is counted under both Complete and Ready to push).
  // Always from the full batch — counts don't change with the active filter.
  const stateCounts: Record<FilterKey, number> = {
    'needs-work': batchArray.filter(needsWork).length,
    ready:        batchArray.filter(isReadyToPush).length,
    complete:     batchArray.filter(isComplete).length,
    over:         batchArray.filter(isOverReceived).length,
  };

  // Apply the active filter only to the visible card list.
  const predicateFor: Record<FilterKey, (i: BatchItem) => boolean> = {
    'needs-work': needsWork,
    ready:        isReadyToPush,
    complete:     isComplete,
    over:         isOverReceived,
  };
  const visibleBatch = receiveFilter === 'all'
    ? batchArray
    : batchArray.filter(predicateFor[receiveFilter]);

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
                <span className="text-[10px] text-text-tertiary/80">
                  Ready to push:{' '}
                  <span className={stateCounts['ready'] > 0 ? 'text-green-400 font-medium' : ''}>
                    {stateCounts['ready']}
                  </span>
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

      {/* Search bar — full width, results as dropdown overlay */}
      <div ref={searchContainerRef} className="relative mb-4">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
          {searching && (
            <Loader2 size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary animate-spin" />
          )}
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onFocus={() => setSearchOpen(true)}
            onChange={e => {
              setQuery(e.target.value);
              setSearchOpen(true);
              if (multiMatchTimerRef.current) clearTimeout(multiMatchTimerRef.current);
              setMultiMatchNote(false);
            }}
            onKeyDown={e => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (results.length > 1) {
                if (multiMatchTimerRef.current) clearTimeout(multiMatchTimerRef.current);
                setMultiMatchNote(true);
                multiMatchTimerRef.current = setTimeout(() => setMultiMatchNote(false), 2000);
                return;
              }
              if (results.length !== 1) return;
              const sole = results[0];
              if (batch.has(sole.sku)) {
                // Clear any active filter so the row is visible before focus fires.
                setReceiveFilter('all');
                // Both expanded and saved/collapsed: setFocusQtySku drives focus.
                // Expanded cards use qtyRef; saved cards use InlineQtyEdit forceOpen.
                setFocusQtySku(sole.sku);
              } else {
                addToBatch(sole, true);
              }
              setQuery('');
              setResults([]);
            }}
            placeholder="Scan barcode, ASIN, MSKU, or title…"
            className="w-full h-11 pl-9 pr-9 bg-bg-elevated border border-border-default rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
          />
        </div>

        {/* Dropdown — visible when query ≥ 2 chars */}
        {searchOpen && query.trim().length >= 2 && (
          <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-bg-surface border border-border-default rounded-lg shadow-xl overflow-hidden">
            {/* Helper / status line */}
            <div className="px-3 py-1.5 border-b border-border-subtle">
              <p className="text-xs text-text-tertiary">
                {searching
                  ? 'Searching…'
                  : results.length === 1
                    ? batch.has(results[0].sku)
                      ? 'Press Enter to focus this item in the batch.'
                      : 'Press Enter to add this item.'
                    : results.length > 1
                      ? 'Refine search or click the correct item.'
                      : `No results for "${query}"`}
                {multiMatchNote && (
                  <span className="ml-2 text-amber-500">Multiple matches — choose an item.</span>
                )}
              </p>
            </div>
            {/* Results list */}
            {results.length > 0 && (
              <div className="overflow-y-auto max-h-80 p-1.5 space-y-1">
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
                    onShowDetail={() => setDetailDrawer({ sku: r.sku, source: batch.has(r.sku) ? 'batch' : 'search' })}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Batch area — full width */}
      <div className="flex-1 flex flex-col min-h-0">
        {batchArray.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center border border-dashed border-border-subtle rounded-xl text-text-tertiary">
            <Search size={32} className="mb-3 opacity-20" />
            <p className="text-sm font-medium">Batch is empty</p>
            <p className="text-xs mt-1 max-w-[200px]">Scan or search above to start a receive batch</p>
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

            {/* Client-only receive-state filter strip. Counts always reflect the full batch. */}
            <div className="mb-2 flex items-center gap-1.5 flex-wrap text-[11px]">
              {([
                { key: 'all' as const,         label: 'All',           count: batchArray.length },
                { key: 'needs-work' as const,  label: 'Needs work',    count: stateCounts['needs-work'] },
                { key: 'ready' as const,       label: 'Ready to push', count: stateCounts['ready'] },
                { key: 'complete' as const,    label: 'Complete',      count: stateCounts['complete'] },
                { key: 'over' as const,        label: 'Over received', count: stateCounts['over'] },
              ]).map(f => {
                const active = receiveFilter === f.key;
                const isOver = f.key === 'over';
                const isNeeds = f.key === 'needs-work';
                const accentCls = active
                  ? isOver
                    ? 'bg-red-500/15 text-red-400 border-red-500/40'
                    : isNeeds
                      ? 'bg-amber-500/15 text-amber-400 border-amber-500/40'
                      : f.key === 'complete'
                        ? 'bg-green-500/15 text-green-400 border-green-500/40'
                        : 'bg-accent/15 text-accent border-accent/40'
                  : 'bg-bg-elevated text-text-tertiary border-border-subtle hover:text-text-secondary hover:bg-bg-hover';
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setReceiveFilter(f.key)}
                    disabled={f.count === 0 && f.key !== 'all'}
                    className={`flex items-center gap-1.5 h-6 px-2 rounded-md border font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${accentCls}`}
                  >
                    {f.label}
                    <span className="font-mono tabular-nums text-[10px] opacity-80">{f.count}</span>
                  </button>
                );
              })}
              {receiveFilter !== 'all' && (
                <span className="ml-1 text-text-tertiary/80 italic">
                  Showing {visibleBatch.length} of {batchArray.length}
                </span>
              )}
            </div>

            {receiveFilter !== 'all' && (
              <div className="mb-2 -mt-1 text-[10px] text-text-tertiary/60 italic">
                Filters only change visible rows; Print All and Preview &amp; Push use the full saved batch.
              </div>
            )}

            <div className="flex-1 overflow-y-auto space-y-3 min-h-0 pr-1">
              {receiveFilter !== 'all' && visibleBatch.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10 text-center text-text-tertiary">
                  <p className="text-sm">No items match this filter.</p>
                  <button
                    type="button"
                    onClick={() => setReceiveFilter('all')}
                    className="mt-2 text-xs text-accent hover:underline"
                  >
                    Show all
                  </button>
                </div>
              )}
              {visibleBatch.map(item => (
                <BatchItemCard
                  key={item.sku}
                  item={item}
                  onChange={updates => updateBatchItem(item.sku, updates)}
                  onRemove={() => removeFromBatch(item.sku)}
                  onSave={() => saveItem(item.sku)}
                  onCreateLot={() => createLot(item.sku)}
                  onPrintLabel={() => openLabelPrint([item])}
                  onEdit={() => updateBatchItem(item.sku, { save_state: 'idle', save_error: null })}
                  onSaveQty={(q) => saveQtyOnly(item.sku, q)}
                  onMarkInspected={() => markInspected(item.sku)}
                  onImageClick={() => item.image_url && setLightbox({
                    src: item.image_url,
                    title: item.product_name || item.asin || item.sku,
                    asin: item.asin || '',
                    sku: item.sku,
                  })}
                  onShowDetail={() => setDetailDrawer({ sku: item.sku, source: 'batch' })}
                  focusQty={focusQtySku === item.sku}
                  onQtyFocused={() => setFocusQtySku(null)}
                />
              ))}
            </div>
            </>
          )}
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

      {detailDrawer && (() => {
        const di: SearchResult | BatchItem | null = detailDrawer.source === 'batch'
          ? batch.get(detailDrawer.sku) ?? null
          : results.find(r => r.sku === detailDrawer.sku) ?? null;
        if (!di) { return null; }
        const isBatch = isBatchItem(di);
        return (
          <ItemDetailDrawer
            item={di}
            onClose={() => setDetailDrawer(null)}
            onImageClick={() => di.image_url && setLightbox({
              src: di.image_url,
              title: di.product_name || di.asin || di.sku,
              asin: di.asin || '',
              sku: di.sku,
            })}
            onPrintLabel={isBatch && di.asin ? () => openLabelPrint([di]) : undefined}
            onEdit={isBatch && di.save_state === 'saved' ? () => {
              updateBatchItem(di.sku, { save_state: 'idle', save_error: null });
              setDetailDrawer(null);
            } : undefined}
          />
        );
      })()}

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
