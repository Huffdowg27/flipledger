'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { formatCurrency, formatRelativeTime } from '@/lib/formatters';
import { Search, ScanBarcode, Package, X, Plus, CheckCircle2, AlertCircle, Loader2, Save, PackagePlus, Printer, Send, Pencil, Info, Image as ImageIcon, Lock } from 'lucide-react';
import { PreviewModal, type ActivationPreviewRow } from '@/components/activation/PreviewModal';
import { PrintLabelIcon } from '@/components/ui/PrintLabel';

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
  last_synced: string | null;
  product_name: string | null;
  image_url: string | null;
  buy_price: number | null;
  il_list_price_cents: number | null;
  bin_location: string | null;
  condition: string | null;
  quantity_received: number | null;
  quantity_remaining: number | null;
  lot_quantity?: number | null;
  open_issue_count?: number | null;
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
  open_incoming_purchases?: IncomingPurchaseCandidate[];
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type CreateLotState = 'idle' | 'creating' | 'error';
type IssueType = 'damaged' | 'wrong_item' | 'not_as_described' | 'other';

interface IncomingPurchaseCandidate {
  id: number;
  order_ref: string | null;
  order_source: string | null;
  asin: string | null;
  sku: string | null;
  quantity: number;
  quantity_received: number;
  unit_cost_cents: number;
  ordered_at: string | null;
  status: string;
}

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
  auto_print_error?: string | null; // last auto-print failure (never blocks the save)
  create_lot_state: CreateLotState;
  create_lot_error: string | null;
  slow_create_lot: boolean;      // true once create-lot has been in-flight > 3s
  marking_inspected: boolean;
  mark_inspect_error: string | null;
  incoming_receive_choice: 'new' | number | null;
  incoming_reconcile_warning?: string | null;
}

const CONDITIONS = [
  'New',
  'Used - Like New',
  'Used - Very Good',
  'Used - Good',
  'Used - Acceptable',
];

const ISSUE_TYPE_OPTIONS: Array<{ value: IssueType; label: string }> = [
  { value: 'damaged', label: 'Damaged' },
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'other', label: 'Other' },
];

interface ShippingTemplate { key: string; name: string; }

// Match a stored value (which may be an old display name OR a current key) to
// a template entry by checking key first, then name. Returns null if unknown.
function resolveShippingTemplate(value: string, templates: ShippingTemplate[] | null): ShippingTemplate | null {
  if (!value || !templates) return null;
  return templates.find(t => t.key === value || t.name === value) ?? null;
}

// Return the user-facing label for a stored value. If the value matches a
// known template (by key or name), returns the template's name. Unknown values
// are returned as-is so nothing is silently lost.
function displayShippingTemplate(value: string, templates: ShippingTemplate[] | null): string {
  if (!value) return '';
  return resolveShippingTemplate(value, templates)?.name ?? value;
}

// Return the canonical Amazon key to write to the DB / PATCH body. If the
// value resolves to a known template, returns its key (normalizing old display
// names → keys). Unknown values are passed through unchanged.
function storageShippingTemplate(value: string, templates: ShippingTemplate[] | null): string {
  if (!value) return '';
  return resolveShippingTemplate(value, templates)?.key ?? value;
}

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

function listingFreshness(results: SearchResult[]) {
  const latest = results.reduce<number | null>((max, result) => {
    if (!result.last_synced) return max;
    const time = new Date(result.last_synced).getTime();
    if (!Number.isFinite(time)) return max;
    return max == null || time > max ? time : max;
  }, null);

  if (latest == null) return null;

  const ageMs = Date.now() - latest;
  const syncedAt = new Date(latest);
  const stale = ageMs > 2 * 3600 * 1000;

  return {
    stale,
    label: `${stale ? 'Stale - ' : ''}Synced ${formatRelativeTime(syncedAt.toISOString())}`,
    title: `Merchant listing data last synced ${syncedAt.toLocaleString()}`,
  };
}

// Sticky receiving defaults: remember the operator's last-used shipping
// template and condition, prefill them on items that don't carry their own.
// Change either on any card and the new value becomes the default.
const STICKY_TEMPLATE_KEY = 'fl_mfn_default_shipping_template';
const STICKY_CONDITION_KEY = 'fl_mfn_default_condition';
// Auto-print ASIN stickers on save ('1'/'0'). It arms a physical printer, so
// the header toggle shows a loud accent while enabled.
const STICKY_AUTOPRINT_KEY = 'fl_mfn_autoprint_label';

function stickyDefault(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

export function rememberStickyDefault(key: string, value: string) {
  if (typeof window === 'undefined' || !value.trim()) return;
  try { localStorage.setItem(key, value.trim()); } catch { /* storage unavailable */ }
}

function makeBatchItem(r: SearchResult): BatchItem {
  const costCents = r.buy_price ?? r.parsed_cost_cents;
  const priceCents = r.il_list_price_cents ?? r.amazon_list_price_cents ?? r.parsed_list_price_cents;
  return {
    ...r,
    draft_qty:               String(r.quantity_received ?? r.quantity_remaining ?? 1),
    draft_bin:               r.bin_location ?? '',
    draft_condition:         r.condition ?? stickyDefault(STICKY_CONDITION_KEY, 'New'),
    draft_list_price:        priceCents != null ? (priceCents / 100).toFixed(2) : '',
    draft_buy_price:         costCents   != null ? (costCents  / 100).toFixed(2) : '',
    draft_shipping_template: r.merchant_shipping_group_name ?? stickyDefault(STICKY_TEMPLATE_KEY, ''),
    draft_shipping_est:      '8.00',
    save_state:              'idle',
    save_error:              null,
    slow_save:               false,
    create_lot_state:        'idle',
    create_lot_error:        null,
    slow_create_lot:         false,
    marking_inspected:       false,
    mark_inspect_error:      null,
    incoming_receive_choice: (r.open_incoming_purchases?.length ?? 0) > 0 ? null : 'new',
    incoming_reconcile_warning: null,
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

type ChipTone = 'blocker' | 'warn' | 'info';
interface Chip { label: string; tone: ChipTone; title?: string }

function chipsForResult(r: SearchResult): Chip[] {
  const chips: Chip[] = [];
  if (r.amazon_status && r.amazon_status !== 'Active') chips.push({ label: 'Stale status', tone: 'warn', title: `Local Amazon status is "${r.amazon_status}" — may be out of sync with Seller Central` });
  if (r.referral_fee_cents == null) chips.push({ label: 'Fee unknown', tone: 'info', title: 'No cached referral fee — ROI estimate excludes Amazon fee' });
  return chips;
}

type WarnLabel = 'Not inspected' | 'Stale status' | 'No price' | 'Fee unknown';
const WARN_LABELS: WarnLabel[] = ['Not inspected', 'Stale status', 'No price', 'Fee unknown'];

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

// Ready to push = saved + has a saved record + quantity_received > 0 +
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
// Push will include it), OR a hard blocker chip (missing price is the
// main blocker). Not inspected is amber/warn — it gates push eligibility
// but does not trigger needs-work. Missing condition is soft metadata.
function needsWork(item: BatchItem): boolean {
  if (item.save_state !== 'saved') return true;
  const chips = chipsForBatchItem(item);
  if (chips.some(c => c.tone === 'blocker')) return true;
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
    'Not inspected': 0, 'Stale status': 0,
    'No price': 0, 'Fee unknown': 0,
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
  if (item.il_id != null && !item.inspected_at) {
    chips.push({ label: 'Not inspected', tone: 'warn', title: 'Inspection required before pushing to Amazon' });
  }
  // List price is a true push blocker — surface it as red.
  const priceNum = parseFloat(item.draft_list_price);
  if (item.il_id != null && (!Number.isFinite(priceNum) || priceNum <= 0)) {
    chips.push({ label: 'No price', tone: 'blocker', title: 'No list price set — required to push' });
  }
  if (item.amazon_status && item.amazon_status !== 'Active') {
    chips.push({ label: 'Stale status', tone: 'warn', title: `Local Amazon status is "${item.amazon_status}" — push will still attempt qty/price update` });
  }
  if (item.referral_fee_cents == null) {
    chips.push({ label: 'Fee unknown', tone: 'info', title: 'No cached referral fee — ROI excludes Amazon fee' });
  }
  const condSet = !!(item.condition || item.draft_condition.trim());
  if (!condSet) chips.push({ label: 'No condition', tone: 'info', title: 'Condition not set' });
  return chips;
}

function WarningChip({ chip }: { chip: Chip }) {
  const cls = chip.tone === 'blocker'
    ? 'bg-red-500/10 text-red-400 border-red-500/30'
    : chip.tone === 'warn'
      ? 'bg-amber-500/10 text-amber-400/90 border-amber-500/25'
      : 'bg-slate-900/60 text-text-tertiary/70 border-border-subtle';
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

// Channel badge — DEFAULT = MFN, AMAZON_NA = FBA. Sourced from
// merchant_listings.fulfillment_channel. Display only.
function ChannelBadge({ channel }: { channel: string | null | undefined }) {
  if (!channel) return null;
  const isFba = channel === 'AMAZON_NA';
  const label = isFba ? 'FBA' : channel === 'DEFAULT' ? 'MFN' : channel;
  const cls = isFba
    ? 'bg-sky-500/10 text-sky-400 border-sky-500/30'
    : 'bg-slate-500/10 text-slate-400 border-slate-500/30';
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
        <span className="inline-block w-12 h-1 bg-slate-800 rounded-full overflow-hidden">
          <span className={`block h-full rounded-full transition-all ${fillCls}`} style={{ width: `${progress.pct}%` }} />
        </span>
      </span>
    );
  }
  return (
    <div className="mb-3 px-3 py-2 bg-slate-800/50 rounded-lg border border-border-subtle">
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
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
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
          className={`w-12 h-5 px-1.5 bg-slate-800 rounded text-[10px] font-mono text-text-primary focus:outline-none disabled:opacity-50 border ${
            error ? 'border-red-500/60 focus:border-red-500' : 'border-blue-500/40 focus:border-blue-500'
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
      className="font-mono inline-flex items-center hover:text-text-secondary px-1 -mx-1 rounded hover:bg-slate-800/50 transition-colors"
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

function amazonAsinUrl(asin: string | null | undefined): string | null {
  const value = (asin ?? '').trim();
  return value ? `https://www.amazon.com/dp/${encodeURIComponent(value)}` : null;
}

function sellerCentralSkuUrl(sku: string | null | undefined): string | null {
  const value = (sku ?? '').trim();
  return value
    ? `https://sellercentral.amazon.com/myinventory/inventory?searchField=all&searchTerm=${encodeURIComponent(value)}`
    : null;
}

function AsinLink({ asin, className }: { asin: string | null | undefined; className?: string }) {
  const value = (asin ?? '').trim();
  const href = amazonAsinUrl(value);
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className={className}
      title={`Open ASIN on Amazon: ${value}`}
    >
      {value}
    </a>
  );
}

function MskuLink({ sku, className }: { sku: string | null | undefined; className?: string }) {
  const value = (sku ?? '').trim();
  const href = sellerCentralSkuUrl(value);
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className={className}
      title={`Open MSKU in Seller Central: ${value}`}
    >
      {value}
    </a>
  );
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
  amazonTemplates?: ShippingTemplate[] | null;
}

function ItemDetailDrawer({ item, onImageClick, onPrintLabel, onEdit, onClose, amazonTemplates }: ItemDetailDrawerProps) {
  const inBatch = isBatchItem(item);
  const progress = inBatch ? getReceiveProgress(item) : null;
  const profit   = inBatch ? calcProfit(item) : null;
  const chips    = inBatch ? chipsForBatchItem(item) : chipsForResult(item);

  // Saved-field fallback display values (prefer persisted, then drafts).
  const condDisplay = (item.condition || (inBatch ? item.draft_condition.trim() : '')) || null;
  const binDisplay  = (item.bin_location || (inBatch ? item.draft_bin.trim() : '')) || null;
  const rawTmpl     = item.merchant_shipping_group_name || (inBatch ? item.draft_shipping_template.trim() : '');
  const tmplDisplay = rawTmpl ? displayShippingTemplate(rawTmpl, amazonTemplates ?? null) : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="bg-slate-800 border-l border-border-subtle shadow-2xl w-[400px] max-w-full h-full overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start gap-3 px-4 py-3 bg-slate-800 border-b border-border-subtle">
          {item.image_url
            ? <button type="button" onClick={onImageClick} className="shrink-0 rounded overflow-hidden bg-slate-800 hover:ring-2 hover:ring-blue-500/40 transition-shadow" title="View larger">
                <img src={item.image_url} alt="" className="w-14 h-14 object-contain block" />
              </button>
            : <div className="w-14 h-14 bg-slate-700/40 rounded shrink-0 flex items-center justify-center"><Package size={18} className="text-text-tertiary/40" /></div>}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-primary leading-snug line-clamp-3" title={item.product_name ?? item.asin}>
              {item.product_name || item.asin}
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap text-[10px] text-text-tertiary">
              <AsinLink asin={item.asin} className="font-mono text-blue-400 hover:text-blue-300 hover:underline" />
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
              <span className="text-text-tertiary">ASIN</span><AsinLink asin={item.asin} className="font-mono text-text-secondary hover:text-blue-300 hover:underline" />
              {item.upc && (<><span className="text-text-tertiary">UPC</span><span className="font-mono text-text-secondary">{item.upc}</span></>)}
              <span className="text-text-tertiary">MSKU</span>
              <MskuLink sku={item.sku} className="font-mono text-text-secondary break-all hover:text-blue-300 hover:underline" />
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
              <span className="text-text-tertiary" title="Sellable units remaining in inventory — not the same as 'remaining to receive'">Unsold qty</span><span className="font-mono text-text-secondary">{item.quantity_remaining ?? '—'}</span>
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
                <span className="font-mono text-text-secondary">
                  {profit.referralCents != null ? formatCurrency(profit.referralCents) : <span className="text-text-tertiary/50 italic">not cached</span>}
                </span>
                {profit.vcfCents > 0 && (<><span className="text-text-tertiary">VCF</span><span className="font-mono text-text-secondary">{formatCurrency(profit.vcfCents)}</span></>)}
                <span className="text-text-tertiary">Net</span>
                <span className={`font-mono font-medium ${
                  !profit.hasFee ? 'text-text-secondary' : profit.netCents != null && profit.netCents > 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {profit.netCents != null ? `${!profit.hasFee ? '~' : ''}${formatCurrency(profit.netCents)}` : '—'}
                </span>
                {profit.roiPct != null && profit.hasFee && (<><span className="text-text-tertiary">ROI</span>
                  <span className={`font-mono ${profit.roiPct > 0 ? 'text-green-400/90' : 'text-red-400/90'}`}>
                    {profit.roiPct.toFixed(1)}%
                  </span></>)}
                {profit.marginPct != null && profit.hasFee && (<><span className="text-text-tertiary">Margin</span>
                  <span className="font-mono text-text-secondary">
                    {profit.marginPct.toFixed(1)}%
                  </span></>)}
              </div>
              {!profit.hasFee && (
                <p className="text-[10px] text-text-tertiary/60 italic mt-1.5">Estimate — Amazon fee not cached. ROI/margin hidden until fee is available.</p>
              )}
            </section>
          )}

          {/* Saved fields */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Saved fields</div>
            <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-3">
              <span className="text-text-tertiary">Condition</span><span className="text-text-secondary">{condDisplay ?? '—'}</span>
              <span className="text-text-tertiary">Bin</span><span className="font-mono text-text-secondary">{binDisplay ?? '—'}</span>
              <span className="text-text-tertiary">Template</span>
              {rawTmpl
                ? resolveShippingTemplate(rawTmpl, amazonTemplates ?? null)
                  ? <span className="text-text-secondary text-[10px] break-all">Template: {tmplDisplay}</span>
                  : <span className="text-text-tertiary/60 text-[10px] break-all">Stored template: {rawTmpl} <span className="opacity-70">(not synced)</span></span>
                : <span className="text-text-tertiary/40 text-[10px]">No template selected</span>
              }
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
        <div className="sticky bottom-0 px-4 py-3 bg-slate-800 border-t border-border-subtle flex items-center justify-end gap-2">
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
            className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-slate-900/40 text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
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
      className="inline-flex items-center px-1.5 h-4 rounded text-[9px] font-mono font-medium border bg-slate-900/60 text-text-tertiary border-border-subtle"
      title="UPC"
    >
      UPC {upc}
    </span>
  );
}

function OpenIssueChip({ count }: { count: number | null | undefined }) {
  const issueCount = Math.max(0, Number(count ?? 0) || 0);
  if (issueCount <= 0) return null;
  return (
    <a
      href="/incoming"
      className="inline-flex items-center px-1.5 h-4 rounded text-[9px] font-medium border bg-amber-500/10 text-amber-300 border-amber-500/30 hover:bg-amber-500/15 transition-colors"
      title="Resolve receiving issues on Incoming"
    >
      {issueCount} issue{issueCount === 1 ? '' : 's'} open → resolve on Incoming
    </a>
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
    <div className={`flex items-start gap-4 p-4 rounded-xl border transition-colors ${
      inBatch ? 'border-blue-500/30 bg-blue-500/5' : 'border-border-subtle bg-slate-800 hover:bg-bg-hover'
    }`}>
      {result.image_url
        ? (
            <button
              type="button"
              onClick={onImageClick}
              className="shrink-0 rounded-lg overflow-hidden bg-white border border-border-subtle hover:ring-2 hover:ring-blue-500/40 transition-shadow"
              title="View larger"
            >
              <img src={result.image_url} alt="" className="w-24 h-24 object-contain block p-1.5" />
            </button>
          )
        : <div className="w-24 h-24 bg-slate-700/40 rounded-lg shrink-0 flex items-center justify-center"><Package size={26} className="text-text-tertiary/40" /></div>}

      <div className="min-w-0 flex-1">
        <div className="text-base text-text-primary font-medium leading-snug line-clamp-2" title={result.product_name ?? result.asin}>
          {result.product_name || result.asin}
        </div>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <AsinLink asin={result.asin} className="text-xs font-mono text-blue-400 hover:text-blue-300 hover:underline" />
          {liveStateBadge(result.amazon_status, result.amazon_qty)}
          {result.upc && <UpcChip upc={result.upc} />}
        </div>
        <div className="mt-1">
          <MskuLink sku={result.sku} className="font-mono text-[10px] text-text-tertiary/50 truncate block hover:text-blue-300 hover:underline" />
        </div>
        {(displayCost != null || displayPrice != null) && (
          <div className="flex items-center gap-4 mt-2">
            {displayCost != null && (
              <span className="text-sm text-text-secondary tabular-nums">
                <span className="text-[10px] text-text-tertiary uppercase tracking-wide mr-1">Cost</span>
                {formatCurrency(displayCost)}
              </span>
            )}
            {displayPrice != null && (
              <span className="text-sm text-text-secondary tabular-nums">
                <span className="text-[10px] text-text-tertiary uppercase tracking-wide mr-1">List</span>
                {formatCurrency(displayPrice)}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={onShowDetail}
          className="p-2 rounded-md text-text-tertiary/60 hover:text-blue-400 hover:bg-slate-800 transition-colors"
          title="View details"
        >
          <Info size={15} />
        </button>
        <button
          onClick={onAdd}
          disabled={inBatch}
          className={`h-9 px-3.5 rounded-md text-sm font-medium border transition-colors flex items-center gap-1.5 ${
            inBatch
              ? 'border-blue-500/30 text-blue-400/60 cursor-default'
              : 'border-blue-500/50 text-blue-400 hover:bg-blue-500/10'
          }`}
        >
          {inBatch ? <CheckCircle2 size={14} /> : <Plus size={14} />}
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
    savedQty:      item.quantity_received ?? (parseInt(item.draft_qty, 10) || null),
    savedPrice:    item.il_list_price_cents
      ?? (item.draft_list_price ? Math.round(parseFloat(item.draft_list_price) * 100) : null),
    savedCogs:     item.buy_price
      ?? (item.draft_buy_price ? Math.round(parseFloat(item.draft_buy_price) * 100) : null),
    savedBin:      item.bin_location || item.draft_bin.trim() || null,
    savedCond:     item.condition    || item.draft_condition.trim() || null,
    savedTemplate: item.merchant_shipping_group_name || item.draft_shipping_template.trim() || null,
  };
}

function openIncomingCandidates(item: BatchItem): IncomingPurchaseCandidate[] {
  return Array.isArray(item.open_incoming_purchases)
    ? item.open_incoming_purchases.filter(candidate => {
        const quantity = Number(candidate.quantity) || 0;
        const received = Number(candidate.quantity_received) || 0;
        return candidate.status === 'on_order' || candidate.status === 'partial'
          ? quantity > received
          : false;
      })
    : [];
}

function selectedIncomingCandidate(item: BatchItem): IncomingPurchaseCandidate | null {
  if (typeof item.incoming_receive_choice !== 'number') return null;
  return openIncomingCandidates(item).find(candidate => candidate.id === item.incoming_receive_choice) ?? null;
}

function mfnReceiptKey(item: BatchItem, candidate: IncomingPurchaseCandidate, quantity: number, batchId: number | null): string {
  return [
    'mfn-batch-receive',
    candidate.id,
    item.sku,
    batchId ?? 'standalone',
    quantity,
    candidate.quantity_received,
  ].join(':');
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
  amazonTemplates: ShippingTemplate[] | null;
  locked?: boolean;
}

function BatchItemRow({ item, onRemove, onPrintLabel, onEdit, onSaveQty, onImageClick, onShowDetail, focusQty, onQtyFocused, locked = false }: BatchItemRowProps) {
  const { savedQty, savedPrice, savedCogs } = getSavedDisplay(item);
  const receiveProgress = getReceiveProgress(item);

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border-subtle border-l-2 border-l-green-500/40">

      {/* Zone 1 — image */}
      {item.image_url
        ? (
            <button type="button" onClick={onImageClick}
              className="shrink-0 rounded-lg overflow-hidden bg-white border border-border-subtle hover:ring-2 hover:ring-blue-500/40 transition-shadow"
              title="View larger">
              <img src={item.image_url} alt="" className="w-20 h-20 object-contain block p-1.5" />
            </button>
          )
        : <div className="w-20 h-20 bg-slate-700/40 rounded-lg shrink-0 flex items-center justify-center"><Package size={22} className="text-text-tertiary/40" /></div>}

      {/* Zone 2 — product identity (flex-1, truncates): name + ASIN + MSKU + channel */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 size={15} className="text-green-400 shrink-0" />
          <span className="text-base font-medium text-text-primary truncate" title={item.product_name ?? item.asin}>
            {item.product_name || item.asin}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <AsinLink asin={item.asin} className="font-mono text-sm text-blue-400/80 shrink-0 hover:text-blue-300 hover:underline" />
          <ChannelBadge channel={item.fulfillment_channel} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <MskuLink sku={item.sku} className="font-mono text-xs text-blue-400/80 truncate hover:text-blue-300 hover:underline" />
          <PrintLabelIcon
            item={{ title: item.product_name, asin: item.asin, sku: item.sku, bin: item.draft_bin, condition: item.draft_condition }}
            qty={Math.max(1, parseInt(item.draft_qty, 10) || 1)}
          />
          <OpenIssueChip count={item.open_issue_count} />
          {item.incoming_reconcile_warning && (
            <span className="inline-flex items-center px-1.5 h-4 rounded text-[9px] font-medium border bg-amber-500/10 text-amber-300 border-amber-500/30" title={item.incoming_reconcile_warning}>
              Airtable sync failed
            </span>
          )}
        </div>
      </div>

      {/* Zone 4 — Qty (w-32 fixed): InlineQtyEdit + optional receive progress */}
      <div className="w-32 shrink-0 flex flex-col items-start gap-0.5 overflow-hidden">
        {locked
          ? <span className="font-mono text-base text-text-primary px-1">{savedQty}</span>
          : <InlineQtyEdit value={savedQty} onSave={onSaveQty} forceOpen={focusQty} onOpened={onQtyFocused} />}
        {receiveProgress && <ReceiveProgressBar progress={receiveProgress} variant="compact" />}
      </div>

      {/* Zone 5 — COGS (w-20 right): buy price per unit, to verify the import */}
      <div className="w-20 shrink-0 text-right">
        {savedCogs != null
          ? <span className="font-mono text-base text-text-secondary">{formatCurrency(savedCogs)}</span>
          : <span className="text-text-tertiary/30">—</span>}
      </div>

      {/* Zone 6 — List price (w-20 right) */}
      <div className="w-20 shrink-0 text-right">
        {savedPrice != null
          ? <span className="font-mono text-base text-text-primary">{formatCurrency(savedPrice)}</span>
          : <span className="text-text-tertiary/30">—</span>}
      </div>

      {/* Zone 7 — Actions (w-24 fixed, right-aligned) */}
      <div className="w-24 shrink-0 flex items-center justify-end">
        <button onClick={onShowDetail} className="p-1 text-text-tertiary/60 hover:text-blue-400 rounded transition-colors" title="View details"><Info size={13} /></button>
        <button onClick={onPrintLabel} className="p-1 text-text-tertiary/60 hover:text-blue-400 rounded transition-colors" title="Print ASIN label"><Printer size={13} /></button>
        {!locked && <button onClick={onEdit} className="p-1 text-text-tertiary/60 hover:text-blue-400 rounded transition-colors" title="Edit (reopens this card)"><Pencil size={13} /></button>}
        {!locked && <button onClick={onRemove} className="p-1 text-text-tertiary/40 hover:text-text-tertiary rounded" title="Remove"><X size={13} /></button>}
      </div>
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
  amazonTemplates: ShippingTemplate[] | null;
  locked?: boolean;
}

function BatchItemCard({ item, onChange, onRemove, onSave, onCreateLot, onPrintLabel, onEdit, onSaveQty, onMarkInspected, onImageClick, onShowDetail, focusQty, onQtyFocused, amazonTemplates, locked = false }: BatchItemCardProps) {
  const noLot = item.il_id == null;
  const profit = calcProfit(item);
  const incomingCandidates = openIncomingCandidates(item);

  const qtyRef              = useRef<HTMLInputElement>(null);
  const listPriceRef        = useRef<HTMLInputElement>(null);
  const conditionRef        = useRef<HTMLSelectElement>(null);
  const buyCostRef          = useRef<HTMLInputElement>(null);
  const binRef              = useRef<HTMLInputElement>(null);
  const shippingEstRef      = useRef<HTMLInputElement>(null);
  const shippingTemplateRef = useRef<HTMLSelectElement>(null);
  const primaryActionRef    = useRef<HTMLButtonElement>(null);
  const [issueExpanded, setIssueExpanded] = useState(false);
  const [issueQty, setIssueQty] = useState('1');
  const [issueType, setIssueType] = useState<IssueType>('damaged');
  const [issueNote, setIssueNote] = useState('');
  const [issueState, setIssueState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [issueError, setIssueError] = useState<string | null>(null);
  const [slowIssue, setSlowIssue] = useState(false);

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
        amazonTemplates={amazonTemplates}
        locked={locked}
      />
    );
  }

  const borderClass = item.save_state === 'error'
    ? 'border-red-500/30 bg-red-500/5'
    : noLot
      ? 'border-border-subtle bg-slate-800 border-l-2 border-l-sky-500/30'
      : 'border-border-subtle bg-slate-800';

  async function logIssue() {
    if (item.il_id == null) return;
    const qty = parseInt(issueQty, 10);
    if (!Number.isInteger(qty) || qty < 1) {
      setIssueState('error');
      setIssueError('Issue qty must be at least 1');
      return;
    }

    // Expected-state guard: the server rejects the request if the lot changed
    // since load (e.g. a retry after a lost response), so a double-submit can
    // never shrink the lot twice.
    const expectedLotQuantity = Number(item.lot_quantity);
    if (!Number.isInteger(expectedLotQuantity)) {
      setIssueState('error');
      setIssueError('Lot quantity not loaded — refresh the page and try again');
      return;
    }

    const body: Record<string, unknown> = {
      ilId: item.il_id,
      quantity: qty,
      issueType,
      expectedLotQuantity,
    };
    if (issueNote.trim()) body.note = issueNote.trim();

    setIssueState('saving');
    setIssueError(null);
    setSlowIssue(false);
    const slowTimer = setTimeout(() => setSlowIssue(true), 3000);

    try {
      const res = await fetch('/api/data/inventory-lots/report-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const bodyText = await res.text().catch(() => '');
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(bodyText) as Record<string, unknown>; } catch { /* keep empty */ }

      if (!res.ok) {
        const errMsg = (data.error as string | undefined) || 'Issue log failed';
        setIssueState('error');
        setIssueError(`${errMsg} (HTTP ${res.status})`);
        return;
      }

      const newLotQuantity = data.lotQuantity != null ? Number(data.lotQuantity) : item.lot_quantity;
      const mirror: Partial<BatchItem> = {
        lot_quantity: newLotQuantity,
        quantity_remaining: data.lotQuantityRemaining != null ? Number(data.lotQuantityRemaining) : item.quantity_remaining,
        open_issue_count: Math.max(0, Number(item.open_issue_count ?? 0) || 0) + 1,
      };
      // Clamp the receive-qty draft to the shrunk lot so the next Save can't
      // trip the "received exceeds purchased" guard.
      const draftQty = parseInt(item.draft_qty, 10);
      if (newLotQuantity != null && Number.isInteger(draftQty) && draftQty > newLotQuantity) {
        mirror.draft_qty = String(newLotQuantity);
        mirror.save_state = 'idle';
      }
      onChange(mirror);
      setIssueExpanded(false);
      setIssueQty('1');
      setIssueNote('');
      setIssueState('idle');
      setIssueError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setIssueState('error');
      setIssueError(`Network error: ${msg}`);
    } finally {
      clearTimeout(slowTimer);
      setSlowIssue(false);
    }
  }

  return (
    <div className={`rounded-xl border p-4 transition-colors ${borderClass}`}>

      {/* Header */}
      <div className="flex items-start gap-4 mb-3">
        {item.image_url
          ? (
              <button
                type="button"
                onClick={onImageClick}
                className="shrink-0 rounded-lg overflow-hidden bg-white border border-border-subtle hover:ring-2 hover:ring-blue-500/40 transition-shadow"
                title="View larger"
              >
                <img src={item.image_url} alt="" className="w-28 h-28 object-contain block p-1.5" />
              </button>
            )
          : <div className="w-28 h-28 bg-slate-700/40 rounded-lg shrink-0 flex items-center justify-center"><Package size={28} className="text-text-tertiary/40" /></div>}

        <div className="min-w-0 flex-1">
          <div className="text-base font-medium text-text-primary leading-snug line-clamp-2" title={item.product_name ?? item.asin}>
            {item.product_name || item.asin}
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <AsinLink asin={item.asin} className="text-xs font-mono text-blue-400 hover:text-blue-300 hover:underline" />
            {liveStateBadge(item.amazon_status, item.amazon_qty)}
            <ChannelBadge channel={item.fulfillment_channel} />
            {item.amazon_qty != null && (
              <span className="text-[10px] text-text-tertiary">Amz qty: {item.amazon_qty}</span>
            )}
            {item.upc && <UpcChip upc={item.upc} />}
            <OpenIssueChip count={item.open_issue_count} />
          </div>
          {(() => {
            const blockers = chipsForBatchItem(item).filter(c => c.tone === 'blocker');
            return blockers.length > 0 ? (
              <div className="flex items-center gap-1 mt-1 flex-wrap">
                <BatchItemChips chips={blockers} />
              </div>
            ) : null;
          })()}
        </div>

        {noLot ? (
          <button
            ref={primaryActionRef}
            onClick={onCreateLot}
            disabled={item.create_lot_state === 'creating'}
            className="shrink-0 h-8 px-3 flex items-center gap-1.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-60"
          >
            {item.create_lot_state === 'creating'
              ? <><Loader2 size={11} className="animate-spin" /> Saving…</>
              : <><PackagePlus size={11} /> Save item</>}
          </button>
        ) : (
          <button
            ref={primaryActionRef}
            onClick={onSave}
            disabled={item.save_state === 'saving'}
            className="shrink-0 h-8 px-3 flex items-center gap-1.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-60"
          >
            {item.save_state === 'saving'
              ? <><Loader2 size={11} className="animate-spin" /> Saving…</>
              : <><Save size={11} /> Save changes</>}
          </button>
        )}
        <button
          onClick={onShowDetail}
          className="shrink-0 p-1 text-text-tertiary/60 hover:text-blue-400 rounded transition-colors"
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

      {/* Profit strip */}
      {profit.listCents != null && profit.costCents != null && (
        <div className="mb-2 px-2.5 py-1.5 bg-slate-900/40 rounded-lg border border-border-subtle">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-baseline gap-2">
              <span className={`text-sm font-semibold tabular-nums ${
                !profit.hasFee
                  ? 'text-text-secondary'
                  : profit.netCents != null && profit.netCents > 0 ? 'text-green-400' : 'text-red-400'
              }`}>
                {profit.netCents != null ? `${!profit.hasFee ? '~' : ''}${formatCurrency(profit.netCents)}` : '—'}
              </span>
              {profit.roiPct != null && profit.hasFee && (
                <span className={`text-xs font-medium ${profit.roiPct > 0 ? 'text-green-400/80' : 'text-red-400/80'}`}>
                  {profit.roiPct.toFixed(1)}% ROI
                </span>
              )}
              {profit.marginPct != null && profit.hasFee && (
                <span className={`text-[10px] ${profit.marginPct > 0 ? 'text-text-tertiary' : 'text-red-400/70'}`}>
                  {profit.marginPct.toFixed(1)}% margin
                </span>
              )}
            </div>
            {!profit.hasFee && (
              <span className="text-[10px] text-text-tertiary/60 italic">Estimate — fee not cached</span>
            )}
          </div>
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
              <span className="text-text-tertiary/50 italic">Amazon fee not cached</span>
            )}
          </div>
        </div>
      )}

      {/* Receive progress — only when there's a lot AND a usable total signal */}
      {(() => { const p = getReceiveProgress(item); return p ? <ReceiveProgressBar progress={p} variant="full" /> : null; })()}

      {incomingCandidates.length > 0 && (
        <div className="mb-3 rounded-md border border-amber-500/25 bg-amber-500/5 px-2.5 py-2">
          <div className="flex items-center gap-1.5 mb-1.5">
            <AlertCircle size={12} className="text-amber-300 shrink-0" />
            <span className="text-[11px] font-medium text-amber-200">Open buy-sheet order</span>
            <span className="text-[10px] text-text-tertiary">Choose one to link, or keep this as a new lot.</span>
          </div>
          <div className="space-y-1">
            {incomingCandidates.map(candidate => {
              const remaining = Math.max(0, Number(candidate.quantity) - Number(candidate.quantity_received));
              const label = [
                candidate.ordered_at ? candidate.ordered_at.slice(0, 10) : 'No date',
                `${remaining}/${candidate.quantity} open`,
                formatCurrency(Number(candidate.unit_cost_cents) || 0),
                candidate.order_source || candidate.order_ref || null,
              ].filter(Boolean).join(' · ');
              return (
                <label key={candidate.id} className="flex items-center gap-2 text-[11px] text-text-secondary">
                  <input
                    type="radio"
                    name={`incoming-${item.sku}`}
                    checked={item.incoming_receive_choice === candidate.id}
                    onChange={() => onChange({ incoming_receive_choice: candidate.id, save_state: 'idle', create_lot_error: null, save_error: null })}
                    className="accent-amber-400"
                  />
                  <span>{label}</span>
                </label>
              );
            })}
            <label className="flex items-center gap-2 text-[11px] text-text-secondary">
              <input
                type="radio"
                name={`incoming-${item.sku}`}
                checked={item.incoming_receive_choice === 'new'}
                onChange={() => onChange({ incoming_receive_choice: 'new', save_state: 'idle', create_lot_error: null, save_error: null })}
                className="accent-amber-400"
              />
              <span>Receive as new lot</span>
            </label>
          </div>
        </div>
      )}

      {/* Mark inspected — only when received but not yet inspected */}
      {item.il_id != null && (item.quantity_received ?? 0) > 0 && !item.inspected_at && (
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={onMarkInspected}
            disabled={item.marking_inspected}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-50"
            title="Marks this item inspected. Does not update Amazon."
          >
            {item.marking_inspected
              ? <Loader2 size={11} className="animate-spin" />
              : <CheckCircle2 size={11} />}
            Mark inspected
          </button>
          <span className="text-[10px] text-text-tertiary/50">Does not update Amazon</span>
          {item.mark_inspect_error && (
            <span className="text-[10px] text-red-400">{item.mark_inspect_error}</span>
          )}
        </div>
      )}

      {/* Input grid — keyboard flow: Qty → List Price → Condition → Buy Cost (noLot) or Bin → Bin → Est. Shipping → Template → Save
          Row 1: Qty | List Price | Condition
          Row 2: Buy Cost | Bin | Est. Shipping
          Below: Shipping Template (full width) */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1.5 uppercase tracking-wide">Qty Received</label>
          <input
            ref={qtyRef}
            type="number" min="0" step="1"
            value={item.draft_qty}
            onChange={e => onChange({ draft_qty: e.target.value, save_state: 'idle' })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); listPriceRef.current?.focus(); } }}
            className="w-full h-9 px-3 bg-slate-800 border border-border-default rounded-md text-sm font-mono text-text-primary focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1.5 uppercase tracking-wide">List Price ($)</label>
          <input
            ref={listPriceRef}
            type="number" min="0" step="0.01"
            value={item.draft_list_price}
            onChange={e => onChange({ draft_list_price: e.target.value, save_state: 'idle' })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); conditionRef.current?.focus(); } }}
            placeholder="0.00"
            className="w-full h-9 px-3 bg-slate-800 border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1.5 uppercase tracking-wide">Condition</label>
          <select
            ref={conditionRef}
            value={item.draft_condition}
            onChange={e => { rememberStickyDefault(STICKY_CONDITION_KEY, e.target.value); onChange({ draft_condition: e.target.value, save_state: 'idle' }); }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); noLot ? buyCostRef.current?.focus() : binRef.current?.focus(); } }}
            className="w-full h-9 px-2.5 bg-slate-800 border border-border-default rounded-md text-sm text-text-primary focus:border-blue-500 focus:outline-none"
          >
            <option value="">— select —</option>
            {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-text-tertiary/50 mb-1.5 uppercase tracking-wide">
            {noLot ? 'Buy Cost ($)' : 'Buy Cost (locked)'}
          </label>
          <input
            ref={buyCostRef}
            type="number" min="0" step="0.01"
            value={item.draft_buy_price}
            onChange={e => noLot ? onChange({ draft_buy_price: e.target.value }) : undefined}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); binRef.current?.focus(); } }}
            readOnly={!noLot}
            tabIndex={noLot ? 0 : -1}
            placeholder="0.00"
            className={`w-full h-9 px-3 rounded-md text-sm font-mono placeholder:text-text-tertiary focus:outline-none ${
              noLot
                ? 'bg-slate-800 border border-border-default text-text-primary focus:border-blue-500'
                : 'bg-slate-800/40 border border-border-subtle text-text-tertiary cursor-default'
            }`}
          />
        </div>
        <div>
          <label className="block text-[11px] text-text-tertiary/50 mb-1.5 uppercase tracking-wide">Bin <span className="normal-case font-normal opacity-60">(optional)</span></label>
          <input
            ref={binRef}
            type="text"
            value={item.draft_bin}
            onChange={e => onChange({ draft_bin: e.target.value, save_state: 'idle' })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); shippingEstRef.current?.focus(); } }}
            placeholder="e.g. S1-B3"
            className="w-full h-9 px-3 bg-slate-800 border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[11px] text-text-tertiary/50 mb-1.5 uppercase tracking-wide">Est. Shipping ($)</label>
          <input
            ref={shippingEstRef}
            type="number" min="0" step="0.01"
            value={item.draft_shipping_est}
            onChange={e => onChange({ draft_shipping_est: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); shippingTemplateRef.current?.focus(); } }}
            placeholder="8.00"
            className="w-full h-9 px-3 bg-slate-800 border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>

      {item.il_id != null && (
        <div className="mb-3">
          {!issueExpanded ? (
            <button
              type="button"
              onClick={() => {
                setIssueExpanded(true);
                setIssueState('idle');
                setIssueError(null);
              }}
              className="text-[11px] text-amber-300/80 hover:text-amber-200 transition-colors"
            >
              Report issue…
            </button>
          ) : (
            <div className="flex items-end gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 flex-wrap">
              <div className="w-20">
                <label className="block text-[10px] text-text-tertiary/60 mb-1 uppercase tracking-wide">Issue qty</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={issueQty}
                  onChange={e => {
                    setIssueQty(e.target.value);
                    setIssueState('idle');
                    setIssueError(null);
                  }}
                  className="w-full h-8 px-2 bg-slate-800 border border-border-default rounded-md text-xs font-mono text-text-primary focus:border-amber-500 focus:outline-none"
                />
              </div>
              <div className="w-40">
                <label className="block text-[10px] text-text-tertiary/60 mb-1 uppercase tracking-wide">Issue type</label>
                <select
                  value={issueType}
                  onChange={e => setIssueType(e.target.value as IssueType)}
                  className="w-full h-8 px-2 bg-slate-800 border border-border-default rounded-md text-xs text-text-primary focus:border-amber-500 focus:outline-none"
                >
                  {ISSUE_TYPE_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="block text-[10px] text-text-tertiary/60 mb-1 uppercase tracking-wide">Note</label>
                <input
                  value={issueNote}
                  onChange={e => setIssueNote(e.target.value)}
                  placeholder="e.g. return started on eBay"
                  className="w-full h-8 px-2 bg-slate-800 border border-border-default rounded-md text-xs text-text-primary placeholder:text-text-tertiary/60 focus:border-amber-500 focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={logIssue}
                disabled={issueState === 'saving'}
                className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md text-xs font-semibold bg-amber-500/15 text-amber-200 border border-amber-500/30 hover:bg-amber-500/20 transition-colors disabled:opacity-60"
              >
                {issueState === 'saving' ? <><Loader2 size={11} className="animate-spin" /> Logging…</> : 'Log issue'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setIssueExpanded(false);
                  setIssueState('idle');
                  setIssueError(null);
                }}
                className="h-8 px-2 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
              >
                Cancel
              </button>
              {issueState === 'error' && (
                <div className="basis-full text-[10px] text-red-400">{issueError || 'Issue log failed'}</div>
              )}
              {issueState === 'saving' && slowIssue && (
                <div className="basis-full text-[10px] text-text-tertiary italic">Still working — logging issue…</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mb-2">
        <label className="block text-[10px] text-text-tertiary/50 mb-1 uppercase tracking-wide">Shipping Template</label>
        {amazonTemplates === null ? (
          <div className="w-full h-8 px-2.5 bg-slate-800 border border-border-default rounded-md text-xs text-text-tertiary flex items-center">
            Syncing Amazon templates…
          </div>
        ) : amazonTemplates.length === 0 ? (
          <div className="w-full h-8 px-2.5 bg-slate-800 border border-border-default rounded-md text-xs text-text-tertiary flex items-center">
            No templates found — sync in Settings
          </div>
        ) : (
          <select
            ref={shippingTemplateRef}
            value={resolveShippingTemplate(item.draft_shipping_template, amazonTemplates)?.key ?? item.draft_shipping_template}
            onChange={e => { rememberStickyDefault(STICKY_TEMPLATE_KEY, e.target.value); onChange({ draft_shipping_template: e.target.value, save_state: 'idle' }); }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); primaryActionRef.current?.click(); } }}
            className="w-full h-8 px-2.5 bg-slate-800 border border-border-default rounded-md text-xs font-mono text-text-primary focus:border-blue-500 focus:outline-none appearance-none cursor-pointer"
          >
            <option value="">Select template…</option>
            {/* Unknown stored values (old display names not in Amazon list) surface as a selectable option so nothing looks blank */}
            {item.draft_shipping_template && !resolveShippingTemplate(item.draft_shipping_template, amazonTemplates) && (
              <option value={item.draft_shipping_template}>Stored: {item.draft_shipping_template} (not synced)</option>
            )}
            {amazonTemplates.map(t => (
              <option key={t.key} value={t.key}>{t.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Error / slow-save status */}
      {(item.save_state === 'error' || item.create_lot_state === 'error') && (
        <p className="text-[10px] text-red-400 mt-1">
          {item.save_state === 'error' ? (item.save_error || 'Save failed') : (item.create_lot_error || 'Create failed')}
        </p>
      )}
      {item.auto_print_error && (
        <p className="text-[10px] text-amber-400/90 mt-1">
          Label print failed: {item.auto_print_error} — use the print icon to retry.
          <button
            type="button"
            onClick={() => onChange({ auto_print_error: null })}
            className="ml-1.5 text-text-tertiary hover:text-text-secondary underline"
          >
            dismiss
          </button>
        </p>
      )}
      {item.incoming_reconcile_warning && (
        <p className="text-[10px] text-amber-400/90 mt-1">
          {item.incoming_reconcile_warning}
          <button
            type="button"
            onClick={() => onChange({ incoming_reconcile_warning: null })}
            className="ml-1.5 text-text-tertiary hover:text-text-secondary underline"
          >
            dismiss
          </button>
        </p>
      )}
      {item.create_lot_state === 'creating' && item.slow_create_lot && (
        <p className="text-[10px] text-text-tertiary italic mt-1 text-center">Still saving…</p>
      )}
      {item.save_state === 'saving' && item.slow_save && (
        <p className="text-[10px] text-text-tertiary italic mt-1 text-center">Still working — saving…</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

/**
 * Reusable MFN receive workflow. Mounts at both /mfn/batch (standalone,
 * batchId=null) and inside /list/[id] for MFN-channel batches (batchId set
 * from the URL param).
 *
 * When batchId is null (standalone): exactly the legacy /mfn/batch behavior.
 * Tray is React-state-only; refresh loses unsaved items; saved lots persist
 * with batch_id = NULL.
 *
 * When batchId is a positive integer: every create-mfn-local-lot POST includes
 * batchId so the inserted (or claimed) inventory_ledger row carries it; on
 * mount, the tray hydrates from /api/data/mfn-batch-items?batchId=N so a
 * refresh returns the saved items.
 *
 * Setting batch_id never touches buy_price, quantity, quantity_remaining, or
 * date_purchased on any lot — FIFO is unaffected.
 */
export interface MfnBatchReceiveWorkflowProps {
  batchId?: number | null;
  /** When true the batch is closed/in History: read-only, no add/edit/push. */
  locked?: boolean;
}

export default function MfnBatchReceiveWorkflow({ batchId = null, locked = false }: MfnBatchReceiveWorkflowProps = {}) {
  const searchInputRef     = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  // SKUs whose received count has been driven by scanning this session. Lets a
  // re-scan increment the running draft count instead of re-reading the
  // (possibly pre-seeded) expected quantity.
  const scanTouchedRef     = useRef<Set<string>>(new Set());
  const multiMatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery]           = useState('');
  const [results, setResults]       = useState<SearchResult[]>([]);
  const [searching, setSearching]   = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [multiMatchNote, setMultiMatchNote] = useState(false);
  const [batch, setBatch]           = useState<Map<string, BatchItem>>(new Map());
  // Ref, not state: the sticky bin default is never rendered, and async save
  // completions must always read/advance the LATEST value — a render-closure
  // capture goes stale under overlapping saves (review finding on 2d5284a:
  // save A→B and B→C in flight together left auto-painted rows stuck on B).
  const sessionBinDefaultRef = useRef('');
  // Auto-print ASIN stickers on save. Initialized false and hydrated from
  // localStorage in an effect (avoids an SSR hydration mismatch). Printed
  // SKUs are tracked per screen session so a re-save never burns a second
  // sticker; the per-card print icon stays the reprint path.
  const [autoPrintLabels, setAutoPrintLabels] = useState(false);
  const autoPrintedSkusRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    setAutoPrintLabels(stickyDefault(STICKY_AUTOPRINT_KEY, '0') === '1');
  }, []);
  function toggleAutoPrintLabels() {
    setAutoPrintLabels(prev => {
      rememberStickyDefault(STICKY_AUTOPRINT_KEY, prev ? '0' : '1');
      return !prev;
    });
  }
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
  const [amazonTemplates, setAmazonTemplates] = useState<ShippingTemplate[] | null>(null);
  const [backfillingImages, setBackfillingImages] = useState(false);
  const [backfillProgress, setBackfillProgress]   = useState<{ done: number; remaining: number } | null>(null);

  // Fetch missing product images for this batch's ASINs from the catalog, then
  // merge the fresh image_url onto the items already in the tray.
  async function handleBackfillImages() {
    if (batchId == null || batchId <= 0) return;
    setBackfillingImages(true);
    setBackfillProgress(null);
    let done = 0;
    try {
      for (let i = 0; i < 200; i++) {
        const res = await fetch('/api/data/mfn-batch-items/backfill-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchId, limit: 100 }),
        });
        const data = await res.json();
        if (!res.ok) break;
        done += data.updated ?? 0;
        setBackfillProgress({ done, remaining: data.remaining ?? 0 });
        if ((data.remaining ?? 0) <= 0 || (data.processed ?? 0) === 0) break;
      }
      // Re-pull items and merge the new images onto existing tray rows.
      const refetch = await fetch(`/api/data/mfn-batch-items?batchId=${batchId}`);
      if (refetch.ok) {
        const d = await refetch.json();
        const rows: SearchResult[] = Array.isArray(d.items) ? d.items : [];
        const bySku = new Map(rows.map(r => [r.sku, r]));
        setBatch(prev => {
          const next = new Map(prev);
          for (const [sku, item] of next) {
            const fresh = bySku.get(sku);
            if (fresh?.image_url && fresh.image_url !== item.image_url) {
              next.set(sku, { ...item, image_url: fresh.image_url });
            }
          }
          return next;
        });
      }
    } catch {
      /* network error — stop the loop */
    } finally {
      setBackfillingImages(false);
    }
  }

  // Auto-focus search on mount
  useEffect(() => { searchInputRef.current?.focus(); }, []);

  // Fetch Amazon shipping templates once on mount (cached 24h server-side)
  useEffect(() => {
    fetch('/api/sync/shipping-templates')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => setAmazonTemplates(Array.isArray(d.templates) ? d.templates : []))
      .catch(() => setAmazonTemplates([]));
  }, []);

  // Hydration: when mounted inside a persisted batch (batchId set), pull saved
  // lots tagged with this batch_id and seed the tray as `saved` items. Without
  // this, refreshing /list/<mfn-batch-id> would show an empty tray even though
  // lots persist. Standalone /mfn/batch (batchId == null) skips this — its
  // tray is intentionally session-only.
  useEffect(() => {
    if (batchId == null || batchId <= 0) return;
    let cancelled = false;
    fetch(`/api/data/mfn-batch-items?batchId=${batchId}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => {
        if (cancelled) return;
        const rows: SearchResult[] = Array.isArray(d.items) ? d.items : [];
        if (rows.length === 0) return;
        setBatch(prev => {
          const next = new Map(prev);
          for (const r of rows) {
            if (next.has(r.sku)) continue; // never overwrite an in-flight draft
            const item = makeBatchItem(r);
            item.save_state = 'saved';
            next.set(r.sku, item);
          }
          return next;
        });
      })
      .catch(err => console.error('[mfn-batch] hydration failed', err));
    return () => { cancelled = true; };
  }, [batchId]);

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

  // Scanner race protection: a barcode scanner sends Enter in the same
  // instant as the last character, before the debounced search returns — so
  // Enter must never act on results from a PREVIOUS query (that silently
  // +1'd the prior item). Track which query the results belong to, and let a
  // premature Enter become a pending action that fires when results land.
  const resultsQueryRef = useRef('');
  const pendingEnterRef = useRef<string | null>(null);
  const scanReceiveRef = useRef<(r: SearchResult) => void>(() => {});

  // Debounced search
  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) { setResults([]); resultsQueryRef.current = ''; return; }
    setSearching(true);
    try {
      const res = await fetch(`/api/data/mfn-search?q=${encodeURIComponent(trimmed)}`);
      const data = await res.json();
      const list = data.results || [];
      setResults(list);
      resultsQueryRef.current = trimmed;
      if (pendingEnterRef.current === trimmed) {
        pendingEnterRef.current = null;
        if (list.length === 1) {
          scanReceiveRef.current(list[0]);
        } else if (list.length > 1) {
          if (multiMatchTimerRef.current) clearTimeout(multiMatchTimerRef.current);
          setMultiMatchNote(true);
          multiMatchTimerRef.current = setTimeout(() => setMultiMatchNote(false), 2000);
        }
      }
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
      next.set(result.sku, applySessionBinDefault(makeBatchItem(result)));
      return next;
    });
    setReceiveFilter('all');
    if (focusOnAdd) setFocusQtySku(result.sku);
  }

  // Scan-to-receive: each scan of an item adds 1 to its received count and
  // KEEPS THE CURSOR IN THE SEARCH BAR, so the scanner's next barcode lands
  // here and never in a row's quantity field. The count is updated locally
  // (no per-scan API call — that would re-run FIFO on every scan); it persists
  // on Save like any other edit.
  function scanReceive(result: SearchResult) {
    setReceiveFilter('all');
    const sku = result.sku;
    const existing = batch.get(sku);
    // First scan of a SKU this session counts from what's actually received;
    // subsequent scans increment the running draft count.
    const touched = scanTouchedRef.current.has(sku);
    const base = touched
      ? (parseInt(existing?.draft_qty ?? '0', 10) || 0)
      : (existing?.quantity_received ?? 0);
    const nextQty = base + 1;
    scanTouchedRef.current.add(sku);

    if (existing) {
      updateBatchItem(sku, { draft_qty: String(nextQty), save_state: 'idle' });
    } else {
      const seeded: BatchItem = applySessionBinDefault({ ...makeBatchItem(result), draft_qty: String(nextQty), save_state: 'idle' });
      setBatch(prev => {
        if (prev.has(sku)) return prev;
        const next = new Map(prev);
        next.set(sku, seeded);
        return next;
      });
    }

    setQuery('');
    setResults([]);
    resultsQueryRef.current = '';
    // Keep scanning anchored to the search bar.
    searchInputRef.current?.focus();
  }
  scanReceiveRef.current = scanReceive;

  function updateBatchItem(sku: string, updates: Partial<BatchItem>) {
    setBatch(prev => {
      const item = prev.get(sku);
      if (!item) return prev;
      const next = new Map(prev);
      next.set(sku, { ...item, ...updates });
      return next;
    });
  }

  function applySessionBinDefault(item: BatchItem): BatchItem {
    const sessionBinDefault = sessionBinDefaultRef.current;
    if (!sessionBinDefault) return item;
    if (item.draft_bin.trim() || (item.bin_location ?? '').trim()) return item;
    return { ...item, draft_bin: sessionBinDefault };
  }

  function applySuccessfulSaveMirror(sku: string, mirror: Partial<BatchItem>, savedBin: string) {
    // Read + advance the ref atomically at completion time: rows still holding
    // this value were auto-painted by an earlier save and follow the new bin.
    const previousBinDefault = sessionBinDefaultRef.current;
    if (savedBin) sessionBinDefaultRef.current = savedBin;
    setBatch(prev => {
      const current = prev.get(sku);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(sku, { ...current, ...mirror });
      if (savedBin) {
        for (const [otherSku, other] of next) {
          if (otherSku === sku) continue;
          // Skip saved AND in-flight items: a parallel Save All must not
          // paint a bin onto a row whose PATCH already left without one.
          if (other.save_state === 'saved' || other.save_state === 'saving') continue;
          if ((other.bin_location ?? '').trim()) continue;
          const otherBin = other.draft_bin.trim();
          // Repaint rows that are empty OR still carry the previous sticky
          // default (i.e. were auto-painted, not hand-edited). A bin the
          // operator typed themselves (≠ previous default) is never touched —
          // so moving to a new shelf mid-batch updates the whole queue, but
          // deliberate per-item bins survive.
          if (otherBin && otherBin !== previousBinDefault) continue;
          if (otherBin === savedBin) continue;
          next.set(otherSku, { ...other, draft_bin: savedBin });
        }
      }
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

  function receiveChoiceError(item: BatchItem): string | null {
    const candidates = openIncomingCandidates(item);
    if (candidates.length === 0) return null;
    return item.incoming_receive_choice == null
      ? 'Choose an open buy-sheet order to link, or choose receive as new lot.'
      : null;
  }

  async function reconcileExistingLotFromChoice(item: BatchItem, qtyNum: number): Promise<{ ok: boolean; warning?: string; error?: string }> {
    if (item.il_id == null) return { ok: false, error: 'Save this item before reconciling an incoming order' };
    const candidate = selectedIncomingCandidate(item);
    if (!candidate) return { ok: true };
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
      return { ok: false, error: 'Qty received must be a positive whole number when linking an incoming order' };
    }
    const receiptKey = mfnReceiptKey(item, candidate, qtyNum, batchId);
    const res = await fetch(`/api/incoming/${candidate.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'reconcile',
        receiptKey,
        expectedQuantityReceived: candidate.quantity_received,
        inventoryLedgerId: item.il_id,
        quantity: qtyNum,
        confirmMismatch: true,
      }),
    });
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) {
      return { ok: false, error: String(data.error || `Incoming reconcile failed (HTTP ${res.status})`) };
    }

    if (candidate.ordered_at) {
      const dateRes = await fetch('/api/data/inventory-lots', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.il_id, datePurchased: candidate.ordered_at }),
      });
      if (!dateRes.ok) {
        const text = await dateRes.text().catch(() => '');
        let errMsg = 'Purchase date update failed';
        try { errMsg = JSON.parse(text).error || errMsg; } catch { /* keep default */ }
        return { ok: false, error: `${errMsg} (HTTP ${dateRes.status})` };
      }
    }

    return {
      ok: true,
      warning: data.airtableSynced === false
        ? 'Local receive saved, but Airtable write-back did not sync.'
        : undefined,
    };
  }

  async function saveItem(sku: string) {
    const item = batch.get(sku);
    if (!item || item.il_id == null) return;

    const choiceError = receiveChoiceError(item);
    if (choiceError) {
      updateBatchItem(sku, { save_state: 'error', save_error: choiceError });
      return;
    }

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
    const templateStorage = storageShippingTemplate(item.draft_shipping_template.trim(), amazonTemplates);
    if (templateStorage)                           body.merchantShippingGroupName = templateStorage;
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
        const reconcileResult = await reconcileExistingLotFromChoice(item, qtyNum);
        if (!reconcileResult.ok) {
          updateBatchItem(sku, { save_state: 'error', save_error: reconcileResult.error || 'Incoming reconcile failed' });
          return;
        }
        // Mirror just-saved drafts back onto the local row so the
        // collapsed view and batch summary reflect the new values
        // without waiting for a refetch. Only mirror fields that were
        // actually sent (same conditionals as the PATCH body above).
        const mirror: Partial<BatchItem> = {
          save_state: 'saved',
          save_error: null,
          incoming_reconcile_warning: reconcileResult.warning ?? null,
        };
        if (Number.isFinite(qtyNum) && qtyNum >= 0) {
          mirror.quantity_received = qtyNum;
          if (qtyNum > 0) {
            const now = new Date().toISOString();
            if (!item.received_at)  mirror.received_at  = now;
            if (!item.inspected_at) mirror.inspected_at = now;
          }
        }
        const savedBin = item.draft_bin.trim();
        if (savedBin)                    mirror.bin_location = savedBin;
        if (item.draft_condition.trim()) mirror.condition    = item.draft_condition.trim();
        if (Number.isFinite(priceNum) && priceNum > 0) {
          mirror.il_list_price_cents = Math.round(priceNum * 100);
        }
        if (templateStorage) {
          mirror.merchant_shipping_group_name = templateStorage;
          mirror.draft_shipping_template      = templateStorage;
        }
        applySuccessfulSaveMirror(sku, mirror, savedBin);
        if (autoPrintLabels && Number.isFinite(qtyNum) && qtyNum >= 1) {
          void autoPrintLabelForItem(item, qtyNum);
        }
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

  // Fire-and-forget silent sticker print after a successful save. Never
  // affects the save result: failures only set auto_print_error on the card.
  // Once per SKU per screen session — a failed print re-arms so the next
  // save can retry.
  async function autoPrintLabelForItem(item: BatchItem, copies: number) {
    if (!item.asin) return;
    if (autoPrintedSkusRef.current.has(item.sku)) return;
    autoPrintedSkusRef.current.add(item.sku);
    const spec = {
      asin: item.asin,
      title: item.product_name || undefined,
      condition: item.draft_condition.trim() || item.condition || undefined,
      bin: item.draft_bin.trim() || item.bin_location || undefined,
      copies: Math.min(50, Math.max(1, copies)),
    };
    try {
      const res = await fetch('/api/labels/print-direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specs: [spec] }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok || data.success !== true) {
        autoPrintedSkusRef.current.delete(item.sku);
        updateBatchItem(item.sku, { auto_print_error: String(data.error || `HTTP ${res.status}`) });
      } else {
        updateBatchItem(item.sku, { auto_print_error: null });
      }
    } catch (err) {
      autoPrintedSkusRef.current.delete(item.sku);
      updateBatchItem(item.sku, { auto_print_error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function createLot(sku: string) {
    const item = batch.get(sku);
    if (!item || item.il_id != null) return;

    const choiceError = receiveChoiceError(item);
    if (choiceError) {
      updateBatchItem(sku, { create_lot_state: 'error', create_lot_error: choiceError });
      return;
    }

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
    const incomingCandidate = selectedIncomingCandidate(item);

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
    if (batchId != null && batchId > 0)            body.batchId        = batchId;
    const templateStorageLot = storageShippingTemplate(item.draft_shipping_template.trim(), amazonTemplates);
    if (templateStorageLot)                        body.merchantShippingGroupName = templateStorageLot;
    if (incomingCandidate) {
      const receiptQty = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1;
      body.incomingPurchaseId = incomingCandidate.id;
      body.expectedQuantityReceived = incomingCandidate.quantity_received;
      body.receiptKey = mfnReceiptKey(item, incomingCandidate, receiptQty, batchId);
    }

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
      const incomingReconcile = d.incomingReconcile as Record<string, unknown> | null | undefined;
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
        incoming_reconcile_warning:   incomingReconcile?.airtableSynced === false
          ? 'Local receive saved, but Airtable write-back did not sync.'
          : null,
      });
      // createLot receives units too (markReceived) — same auto-print rules.
      if (autoPrintLabels && Number.isFinite(qtyNum) && qtyNum >= 1) {
        void autoPrintLabelForItem(item, qtyNum);
      }
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
    if (!item || item.il_id == null) return { ok: false, error: 'Save this item before preview/push' };

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
      setPreviewTemplate(data.rows?.find((row: ActivationPreviewRow) => row.proposed_shipping_template)?.proposed_shipping_template || data.shippingTemplate || '');
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
  const searchFreshness = !searching && results.length > 0 ? listingFreshness(results) : null;

  return (
    <div className="flex flex-col h-full bg-slate-900">
      {/* Workbench header — title, actions, search (visually unified) */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border border-border-subtle rounded-t-lg border-b border-border-subtle/60">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-semibold text-text-primary shrink-0">MFN Receive</h1>
          {batchArray.length > 0 && (
            <span className="text-xs text-text-tertiary truncate">
              {batchArray.length} in batch
              {savedCount > 0 && <> · <span className="text-green-400/90">{savedCount} saved</span></>}
              {summary.unsaved > 0 && <> · <span className="text-text-tertiary">{summary.unsaved} unsaved</span></>}
              {stateCounts['ready'] > 0 && <> · <span className="text-green-400 font-medium">Ready {stateCounts['ready']}</span></>}
            </span>
          )}
          {printAllMsg && <span className="text-[10px] text-text-tertiary/70 shrink-0">{printAllMsg}</span>}
        </div>
        {batchArray.length > 0 && (
          <div className="flex items-center gap-1.5 shrink-0 ml-4">
            {!locked && (
              <button
                onClick={toggleAutoPrintLabels}
                title="When on, each saved item silently prints its ASIN stickers (one per unit) to the label printer. Once per item per session — the card's print icon reprints."
                className={`flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs transition-colors ${
                  autoPrintLabels
                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-300 font-medium'
                    : 'border-border-subtle text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
                }`}
              >
                <Printer size={13} />
                Auto-print {autoPrintLabels ? 'ON' : 'off'}
              </button>
            )}
            {savedCount > 0 && (
              <button onClick={printAll} className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-subtle text-xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors">
                <Printer size={13} />Print All ({savedCount})
              </button>
            )}
            {!locked && savedCount > 0 && (
              <button onClick={previewAndPush} disabled={previewLoading} className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-blue-500/50 text-blue-400 text-xs font-medium hover:bg-blue-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {previewLoading ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                {previewLoading ? 'Loading…' : `Preview & Push (${savedCount})`}
              </button>
            )}
            {!locked && hasUnsaved && (
              <button onClick={saveAll} disabled={savingAll} className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors disabled:opacity-50">
                {savingAll ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                {savingAll ? 'Saving…' : `Save All (${saveable.length})`}
              </button>
            )}
            {!locked && batchId != null && batchId > 0 && [...batch.values()].some(i => !i.image_url) && (
              <button onClick={handleBackfillImages} disabled={backfillingImages} className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-subtle text-xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors disabled:opacity-50" title="Fetch missing product images from Amazon's catalog">
                {backfillingImages ? <Loader2 size={13} className="animate-spin" /> : <ImageIcon size={13} />}
                {backfillingImages
                  ? `Fetching… ${backfillProgress ? `${backfillProgress.done}/${backfillProgress.remaining + backfillProgress.done}` : ''}`
                  : 'Get Photos'}
              </button>
            )}
            {!locked && (
              <button onClick={() => { setBatch(new Map()); setReceiveFilter('all'); }} className="h-8 px-3 rounded-md border border-border-subtle text-xs text-text-tertiary hover:bg-bg-hover transition-colors">
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {locked && (
        <div className="flex items-center gap-2 px-4 py-2.5 mb-3 bg-slate-800 border-x border-b border-border-subtle rounded-b-lg text-xs text-text-tertiary">
          <Lock size={13} className="text-text-tertiary shrink-0" />
          This batch is closed and in History — locked for auditing. Restore it from the header to make changes or re-push.
        </div>
      )}

      {/* Search — lower half of unified header block */}
      {!locked && (
      <div ref={searchContainerRef} className="relative bg-slate-800 border-x border-b border-border-subtle rounded-b-lg mb-3">
        <div className="relative px-3 py-2">
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
              pendingEnterRef.current = null;
              setSearchOpen(true);
              if (multiMatchTimerRef.current) clearTimeout(multiMatchTimerRef.current);
              setMultiMatchNote(false);
            }}
            onKeyDown={e => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const entered = query.trim();
              if (entered.length >= 2 && (searching || resultsQueryRef.current !== entered)) {
                // Results are stale or still loading (scanner Enter beats the
                // debounce) — act when THIS query's results arrive.
                pendingEnterRef.current = entered;
                doSearch(entered);
                return;
              }
              if (results.length > 1) {
                if (multiMatchTimerRef.current) clearTimeout(multiMatchTimerRef.current);
                setMultiMatchNote(true);
                multiMatchTimerRef.current = setTimeout(() => setMultiMatchNote(false), 2000);
                return;
              }
              if (results.length !== 1) return;
              // Scan-to-receive: +1 to the matched item and keep the cursor in
              // the search bar so the next scan is captured here (not in a
              // row's quantity field).
              scanReceive(results[0]);
            }}
            placeholder="Scan barcode, ASIN, MSKU, or title…"
            className="w-full h-11 pl-9 pr-9 bg-slate-800 border border-border-default rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:border-blue-500 focus:outline-none"
          />
        </div>

        {/* Dropdown — visible when query ≥ 2 chars */}
        {searchOpen && query.trim().length >= 2 && (
          <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-slate-800 border border-border-default rounded-lg shadow-xl overflow-hidden">
            {/* Helper / status line */}
            <div className="px-3 py-1.5 border-b border-border-subtle">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-xs text-text-tertiary">
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
                {searchFreshness && (
                  <span
                    className={`shrink-0 text-[10px] ${searchFreshness.stale ? 'text-amber-400' : 'text-text-tertiary/70'}`}
                    title={searchFreshness.title}
                  >
                    {searchFreshness.label}
                  </span>
                )}
              </div>
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
      )}

      {/* Filter strip + KPI — flat tab-strip below the header */}
      {batchArray.length > 0 && (
        <div className="flex items-start justify-between gap-4 px-3 py-1.5 mb-2 border-b border-border-subtle/60">
          {/* Filter pills — left */}
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
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
                      : 'bg-blue-500/15 text-blue-400 border-blue-500/40'
                : 'bg-slate-800 text-text-tertiary border-border-subtle hover:text-text-secondary hover:bg-bg-hover';
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
              <span className="ml-1 text-text-tertiary/80 italic text-[11px]">
                Showing {visibleBatch.length} of {batchArray.length}
              </span>
            )}
          </div>
          {/* KPI line — right.
              This bar sits on a fixed dark surface, so it uses fixed slate
              colors (NOT theme tokens like text-text-primary, which flip to
              near-black in light mode and vanish here). Profit metrics
              (Net/ROI/Margin) all share one sign-based color for consistency. */}
          <div className="shrink-0 text-right">
            <div className="flex items-center gap-x-4 text-xs flex-wrap justify-end">
              <span className="text-slate-400">Qty <span className="text-slate-100 font-mono text-base">{summary.totalQty}</span></span>
              <span className="text-slate-400">Rev <span className="text-slate-100 font-mono text-base">{formatCurrency(summary.totalListCents)}</span></span>
              <span className="text-slate-400">Cost <span className="text-slate-100 font-mono text-base">{formatCurrency(summary.totalCostCents)}</span></span>
              <span className="text-slate-400">Ship <span className="text-slate-100 font-mono text-base">{formatCurrency(summary.totalShipCents)}</span></span>
              <span className="text-slate-400">Fees <span className="text-slate-100 font-mono text-base">{formatCurrency(summary.totalFeeCents)}</span></span>
              <span className="text-slate-400">
                Net <span className={`font-mono font-semibold text-base ${
                  summary.profitIncomplete
                    ? 'text-slate-300'
                    : summary.totalNetCents > 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {summary.profitIncomplete ? '~' : ''}{formatCurrency(summary.totalNetCents)}
                </span>
              </span>
              {summary.roiPct != null && !summary.profitIncomplete && (
                <span className="text-slate-400">
                  ROI <span className={`font-mono ${summary.totalNetCents > 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {summary.roiPct.toFixed(1)}%
                  </span>
                </span>
              )}
              {summary.marginPct != null && !summary.profitIncomplete && (
                <span className="text-slate-400">
                  Margin <span className={`font-mono ${summary.totalNetCents > 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {summary.marginPct.toFixed(1)}%
                  </span>
                </span>
              )}
            </div>
            {summary.profitIncomplete && (
              <div className="text-[10px] text-slate-500 mt-1 italic">
                {summary.priceOrCostIncomplete
                  ? 'Estimate — some items missing price or cost.'
                  : 'Estimate — Amazon fee not cached. ROI/margin hidden.'}
              </div>
            )}
          </div>
        </div>
      )}

      {receiveFilter !== 'all' && batchArray.length > 0 && (
        <div className="mb-2 -mt-1 text-[10px] text-text-tertiary/60 italic">
          Filters only change visible rows; Print All and Preview &amp; Push use the full saved batch.
        </div>
      )}

      {/* Batch area — full width */}
      <div className="flex-1 flex flex-col min-h-0">
        {batchArray.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center border border-dashed border-border-subtle rounded-xl py-10">
            {!(searchOpen && query.trim().length >= 2) && (
              <>
                <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-slate-800 border border-border-subtle mb-4">
                  <ScanBarcode size={28} className="text-text-tertiary opacity-60" />
                </div>
                <p className="text-sm font-semibold text-text-secondary">Scan or search to start receiving</p>
                <p className="text-xs text-text-tertiary mt-1.5 max-w-[240px]">
                  Use the search bar above for UPC, ASIN, MSKU, or title.
                </p>
                <p className="text-[11px] text-text-tertiary/60 mt-3 font-mono">
                  Enter adds a single match
                </p>
              </>
            )}
          </div>
          ) : (
            <>
            {/* Table column header — widths match BatchItemRow zones exactly */}
            <div className="flex items-center gap-2 px-3 pr-1 pb-1 mb-0.5 text-[10px] font-semibold text-text-tertiary/50 uppercase tracking-wider select-none border-b border-border-subtle/50">
              <div className="w-8 shrink-0" />
              <div className="min-w-0 flex-1">Item</div>
              <div className="w-32 shrink-0">Qty</div>
              <div className="w-20 shrink-0 text-right">COGS</div>
              <div className="w-20 shrink-0 text-right">List</div>
              <div className="w-24 shrink-0 text-right">Actions</div>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1 min-h-0 pr-1">
              {receiveFilter !== 'all' && visibleBatch.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10 text-center text-text-tertiary">
                  <p className="text-sm">No items match this filter.</p>
                  <button
                    type="button"
                    onClick={() => setReceiveFilter('all')}
                    className="mt-2 text-xs text-blue-400 hover:underline"
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
                  amazonTemplates={amazonTemplates}
                  locked={locked}
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
          shippingTemplates={amazonTemplates ?? []}
          onClose={() => setPreviewOpen(false)}
          onPushComplete={() => { setPreviewOpen(false); }}
          onAllEligibleAccepted={
            batchId != null && batchId > 0
              ? async () => {
                  // Every eligible SKU was accepted → finalize this batch and
                  // send it to History. Partial pushes never reach here, so the
                  // batch only closes when nothing is left to push.
                  try {
                    await fetch(`/api/list/batches/${batchId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ status: 'closed' }),
                    });
                  } catch (err) {
                    console.warn('batch auto-close failed:', err);
                  }
                  window.location.href = '/list/history';
                }
              : undefined
          }
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
            amazonTemplates={amazonTemplates}
          />
        );
      })()}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setLightbox(null)}
        >
          <div
            className="relative bg-white rounded-xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setLightbox(null)}
              className="absolute top-2 right-2 z-10 p-1.5 rounded-full bg-black/40 hover:bg-black/60 text-white/90"
              title="Close (Esc)"
            >
              <X size={18} />
            </button>
            <img
              src={lightbox.src.replace(/\._[A-Z0-9,]+_\.(jpg|jpeg|png)/i, '.$1')}
              alt={lightbox.title}
              className="block h-[85vh] w-auto max-w-[92vw] object-contain"
            />
            <div className="absolute bottom-0 inset-x-0 px-4 py-2.5 bg-gradient-to-t from-black/70 to-transparent">
              <div className="text-sm font-medium text-white leading-snug line-clamp-2" title={lightbox.title}>
                {lightbox.title}
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-[10px] font-mono text-white/70">
                {lightbox.asin && <AsinLink asin={lightbox.asin} className="text-blue-300 hover:text-blue-200 hover:underline" />}
                <MskuLink sku={lightbox.sku} className="truncate hover:text-blue-200 hover:underline" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
