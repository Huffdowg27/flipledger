'use client';

import { useEffect, useState, useRef, useCallback, use, useMemo } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/formatters';
import { generateMSKU } from '@/lib/listing-msku';
import { ArrowLeft, Search, Plus, Trash2, Package, TrendingUp, DollarSign, Percent, Send, ExternalLink, CheckCircle, AlertCircle, Loader2, Archive, Box as BoxIcon, MapPin, Sparkles, Pencil, X as XIcon, Check, ChevronDown, Copy, FileUp } from 'lucide-react';
import dynamic from 'next/dynamic';
import type { MapShipmentMeta } from '@/components/PlacementMap';
import MfnBatchReceiveWorkflow from '@/components/mfn/MfnBatchReceiveWorkflow';
const PlacementMap = dynamic(() => import('@/components/PlacementMap'), { ssr: false });

interface Batch {
  id: number;
  name: string;
  status: string;
  channel: string;
  marketplace: string;
  inboundPlanId: string | null;
  inboundOperationId?: string | null;
  planStatus?: string | null;
  sendError?: string | null;
  sentAt?: string | null;
  shipFromCity: string | null;
  shipFromState: string | null;
  // Phase 3: packing
  packingStatus?: string | null;
  packingError?: string | null;
  packingConfirmedAt?: string | null;
  // Phase 3: placement
  placementStatus?: string | null;
  placementOptionId?: string | null;
  placementFeeCents?: number | null;
  placementError?: string | null;
  placementConfirmedAt?: string | null;
  // Phase 3.5: transportation
  transportationStatus?: string | null;
  transportationOptionId?: string | null;
  transportationError?: string | null;
  transportationConfirmedAt?: string | null;
  confirmedShipments?: string | null;  // JSON: [{shipmentId, confirmationId, destinationFC, carrier, cost, ...}]
  confirmedShipmentIds?: string | null; // JSON: [shipmentId, ...]
  createdAt: string;
  updatedAt: string;
}

interface BoxItemAssignment {
  id?: number;
  boxId?: number;
  itemId: number;
  quantity: number;
}

interface Box {
  id?: number;
  boxIndex?: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightLb: number;
  packingGroupId?: string | null; // which Amazon pack group this box belongs to (for multi-group batches)
  items: BoxItemAssignment[];
}

// Amazon-assigned pack group: a subset of batch items that ship as their own
// shipment (and possibly to a different FC). Multi-group batches must be
// boxed group-by-group.
interface PackGroup {
  id: number;                      // local DB id
  packingGroupId: string;          // Amazon's pgXXX id
  groupIndex: number;
  items: Array<{
    itemId: number;
    sku: string;
    productName: string | null;
    quantity: number;
  }>;
}

interface ConfirmedShipment {
  shipmentId: string;
  confirmationId: string | null;
  destinationFC: string | null;
  destinationCity: string | null;
  destinationState: string | null;
  destinationAddress: Record<string, string> | null;
  carrier: string | null;
  carrierCode: string | null;
  shippingMode: string | null;
  shippingSolution: string | null;
  transportationOptionId: string;
  cost: number | null;
  costCurrency: string;
  readyToShipWindow: string | null;
  confirmedAt: string;
}

interface PlacementFee {
  target: string;
  type: string;
  value: { amount: number; code: string };
  description?: string;
}

interface PlacementDestination {
  shipmentId: string;
  fcCode: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  distanceMiles: number | null;
  type?: string | null;
  carrier?: string | null;
  shippingCost?: number | null;
  boxes?: number | null;
  units?: number | null;
}

interface PlacementOption {
  placementOptionId: string;
  shipmentIds: string[];
  fees: PlacementFee[];
  status: 'OFFERED' | 'ACCEPTED' | 'EXPIRED';
  discounts?: any[];
  // enriched by backend
  placementFeeCents?: number;
  carrierFeeCents?: number;
  destinations?: PlacementDestination[];
}

interface PlacementMapData {
  shipmentMeta: Record<string, MapShipmentMeta>;
  shipFromLat: number | null;
  shipFromLng: number | null;
  shipFromState: string | null;
}

type DebugItem = { fnsku: string | null; amazonStatus: string[]; lastChecked: string; pollError?: string };

interface ExistingSku {
  sku: string;
  fnsku: string | null;
  asin: string;
  listingStatus: string;          // ACTIVE | DISCOVERABLE | SUPPRESSED | INCOMPLETE | INACTIVE | UNKNOWN
  fulfillmentChannel: 'FBA' | 'MFN';
  conditionType: string;
  fbaStock: number;
  listPriceCents: number;
  itemName: string | null;
  /** AMAZON_INVENTORY = live from SP-API Listings (replenishable). LOCAL_DB = cached snapshot only. */
  source: 'AMAZON_INVENTORY' | 'LOCAL_DB' | 'sp-api' | 'local';
  lastSynced: string;
}

interface BatchItem {
  id: number;
  asin: string;
  sku: string;
  msku: string | null;
  productName: string | null;
  imageUrl: string | null;
  condition: string;
  quantity: number;
  listPriceCents: number;
  buyPriceCents: number;
  estimatedFeeCents: number;
  estimatedShipCents: number;
  supplier: string | null;
  purchaseDate: string | null;
  listingStatus?: string | null;
  listingSubmissionId?: string | null;
  listingError?: string | null;
  listingUpdatedAt?: string | null;
  listingMode?: string | null;      // CREATE_NEW | REPLENISH_EXISTING
  fnsku?: string | null;
  labelsPrintedAt?: string | null;  // user marks "I'm done labeling this SKU"
}

interface FeeEstimate {
  totalFeeCents: number;
  referralFeeCents: number;
  fbaFeeCents: number;
  source: 'sp-api' | 'cache' | 'fallback';
}

interface ShippingEstimate {
  costCents: number;
  source: 'per-asin' | 'marketplace-avg' | 'none';
  sampleSize: number;
}

interface CatalogResult {
  asin: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  imageUrl: string | null;
  dimensions: { lengthIn?: number; widthIn?: number; heightIn?: number; weightLb?: number } | null;
  source: 'amazon' | 'local';
  avgFeeRate?: number;
  avgSalePrice?: number;
  unitsSoldLast30d?: number;
  unitsSoldLast90d?: number;
  currentFbaStock?: number;
  lastBuyPrice?: number;
  feeEstimate?: FeeEstimate | null;
  feeEstimatePriceCents?: number;
  shippingEstimate?: ShippingEstimate | null;
}

interface PendingAddDraft {
  query: string;
  scanned: CatalogResult | null;
  sku: string;
  skuManuallyEdited: boolean;
  buyPrice: string;
  listPrice: string;
  shipCost: string;
  quantity: string;
  supplier: string;
  condition: string;
  listingMode: 'CREATE_NEW' | 'REPLENISH_EXISTING';
  selectedExistingSku: ExistingSku | null;
  existingSkus: ExistingSku[];
  existingSkuFilter: string;
  manualMsku: string;
  savedAt: string;
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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft:     'bg-bg-elevated text-text-secondary border-border-default',
    sending:   'bg-accent/10 text-accent border-accent/30',
    ready:     'bg-positive/10 text-positive border-positive/20',
    failed:    'bg-negative/10 text-negative border-negative/30',
    boxing:    'bg-amber-500/10 text-amber-400 border-amber-500/20',
    placement: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    shipping:  'bg-blue-500/10 text-blue-400 border-blue-500/20',
    shipped:   'bg-positive/10 text-positive border-positive/20',
    closed:    'bg-text-tertiary/10 text-text-tertiary border-text-tertiary/20',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider ${map[status] || map.draft}`}>
      {status}
    </span>
  );
}

export default function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Scan form state
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [scanned, setScanned] = useState<CatalogResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // Item entry state
  const [sku, setSku] = useState('');
  const [skuManuallyEdited, setSkuManuallyEdited] = useState(false);
  const [buyPrice, setBuyPrice] = useState('');
  const [listPrice, setListPrice] = useState('');
  const [shipCost, setShipCost] = useState(''); // MFN outbound shipping cost
  const [quantity, setQuantity] = useState('1');
  const [supplier, setSupplier] = useState('');
  const [condition, setCondition] = useState('NewItem');
  const [saving, setSaving] = useState(false);
  const [pendingDraftHydrated, setPendingDraftHydrated] = useState(false);
  const [pendingDraftRestored, setPendingDraftRestored] = useState(false);

  // Phase 2: Send to Amazon state
  const [showSendModal, setShowSendModal] = useState(false);
  const [sending, setSending] = useState(false);
  const [debugItems, setDebugItems] = useState<Record<number, DebugItem>>({});

  // Existing Seller Central MSKU lookup — runs after every ASIN scan.
  const [existingSkus, setExistingSkus] = useState<ExistingSku[]>([]);
  const [existingSkusLoading, setExistingSkusLoading] = useState(false);
  const [existingSkusError, setExistingSkusError] = useState<string | null>(null);
  const [existingSkuFilter, setExistingSkuFilter] = useState('');
  const [listingMode, setListingMode] = useState<'CREATE_NEW' | 'REPLENISH_EXISTING'>('CREATE_NEW');
  const [selectedExistingSku, setSelectedExistingSku] = useState<ExistingSku | null>(null);
  const [manualMsku, setManualMsku] = useState('');
  const [manualMskuVerifying, setManualMskuVerifying] = useState(false);
  const [manualMskuError, setManualMskuError] = useState<string | null>(null);

  // Phase 3: Boxing + placement state
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [packGroups, setPackGroups] = useState<PackGroup[]>([]);
  const [initializingBoxing, setInitializingBoxing] = useState(false);
  const [syncingFromAmazon, setSyncingFromAmazon] = useState(false);
  const [savingBoxes, setSavingBoxes] = useState(false);
  const [packing, setPacking] = useState(false);
  const [placementOptions, setPlacementOptions] = useState<PlacementOption[]>([]);
  const [placementMapData, setPlacementMapData] = useState<PlacementMapData | null>(null);
  const [placementDebug, setPlacementDebug] = useState<any>(null);
  const [hoveredOptionId, setHoveredOptionId] = useState<string | null>(null);
  const [loadingPlacement, setLoadingPlacement] = useState(false);
  const [confirmingPlacementId, setConfirmingPlacementId] = useState<string | null>(null);
  const [confirmingBothId, setConfirmingBothId] = useState<string | null>(null);

  // FNSKU label printing — works at the 'ready' state, no shipment ID needed
  const [printingFnsku, setPrintingFnsku] = useState(false);
  const [printingItemId, setPrintingItemId] = useState<number | null>(null);

  // Photo lightbox — click any product image to view it large (Prep Ship Hub style)
  const [lightbox, setLightbox] = useState<{ src: string; title: string; asin: string | null; sku: string | null } | null>(null);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // Cancel & edit — undoes the inbound plan and resets to draft so the user
  // can add items / fix mistakes and re-send. Listings stay on Amazon.
  const [cancelling, setCancelling] = useState(false);

  const pendingDraftStorageKey = useMemo(() => `flipledger:list-batch:${id}:pending-add`, [id]);

  useEffect(() => {
    setPendingDraftHydrated(false);
    setPendingDraftRestored(false);

    try {
      const raw = window.localStorage.getItem(pendingDraftStorageKey);
      if (!raw) {
        setPendingDraftHydrated(true);
        return;
      }

      const draft = JSON.parse(raw) as Partial<PendingAddDraft>;
      setQuery(draft.query || '');
      setScanned(draft.scanned || null);
      setSku(draft.sku || '');
      setSkuManuallyEdited(!!draft.skuManuallyEdited);
      setBuyPrice(draft.buyPrice || '');
      setListPrice(draft.listPrice || '');
      setShipCost(draft.shipCost || '');
      setQuantity(draft.quantity || '1');
      setSupplier(draft.supplier || '');
      setCondition(draft.condition || 'NewItem');
      setListingMode(draft.listingMode || 'CREATE_NEW');
      setSelectedExistingSku(draft.selectedExistingSku || null);
      setExistingSkus(draft.existingSkus || []);
      setExistingSkuFilter(draft.existingSkuFilter || '');
      setManualMsku(draft.manualMsku || '');
      setPendingDraftRestored(true);
    } catch (err) {
      console.warn('pending add draft restore failed:', err);
      window.localStorage.removeItem(pendingDraftStorageKey);
    } finally {
      setPendingDraftHydrated(true);
    }
  }, [pendingDraftStorageKey]);

  useEffect(() => {
    if (!pendingDraftHydrated) return;

    const hasDraft =
      !!scanned ||
      !!query.trim() ||
      !!sku.trim() ||
      !!buyPrice.trim() ||
      !!listPrice.trim() ||
      !!shipCost.trim() ||
      !!supplier.trim() ||
      quantity !== '1' ||
      condition !== 'NewItem' ||
      listingMode !== 'CREATE_NEW' ||
      !!selectedExistingSku ||
      existingSkus.length > 0 ||
      !!existingSkuFilter.trim() ||
      !!manualMsku.trim();

    if (!hasDraft) {
      window.localStorage.removeItem(pendingDraftStorageKey);
      setPendingDraftRestored(false);
      return;
    }

    const draft: PendingAddDraft = {
      query,
      scanned,
      sku,
      skuManuallyEdited,
      buyPrice,
      listPrice,
      shipCost,
      quantity,
      supplier,
      condition,
      listingMode,
      selectedExistingSku,
      existingSkus,
      existingSkuFilter,
      manualMsku,
      savedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(pendingDraftStorageKey, JSON.stringify(draft));
  }, [
    pendingDraftHydrated,
    pendingDraftStorageKey,
    query,
    scanned,
    sku,
    skuManuallyEdited,
    buyPrice,
    listPrice,
    shipCost,
    quantity,
    supplier,
    condition,
    listingMode,
    selectedExistingSku,
    existingSkus,
    existingSkuFilter,
    manualMsku,
  ]);

  // Auto-generate MSKU whenever supplier / buyPrice / productName changes,
  // unless the user has manually typed into the MSKU field.
  useEffect(() => {
    if (!scanned || skuManuallyEdited) return;
    const autoMsku = generateMSKU(supplier, scanned.name, buyPrice, scanned.asin);
    setSku(autoMsku);
  }, [scanned, supplier, buyPrice, skuManuallyEdited]);

  const fetchBatch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/list/batches/${id}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setBatch(data.batch);
      setItems(data.items || []);
      setBoxes(data.boxes || []);
      setPackGroups(data.packGroups || []);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchBatch(); }, [fetchBatch]);

  // Shared status poll — called by the interval and by the manual Refresh button.
  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/list/batches/${id}/status`);
      const data = await res.json();
      if (data.batch) setBatch(data.batch);
      if (data.items) setItems(data.items);
      if (data.debugItems) setDebugItems(data.debugItems);
    } catch (err) {
      console.warn('status poll error:', err);
    }
  }, [id]);

  const handleForceReady = useCallback(async () => {
    if (!batch) return;
    try {
      await fetch(`/api/list/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ready' }),
      });
      await pollStatus();
    } catch (err) {
      console.warn('force-ready error:', err);
    }
  }, [id, batch, pollStatus]);

  // Phase 2: poll /status while the batch is in 'sending' (or 'ready' briefly).
  // Cheap for other states — the backend short-circuits for draft/failed/ready.
  // Resilient to tab visibility: pauses polling when hidden, immediately re-polls
  // on refocus so users don't come back to a stale "sending…" state.
  //
  // Phase 3 note: pack + placement ops are awaited server-side, so we don't
  // need to poll during boxing/placement/shipping. The handlers refetch the
  // batch themselves on completion.
  // Scalar deps only — depending on the `batch`/`items` objects would re-run
  // the effect (and fire an immediate poll) after every setBatch/setItems,
  // turning the 6s interval into a continuous back-to-back poll loop.
  const batchStatus = batch?.status ?? null;
  const anyItemProcessing = items.some((i) => i.listingStatus === 'PROCESSING');
  useEffect(() => {
    // Poll fast while sending; keep a slow poll on 'ready' batches that still
    // have PROCESSING listings (timeout-advanced before Amazon finished
    // verifying) so per-item state eventually reflects reality.
    const isSending = batchStatus === 'sending';
    if (!isSending && !(batchStatus === 'ready' && anyItemProcessing)) return;
    const pollMs = isSending ? 6000 : 30000;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (cancelled) return;
      await pollStatus();
    };

    const startPolling = () => {
      if (interval) return;
      interval = setInterval(tick, pollMs);
    };
    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Tab just came back — poll immediately and resume the interval.
        tick();
        startPolling();
      } else {
        // Tab is hidden — stop the background polling. setInterval in a
        // background tab is throttled anyway, and we want to re-poll the
        // moment the user returns rather than wait on a stale interval.
        stopPolling();
      }
    };

    // Kick off an immediate poll, then start the interval if we're visible.
    tick();
    if (document.visibilityState === 'visible') startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [id, batchStatus, anyItemProcessing, pollStatus]);

  async function handleSendToAmazon() {
    if (!batch) return;
    setSending(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/send`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(`Send failed: ${data.error}`);
      } else {
        setShowSendModal(false);
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setSending(false);
  }

  async function handleCancelAndEdit() {
    if (!batch) return;
    const isFailedReset = batch.status === 'failed' || batch.status === 'sending';
    const confirmMsg = isFailedReset
      ? `Reset this failed batch to draft?\n\n`
        + `WHAT STAYS:\n`
        + `  • Listings that already got created on Amazon stay\n`
        + `  • No money lost — send failed before any plan was committed\n\n`
        + `WHAT YOU CAN DO IN DRAFT:\n`
        + `  • Remove the items that caused the error\n`
        + `  • Edit quantities or add new items\n`
        + `  • Click Send again — items that already worked will skip straight through`
      : `Cancel the inbound plan and unlock this batch for editing?\n\n`
        + `WHAT STAYS:\n`
        + `  • All ${items.length} listings stay live on Amazon (with FNSKUs)\n`
        + `  • Prep classifications stay\n`
        + `  • No money lost — no shipments were committed\n\n`
        + `WHAT GETS UNDONE:\n`
        + `  • The inbound plan record is cancelled on Amazon\n`
        + `  • Any boxes you saved are wiped\n`
        + `  • Batch goes back to draft so you can add items + re-send\n\n`
        + `Re-sending will be much faster since listings already exist (~30s).`;
    if (!confirm(confirmMsg)) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/cancel-and-edit`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(`Cancel failed: ${data.error}`);
      } else {
        await fetchBatch();
        if (!data.amazonCancelled) {
          console.warn('[cancel-and-edit] Amazon-side cancellation failed but local batch was reset:', data.amazonError);
        }
      }
    } catch (err) {
      alert(String(err));
    }
    setCancelling(false);
  }

  async function handleCloseBatch() {
    if (!batch) return;
    if (!confirm('Close this batch? You won\'t be able to make changes, but all the data (COGS, listings, stats) stays in FlipLedger.')) return;
    try {
      const res = await fetch(`/api/list/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed' }),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Close failed: ${data.error}`);
      } else {
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
  }

  // ─── "Labeled" tracking — purely local UI state, helps Parker keep track
  // while physically applying FNSKU stickers. Toggle = mark/unmark a row as
  // done. When set, the row gets a green tint so the unlabeled ones stand out.
  async function handleToggleLabeled(itemId: number, currentlyLabeled: boolean) {
    try {
      const res = await fetch(`/api/list/batches/${id}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelsPrintedAt: currentlyLabeled ? null : true }),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Toggle failed: ${data.error}`);
      } else {
        await fetchBatch();
      }
    } catch (err) {
      console.error(err);
    }
  }

  // ─── FNSKU labels (print BEFORE packing — works at 'ready' state) ───────
  // mode='per-sku': 1 label per SKU; user sets copy count at the Rollo dialog.
  // mode='per-unit': 1 label per individual unit; pre-counted, no Rollo dialog.
  // itemId: optional — print just one row's label instead of the whole batch.
  // copies: optional — explicit pre-counted N labels for a single item. Use
  //   this for "print 1 replacement" or "print 6 of 12" partial cases. Forces
  //   pre-counted output (Rollo just spools N labels, no copy dialog).
  async function handlePrintFnskuLabels(
    action: 'print' | 'download',
    mode: 'per-sku' | 'per-unit' = 'per-sku',
    itemId?: number,
    copies?: number
  ) {
    if (!batch) return;
    const params = new URLSearchParams({ action, mode });
    if (itemId) params.set('itemId', String(itemId));
    if (copies && copies > 0) params.set('copies', String(copies));
    const qs = params.toString();
    if (action === 'download') {
      window.open(`/api/list/batches/${id}/fnsku-labels?${qs}`, '_blank');
      return;
    }
    if (itemId) {
      setPrintingItemId(itemId);
    } else {
      setPrintingFnsku(true);
    }
    try {
      const res = await fetch(`/api/list/batches/${id}/fnsku-labels?${qs}`);
      const data = await res.json();
      if (data.success) {
        const missing = data.missingFnsku?.length
          ? `\n\n⚠ ${data.missingFnsku.length} item(s) missing FNSKU (still propagating): ${data.missingFnsku.join(', ')}`
          : '';
        const isSingle = !!itemId;
        const summary = copies
          ? `✓ Spooled ${data.labelCount} label${data.labelCount === 1 ? '' : 's'} (pre-counted) to ${data.printer}${data.jobId ? ' — job ' + data.jobId : ''}.`
          : isSingle
            ? `✓ Sent label for this item to ${data.printer}. Set the copy count at the Rollo dialog: ${data.totalUnits} unit${data.totalUnits === 1 ? '' : 's'}.`
            : mode === 'per-sku'
              ? `✓ Sent ${data.labelCount} unique label${data.labelCount === 1 ? '' : 's'} to ${data.printer} (1 per SKU). Set the copy count at the Rollo dialog: ${data.totalUnits} total unit${data.totalUnits === 1 ? '' : 's'} need labeling.`
              : `✓ Printed ${data.labelCount} FNSKU labels (one per unit, pre-counted) to ${data.printer}${data.jobId ? ' — job ' + data.jobId : ''}.`;
        alert(summary + missing);
      } else {
        const hint = data.hint ? `\n\n${data.hint}` : '';
        alert(`Print failed: ${data.error}${hint}\n\nTry "PDF" instead and print manually.`);
      }
    } catch (err) {
      alert(`Print error: ${err}`);
    }
    setPrintingItemId(null);
    setPrintingFnsku(false);
  }

  // ─── Phase 3: Boxing + placement handlers ───────────────────────────────

  // Initialize boxing: hits /initialize-boxing on the backend to generate
  // packing options on Amazon and learn which items belong to which pack
  // group. Then seeds one EMPTY default box per group — the user adds items
  // to each box as they physically pack them.
  async function initializeDefaultBoxes() {
    if (boxes.length > 0) return; // already boxed
    setInitializingBoxing(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/initialize-boxing`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(`Initialize boxing failed: ${data.error}`);
        setInitializingBoxing(false);
        return;
      }
      const groups: PackGroup[] = data.packGroups || [];
      setPackGroups(groups);

      // Seed one EMPTY default box per pack group. User assigns items as they pack.
      const seededBoxes: Box[] = groups.map((g) => ({
        lengthIn: 18,
        widthIn: 14,
        heightIn: 12,
        weightLb: 20,
        packingGroupId: g.packingGroupId,
        items: [],
      }));
      setBoxes(seededBoxes);
    } catch (err) {
      alert(`Initialize boxing error: ${err}`);
    }
    setInitializingBoxing(false);
  }

  async function handleSyncFromAmazon() {
    if (!batch) return;
    if (!confirm(
      'Pull the current batch state from Amazon? Use this if you finished packing/placement in Seller Central. The batch will move to "Shipping" if Amazon shows shipments are created.'
    )) return;
    setSyncingFromAmazon(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/sync-from-amazon`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(`Sync failed: ${data.error}`);
      } else {
        alert(data.message || 'Synced.');
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setSyncingFromAmazon(false);
  }

  function addEmptyBox(packingGroupId?: string) {
    setBoxes((prev) => [
      ...prev,
      {
        lengthIn: 18,
        widthIn: 14,
        heightIn: 12,
        weightLb: 20,
        packingGroupId: packingGroupId || null,
        items: [],
      },
    ]);
  }

  function removeBoxAt(idx: number) {
    setBoxes((prev) => prev.filter((_, i) => i !== idx));
  }

  // Duplicate one box N times — copies dimensions, weight, packing group, and
  // contents (item assignments) as-is. Use case: 25 units / 5 per box / 5
  // identical boxes — assign 5 to box 1, duplicate 4 times. Items array is
  // copied verbatim, so each duplicate claims the same units; batch validation
  // will flag if total assigned exceeds available batch qty.
  function duplicateBoxAt(idx: number, copies: number = 1) {
    if (copies < 1) return;
    const clamped = Math.min(copies, 50); // sanity cap
    setBoxes((prev) => {
      const source = prev[idx];
      if (!source) return prev;
      const dupes = Array.from({ length: clamped }, () => ({
        lengthIn: source.lengthIn,
        widthIn: source.widthIn,
        heightIn: source.heightIn,
        weightLb: source.weightLb,
        packingGroupId: source.packingGroupId,
        items: source.items.map((bi) => ({ ...bi })),
      }));
      // Insert directly after the source box so the visual order is intuitive.
      return [...prev.slice(0, idx + 1), ...dupes, ...prev.slice(idx + 1)];
    });
  }

  function updateBoxField(idx: number, field: keyof Box, value: number) {
    setBoxes((prev) => prev.map((b, i) => (i === idx ? { ...b, [field]: value } : b)));
  }

  // Set the quantity of itemId in boxIdx. If qty=0, remove the assignment.
  function setBoxItemQty(boxIdx: number, itemId: number, qty: number) {
    setBoxes((prev) =>
      prev.map((b, i) => {
        if (i !== boxIdx) return b;
        const existing = b.items.find((bi) => bi.itemId === itemId);
        if (qty <= 0) {
          return { ...b, items: b.items.filter((bi) => bi.itemId !== itemId) };
        }
        if (existing) {
          return { ...b, items: b.items.map((bi) => (bi.itemId === itemId ? { ...bi, quantity: qty } : bi)) };
        }
        return { ...b, items: [...b.items, { itemId, quantity: qty }] };
      })
    );
  }

  async function handleSaveBoxes() {
    if (!batch) return;
    setSavingBoxes(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/boxes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxes }),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Save failed: ${data.error}`);
      } else {
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setSavingBoxes(false);
  }

  async function handleConfirmPacking() {
    if (!batch) return;
    if (!confirm(
      'Confirm packing with Amazon? This sends your box dimensions/weight and item assignments to Amazon. After this step, the boxes are locked and Amazon generates placement options.'
    )) return;
    setPacking(true);
    try {
      // Save boxes first in case the user tweaked anything
      const saveRes = await fetch(`/api/list/batches/${id}/boxes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxes }),
      });
      const saveData = await saveRes.json();
      if (saveData.error) {
        alert(`Save failed: ${saveData.error}`);
        setPacking(false);
        return;
      }
      // Now push to Amazon
      const res = await fetch(`/api/list/batches/${id}/pack`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(`Confirm packing failed: ${data.error}`);
      } else {
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setPacking(false);
  }

  function applyPlacementData(data: any) {
    if (data.options) setPlacementOptions(data.options);
    if (data.shipmentMeta !== undefined) {
      setPlacementMapData({
        shipmentMeta: data.shipmentMeta ?? {},
        shipFromLat: data.shipFromLat ?? null,
        shipFromLng: data.shipFromLng ?? null,
        shipFromState: data.shipFromState ?? null,
      });
    }
    if (data._debug !== undefined) setPlacementDebug(data._debug);
  }

  async function handleGeneratePlacement() {
    if (!batch) return;
    setLoadingPlacement(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/placement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate' }),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Generate placement options failed: ${data.error}`);
      } else {
        applyPlacementData(data);
        await fetchBatch();
        // Fetch GET to get shipment meta (generate POST doesn't include it)
        const get = await fetch(`/api/list/batches/${id}/placement`).then((r) => r.json());
        applyPlacementData(get);
      }
    } catch (err) {
      alert(String(err));
    }
    setLoadingPlacement(false);
  }

  async function handleLoadPlacement() {
    if (!batch) return;
    setLoadingPlacement(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/placement`);
      const data = await res.json();
      if (data.error) {
        alert(`Load placement options failed: ${data.error}`);
      } else {
        applyPlacementData(data);
      }
    } catch (err) {
      alert(String(err));
    }
    setLoadingPlacement(false);
  }

  async function handleConfirmPlacement(optionId: string) {
    if (!batch) return;
    const chosen = placementOptions.find((o) => o.placementOptionId === optionId);
    const feeCents = chosen?.fees.reduce((sum, f) => sum + Math.round((f.value?.amount || 0) * 100), 0) || 0;
    if (!confirm(
      `Lock in this placement option? The ${formatCurrency(feeCents)} placement fee will be charged to your Amazon account. This creates real shipments.`
    )) return;
    setConfirmingPlacementId(optionId);
    try {
      const res = await fetch(`/api/list/batches/${id}/placement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', placementOptionId: optionId }),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Confirm placement failed: ${data.error}`);
      } else {
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setConfirmingPlacementId(null);
  }

  async function handleConfirmPlacementAndLoadTransport(
    placementOptionId: string,
    shipmentIds: string[],
    readyToShipStart: string,
  ): Promise<{ success: boolean; options?: any[]; shipments?: any[]; error?: string }> {
    if (!batch) return { success: false };
    const chosen = placementOptions.find((o) => o.placementOptionId === placementOptionId);
    const feeCents = chosen?.placementFeeCents ??
      chosen?.fees.reduce((sum, f) => sum + Math.round((f.value?.amount || 0) * 100), 0) ?? 0;
    if (!confirm(
      `Confirm this placement option?\n\nThe ${formatCurrency(feeCents)} inbound placement fee will be charged to your Amazon account. Shipping cost will be shown after confirmation.`
    )) return { success: false };

    setConfirmingBothId(placementOptionId);
    try {
      const pRes = await fetch(`/api/list/batches/${id}/placement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', placementOptionId }),
      });
      const pData = await pRes.json();
      if (pData.error) throw new Error(pData.error);

      await fetchBatch();

      const tRes = await fetch(`/api/list/batches/${id}/transportation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', shipmentIds, readyToShipStart }),
      });
      const tData = await tRes.json();
      if (tData.error) throw new Error(`Transportation: ${tData.error}`);

      setConfirmingBothId(null);
      return { success: true, options: tData.options ?? [], shipments: tData.shipments ?? [] };
    } catch (err) {
      alert(`Failed: ${err}`);
      setConfirmingBothId(null);
      return { success: false, error: String(err) };
    }
  }

  async function handleConfirmTransportation(
    selections: Array<{ shipmentId: string; transportationOptionId: string }>,
    selectedOptions: any[],
  ): Promise<void> {
    if (!batch) return;
    setConfirmingBothId('transport-only');
    try {
      const res = await fetch(`/api/list/batches/${id}/transportation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', selections, selectedOptions }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await fetchBatch();
    } catch (err) {
      alert(`Confirm transportation failed: ${err}`);
    }
    setConfirmingBothId(null);
  }

  async function handleScan(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setScanned(null);
    setScanError(null);
    // Reset existing-SKU state for new scan
    setExistingSkus([]);
    setExistingSkusError(null);
    setExistingSkusLoading(false);
    setExistingSkuFilter('');
    setSelectedExistingSku(null);
    setListingMode('CREATE_NEW');
    setManualMsku('');
    setManualMskuError(null);
    try {
      const channelParam = `&channel=${batch?.channel || 'FBA'}`;
      const res = await fetch(`/api/list/catalog/search?q=${encodeURIComponent(query.trim())}${channelParam}`);
      const data = await res.json();
      if (data.error) {
        setScanError(data.error);
      } else if (data.items && data.items.length > 0) {
        const first = data.items[0] as CatalogResult;
        setScanned(first);
        setSkuManuallyEdited(false); // Reset the flag — the effect will autofill the MSKU
        // Pre-fill from historical data
        if (first.lastBuyPrice) setBuyPrice((first.lastBuyPrice / 100).toFixed(2));
        if (first.avgSalePrice) setListPrice((first.avgSalePrice / 100).toFixed(2));
        // MFN-only: pre-fill ship cost from historical average
        if (first.shippingEstimate && first.shippingEstimate.costCents > 0) {
          setShipCost((first.shippingEstimate.costCents / 100).toFixed(2));
        } else {
          setShipCost('');
        }
        // Fire non-blocking lookup for existing Seller Central MSKUs on this ASIN.
        // fetchExistingSkus manages its own loading/error state.
        fetchExistingSkus(first.asin);
      } else {
        setScanError('No matches found');
      }
    } catch (err) {
      setScanError(String(err));
    }
    setSearching(false);
  }

  async function fetchExistingSkus(asin: string) {
    setExistingSkusLoading(true);
    setExistingSkusError(null);
    setExistingSkus([]);
    setExistingSkuFilter('');
    setSelectedExistingSku(null);
    setListingMode('CREATE_NEW');
    setManualMsku('');
    setManualMskuError(null);
    try {
      const res = await fetch(`/api/list/catalog/existing-skus?asin=${encodeURIComponent(asin)}`);
      const data = await res.json();
      if (data.error && !data.skus?.length) {
        setExistingSkusError(data.error);
      } else {
        const skus: ExistingSku[] = data.skus || [];
        setExistingSkus(skus);

        // Auto-select rules (safe defaults — only for AMAZON_INVENTORY rows):
        //   1. Exactly ONE replenishable FBA MSKU from SP-API (ACTIVE or DISCOVERABLE)
        //      with an FNSKU AND no other FBA MSKUs of any kind → auto-select.
        //      DISCOVERABLE = out of stock but listing is live and replenishable.
        //   2. Everything else → show the list, require manual selection.
        const amazonFbaSkus = skus.filter(
          (s) => (s.source === 'AMAZON_INVENTORY' || s.source === 'sp-api') &&
                 s.fulfillmentChannel === 'FBA'
        );
        const replenishableFbaWithFnsku = amazonFbaSkus.filter(
          (s) => (s.listingStatus === 'ACTIVE' || s.listingStatus === 'DISCOVERABLE') && s.fnsku
        );
        if (replenishableFbaWithFnsku.length === 1 && amazonFbaSkus.length === 1) {
          const s = replenishableFbaWithFnsku[0];
          setSelectedExistingSku(s);
          setSku(s.sku);
          setSkuManuallyEdited(true);
          setListingMode('REPLENISH_EXISTING');
          if (s.listPriceCents > 0) setListPrice((s.listPriceCents / 100).toFixed(2));
        }
        // MFN auto-select (only when this batch is channel=MFN): exactly one
        // ACTIVE/DISCOVERABLE MFN MSKU from SP-API and no other MFN candidates
        // of any status. MFN listings don't have FNSKUs, so unlike the FBA
        // rule there is no FNSKU requirement. Runs after the FBA rule so MFN
        // wins when both an FBA and MFN match exist on an MFN batch.
        if (batch?.channel === 'MFN') {
          const amazonMfnSkus = skus.filter(
            (s) => (s.source === 'AMAZON_INVENTORY' || s.source === 'sp-api') &&
                   s.fulfillmentChannel === 'MFN'
          );
          const activeMfnSkus = amazonMfnSkus.filter(
            (s) => s.listingStatus === 'ACTIVE' || s.listingStatus === 'DISCOVERABLE'
          );
          if (activeMfnSkus.length === 1 && amazonMfnSkus.length === 1) {
            const s = activeMfnSkus[0];
            setSelectedExistingSku(s);
            setSku(s.sku);
            setSkuManuallyEdited(true);
            setListingMode('REPLENISH_EXISTING');
            if (s.listPriceCents > 0) setListPrice((s.listPriceCents / 100).toFixed(2));
          }
        }
        // else: multiple or ambiguous — user must pick from the list
      }
    } catch (err) {
      setExistingSkusError(`Could not load existing MSKUs: ${err}`);
    }
    setExistingSkusLoading(false);
  }

  // Re-estimate fees when the user changes the list price on a scanned item.
  // Debounced via a timeout so we don't hit the API on every keystroke.
  useEffect(() => {
    if (!scanned) return;
    const parsedListPrice = parseFloat(listPrice);
    if (!Number.isFinite(parsedListPrice) || parsedListPrice <= 0) return;
    const cents = Math.round(parsedListPrice * 100);
    // Only re-estimate if the list price is materially different from what we already have
    if (scanned.feeEstimatePriceCents && Math.abs(cents - scanned.feeEstimatePriceCents) < 50) return;

    const timer = setTimeout(async () => {
      try {
        const channelParam = `&channel=${batch?.channel || 'FBA'}`;
        const res = await fetch(`/api/list/catalog/search?q=${scanned.asin}&priceCents=${cents}${channelParam}`);
        const data = await res.json();
        if (data.items?.[0]) {
          setScanned((prev) => prev ? { ...prev, feeEstimate: data.items[0].feeEstimate, feeEstimatePriceCents: data.items[0].feeEstimatePriceCents } : prev);
        }
      } catch {
        // Leave the old estimate in place on failure
      }
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listPrice, scanned?.asin, batch?.channel]);

  async function handleAddItem() {
    if (!scanned || !sku || !buyPrice) return;
    setSaving(true);
    try {
      // Use the real per-unit fee estimate if available.
      // The backend returns a total for the list price we queried — that IS the
      // per-unit fee (the estimate was computed for a single unit at that price).
      // Scale it to the actual listPrice the user entered (linear scaling is OK
      // because referral fees are a percentage of price).
      let perUnitFeeCents = 0;
      if (scanned.feeEstimate && scanned.feeEstimatePriceCents) {
        const enteredCents = Math.round((parseFloat(listPrice) || 0) * 100);
        if (enteredCents > 0) {
          const scale = enteredCents / scanned.feeEstimatePriceCents;
          // Referral part scales; FBA part is flat
          perUnitFeeCents = Math.round(scanned.feeEstimate.referralFeeCents * scale) + scanned.feeEstimate.fbaFeeCents;
        } else {
          perUnitFeeCents = scanned.feeEstimate.totalFeeCents;
        }
      } else if (scanned.avgFeeRate && listPrice) {
        // Secondary fallback: historical rate
        perUnitFeeCents = Math.round(parseFloat(listPrice) * 100 * scanned.avgFeeRate);
      }

      const perUnitShipCents = Math.round((parseFloat(shipCost) || 0) * 100);

      const res = await fetch(`/api/list/batches/${id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asin: scanned.asin,
          sku: sku.trim(),
          productName: scanned.name,
          imageUrl: scanned.imageUrl,
          condition,
          quantity: parseInt(quantity) || 1,
          listPrice: parseFloat(listPrice) || 0,
          buyPrice: parseFloat(buyPrice) || 0,
          supplier: supplier.trim() || null,
          purchaseDate: new Date().toISOString(),
          estimatedFeeCents: perUnitFeeCents,
          estimatedShipCents: perUnitShipCents,
          listingMode,
          fnsku: selectedExistingSku?.fnsku || null,
          fulfillmentChannel: selectedExistingSku?.fulfillmentChannel || null,
          listingSource: selectedExistingSku?.source || null,
          amazonInventoryStatus: selectedExistingSku?.listingStatus || null,
        }),
      });
      const data = await res.json();
      if (data.success) {
        // Clear form for next scan
        setQuery('');
        setScanned(null);
        setScanError(null);
        setSku('');
        setSkuManuallyEdited(false);
        setBuyPrice('');
        setListPrice('');
        setShipCost('');
        setQuantity('1');
        setSupplier('');
        setCondition('NewItem');
        setExistingSkus([]);
        setExistingSkusError(null);
        setExistingSkuFilter('');
        setSelectedExistingSku(null);
        setListingMode('CREATE_NEW');
        await fetchBatch();
      } else {
        alert(`Failed to add item: ${data.error}`);
      }
    } catch (err) {
      alert(String(err));
    }
    setSaving(false);
  }

  async function handleRemoveItem(itemId: number) {
    if (!confirm('Remove this item from the batch?')) return;
    try {
      await fetch(`/api/list/batches/${id}/items/${itemId}`, { method: 'DELETE' });
      fetchBatch();
    } catch (err) {
      console.error(err);
    }
  }

  // ─── Inline edit state for batch items ──────────────────────────────────
  // Click the pencil → row enters edit mode. Save → PATCH the API. Cancel → revert.
  // PATCH only touches the batch_item row; it does NOT re-touch inventory_ledger
  // (per server behavior) so qty edits here just change the listing qty, not COGS.
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<{
    condition: string;
    quantity: string;
    buyPrice: string;
    listPrice: string;
  }>({ condition: 'NewItem', quantity: '1', buyPrice: '', listPrice: '' });
  const [savingEdit, setSavingEdit] = useState(false);

  function handleStartEdit(item: BatchItem) {
    setEditingItemId(item.id);
    setEditForm({
      condition: item.condition,
      quantity: String(item.quantity),
      buyPrice: (item.buyPriceCents / 100).toFixed(2),
      listPrice: (item.listPriceCents / 100).toFixed(2),
    });
  }

  function handleCancelEdit() {
    setEditingItemId(null);
  }

  async function handleSaveEdit(itemId: number) {
    if (!batch) return;
    setSavingEdit(true);
    try {
      // Edit scope mirrors the backend rules:
      //   draft: all fields
      //   ready/boxing/placement: only qty + buy (the FlipLedger-local fields)
      // condition + listPrice are locked post-draft to avoid silent divergence
      // from the live Amazon listing.
      const isDraft = batch.status === 'draft';
      const payload: Record<string, unknown> = {
        quantity: parseInt(editForm.quantity) || 1,
        buyPrice: parseFloat(editForm.buyPrice) || 0,
      };
      if (isDraft) {
        payload.condition = editForm.condition;
        payload.listPrice = parseFloat(editForm.listPrice) || 0;
      }

      const res = await fetch(`/api/list/batches/${id}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Edit failed: ${data.error}`);
      } else {
        setEditingItemId(null);
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setSavingEdit(false);
  }

  // ─── Live profit ticker math ──────────────────────────────────────
  const totalRevenue = items.reduce((sum, i) => sum + i.listPriceCents * i.quantity, 0);
  const totalCost = items.reduce((sum, i) => sum + i.buyPriceCents * i.quantity, 0);
  const totalFees = items.reduce((sum, i) => sum + i.estimatedFeeCents * i.quantity, 0);
  const totalShip = items.reduce((sum, i) => sum + (i.estimatedShipCents || 0) * i.quantity, 0);
  const expectedProfit = totalRevenue - totalCost - totalFees - totalShip;
  const roi = totalCost > 0 ? (expectedProfit / totalCost) * 100 : 0;
  const margin = totalRevenue > 0 ? (expectedProfit / totalRevenue) * 100 : 0;
  const totalUnits = items.reduce((sum, i) => sum + i.quantity, 0);

  // ─── Single-item preview (what the user is about to add) ─────────
  const previewQty = parseInt(quantity) || 1;
  const previewBuy = parseFloat(buyPrice) || 0;
  const previewList = parseFloat(listPrice) || 0;

  // Use real fee estimate if we have one, otherwise fall back to historical rate,
  // otherwise 15% default.
  let previewPerUnitFeeCents = 0;
  let feeSourceLabel = '';
  if (scanned?.feeEstimate && scanned.feeEstimatePriceCents) {
    const enteredCents = Math.round(previewList * 100);
    if (enteredCents > 0) {
      const scale = enteredCents / scanned.feeEstimatePriceCents;
      previewPerUnitFeeCents = Math.round(scanned.feeEstimate.referralFeeCents * scale) + scanned.feeEstimate.fbaFeeCents;
    } else {
      previewPerUnitFeeCents = scanned.feeEstimate.totalFeeCents;
    }
    feeSourceLabel = scanned.feeEstimate.source === 'sp-api' ? 'Amazon fees API'
      : scanned.feeEstimate.source === 'cache' ? 'cached estimate'
      : 'category fallback';
  } else if (scanned?.avgFeeRate) {
    previewPerUnitFeeCents = Math.round(previewList * 100 * scanned.avgFeeRate);
    feeSourceLabel = `${(scanned.avgFeeRate * 100).toFixed(1)}% historical rate`;
  } else {
    previewPerUnitFeeCents = Math.round(previewList * 100 * 0.15);
    feeSourceLabel = '15% default';
  }
  const previewFees = (previewPerUnitFeeCents * previewQty) / 100;
  const previewShipTotal = (parseFloat(shipCost) || 0) * previewQty;
  const previewProfit = previewList * previewQty - previewBuy * previewQty - previewFees - previewShipTotal;
  const previewRoi = previewBuy > 0 ? (previewProfit / (previewBuy * previewQty)) * 100 : 0;

  if (loading || !batch) {
    return (
      <div className="text-text-tertiary">Loading batch…</div>
    );
  }

  // MFN batches use the shared MFN receive workflow (the same component that
  // backs standalone /mfn/batch). batchId scopes lot creation + hydration to
  // this batch. The legacy MFN replenish UI further down the page is
  // unreachable for MFN batches via this early return.
  if (batch.channel === 'MFN') {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Link href="/list" className="p-1.5 rounded-md hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors">
              <ArrowLeft size={18} />
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight">{batch.name}</h1>
                <span className="text-xs text-text-tertiary uppercase tracking-wider">MFN</span>
              </div>
              <p className="text-xs text-text-tertiary mt-0.5">Merchant Fulfilled batch · receive · label · push</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {batch.status === 'closed' ? (
              <>
                <StatusBadge status="closed" />
                <button
                  onClick={async () => {
                    if (!confirm('Restore this batch to draft? It leaves History and becomes editable again so you can make changes or re-push.')) return;
                    try {
                      const res = await fetch(`/api/list/batches/${batch.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'draft' }),
                      });
                      const data = await res.json();
                      if (data.error) { alert(`Restore failed: ${data.error}`); return; }
                      await fetchBatch();
                    } catch (err) {
                      alert(String(err));
                    }
                  }}
                  className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-subtle text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors"
                >
                  <ArrowLeft size={14} />
                  Restore
                </button>
                <Link
                  href="/list/history"
                  className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-subtle text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors"
                >
                  <Archive size={14} />
                  History
                </Link>
              </>
            ) : (
              <>
                {batch.status === 'draft' && (
                  <Link
                    href={`/list/${batch.id}/import`}
                    className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-subtle text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors"
                  >
                    <FileUp size={14} />
                    Import Buy List
                  </Link>
                )}
                <button
                  onClick={async () => {
                    if (!confirm('Close this batch and move it to History?\n\nUse this once everything you intend to push has been pushed. Permanently-ineligible SKUs (e.g. amzn.gr. listings that can never match) are fine to leave behind — they stay in the audit record. All data stays in FlipLedger.')) return;
                    try {
                      const res = await fetch(`/api/list/batches/${batch.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'closed' }),
                      });
                      const data = await res.json();
                      if (data.error) { alert(`Close failed: ${data.error}`); return; }
                      window.location.href = '/list/history';
                    } catch (err) {
                      alert(String(err));
                    }
                  }}
                  className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-subtle text-text-secondary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors"
                >
                  <Archive size={14} />
                  Close Batch
                </button>
              </>
            )}
          </div>
        </div>
        <MfnBatchReceiveWorkflow batchId={batch.id} locked={batch.status === 'closed'} />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Link href="/list" className="p-1.5 rounded-md hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{batch.name}</h1>
              <StatusBadge status={batch.status} />
              <span className="text-xs text-text-tertiary uppercase tracking-wider">{batch.channel}</span>
            </div>
            <p className="text-xs text-text-tertiary mt-0.5">Created {new Date(batch.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
          </div>
        </div>

        {/* Right-side actions */}
        <div className="flex items-center gap-2">
          {batch.status === 'draft' && (
            <Link
              href={`/list/${batch.id}/import`}
              className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-subtle text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors"
            >
              <FileUp size={14} />
              Import Buy List
            </Link>
          )}
          {batch.status === 'draft' && items.length > 0 && (
            <button
              onClick={() => setShowSendModal(true)}
              className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 transition-colors"
            >
              <Send size={14} />
              {batch.channel === 'FBA' ? 'Send to Amazon' : 'Publish to Amazon'}
            </button>
          )}
          {batch.status === 'ready' && batch.channel === 'FBA' && batch.inboundPlanId && (
            <>
              {/* FNSKU labels — split-button: per-SKU (default) + dropdown for per-unit */}
              <div className="relative">
                <FnskuPrintButton
                  printing={printingFnsku}
                  onPrint={(mode) => handlePrintFnskuLabels('print', mode)}
                  onDownload={(mode) => handlePrintFnskuLabels('download', mode)}
                />
              </div>
              <button
                onClick={initializeDefaultBoxes}
                disabled={initializingBoxing}
                className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
                title="Box the items and generate Amazon placement options in FlipLedger. Asks Amazon how to split items into pack groups (~5-30s)."
              >
                {initializingBoxing ? <Loader2 size={14} className="animate-spin" /> : <BoxIcon size={14} />}
                {initializingBoxing ? 'Loading pack groups…' : 'Box & Ship'}
              </button>
              <a
                href="https://sellercentral.amazon.com/fba/inboundshipments"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                title="Alternative: finish in Seller Central instead"
              >
                <ExternalLink size={14} /> Seller Central
              </a>
            </>
          )}
          {(batch.status === 'boxing' || batch.status === 'placement' || batch.status === 'sending') && batch.channel === 'FBA' && batch.inboundPlanId && (
            <>
              <button
                onClick={handleSyncFromAmazon}
                disabled={syncingFromAmazon}
                className="flex items-center gap-2 h-9 px-3 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
                title="Pull the current batch state from Amazon. Use after finishing packing/placement in Seller Central."
              >
                {syncingFromAmazon ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                {syncingFromAmazon ? 'Syncing…' : 'Sync from Amazon'}
              </button>
              <a
                href="https://sellercentral.amazon.com/fba/inboundshipments"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                title="Finish in Seller Central instead"
              >
                <ExternalLink size={14} /> Seller Central
              </a>
            </>
          )}
          {batch.status === 'ready' && batch.channel === 'MFN' && (
            <a
              href="https://sellercentral.amazon.com/inventory"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 h-9 px-4 bg-positive text-white rounded-md text-sm font-medium hover:bg-positive/90 transition-colors"
            >
              <ExternalLink size={14} /> View in Seller Central
            </a>
          )}
          {/* Cancel & Edit — unlocks ready/boxing/placement/failed batches for re-editing.
              For ready+ states: cancels the inbound plan on Amazon (listings stay).
              For failed state: just resets local DB (no plan was created).
              For sending: escape hatch for a wedged send — the API rejects it
              with a friendly message if the send might still be running (<30 min).
              MFN batches get the failed/sending reset too (no plan to cancel). */}
          {(
            (batch.channel === 'FBA' && ['ready', 'boxing', 'placement', 'failed', 'sending'].includes(batch.status)) ||
            (batch.channel === 'MFN' && ['failed', 'sending'].includes(batch.status))
          ) && (
            <button
              onClick={handleCancelAndEdit}
              disabled={cancelling}
              className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-amber-500/30 rounded-md text-sm text-amber-400 hover:bg-amber-500/10 disabled:opacity-50 transition-colors"
              title={batch.status === 'failed'
                ? 'Reset to draft so you can fix issues (remove items, edit qty) and try sending again.'
                : batch.status === 'sending'
                ? 'If this send looks stuck, reset the batch to draft and re-send. Only works once the send can no longer be running (30+ min).'
                : 'Cancel the inbound plan on Amazon and reset this batch to draft so you can add items / fix mistakes and re-send. Listings stay live on Amazon — no money lost.'}
            >
              {cancelling ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />}
              {cancelling ? 'Cancelling…' : (batch.status === 'failed' || batch.status === 'sending' ? 'Reset & Edit' : 'Cancel & Edit')}
            </button>
          )}
          {/* 'shipping' close is the manual fallback for batches the 6h
              auto-reconcile can't track (no confirmation IDs stored) or when
              the user knows a shipment is done/dead before Amazon says so. */}
          {(batch.status === 'ready' || batch.status === 'failed' || batch.status === 'shipping') && (
            <button
              onClick={handleCloseBatch}
              className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
              title="Archive this batch — no more changes, but all data is preserved"
            >
              <Archive size={14} /> Close Batch
            </button>
          )}
        </div>
      </div>

      {/* Send status card — visible while sending or after send */}
      {(batch.status === 'sending' || batch.status === 'ready' || batch.status === 'failed') && (
        <SendStatusCard
          batch={batch}
          items={items}
          debugItems={debugItems}
          onRefresh={pollStatus}
          onForceReady={handleForceReady}
        />
      )}

      {/* Phase 3: Boxing workflow — visible while boxing/placement/shipping */}
      {(batch.status === 'boxing' || batch.status === 'placement' || batch.status === 'shipping' || (batch.status === 'ready' && boxes.length > 0)) && (
        <BoxingWorkflow
          batch={batch}
          items={items}
          boxes={boxes}
          packGroups={packGroups}
          placementOptions={placementOptions}
          placementMapData={placementMapData}
          placementDebug={placementDebug}
          hoveredOptionId={hoveredOptionId}
          onHoverOption={setHoveredOptionId}
          savingBoxes={savingBoxes}
          packing={packing}
          loadingPlacement={loadingPlacement}
          confirmingPlacementId={confirmingPlacementId}
          onAddBox={addEmptyBox}
          onRemoveBox={removeBoxAt}
          onDuplicateBox={duplicateBoxAt}
          onUpdateBoxField={updateBoxField}
          onSetBoxItemQty={setBoxItemQty}
          onSaveBoxes={handleSaveBoxes}
          onConfirmPacking={handleConfirmPacking}
          onGeneratePlacement={handleGeneratePlacement}
          onLoadPlacement={handleLoadPlacement}
          onConfirmPlacement={handleConfirmPlacement}
          onConfirmPlacementAndLoadTransport={handleConfirmPlacementAndLoadTransport}
          onConfirmTransportation={handleConfirmTransportation}
          confirmingBothId={confirmingBothId}
        />
      )}

      {/* Live profit ticker */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest uppercase text-text-tertiary">
            <Package size={12} /> Units
          </div>
          <div className="text-xl font-semibold text-text-primary mt-1">{totalUnits}</div>
          <div className="text-[11px] text-text-tertiary">{items.length} SKU{items.length === 1 ? '' : 's'}</div>
        </div>
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest uppercase text-text-tertiary">
            <DollarSign size={12} /> Expected Revenue
          </div>
          <div className="text-xl font-semibold text-text-primary mt-1">{formatCurrency(totalRevenue)}</div>
        </div>
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-3">
          <div className="text-[10px] font-medium tracking-widest uppercase text-text-tertiary">Cost + Fees{totalShip > 0 ? ' + Ship' : ''}</div>
          <div className="text-xl font-semibold text-text-secondary mt-1">{formatCurrency(totalCost + totalFees + totalShip)}</div>
          <div className="text-[11px] text-text-tertiary">
            {formatCurrency(totalCost)} cost · {formatCurrency(totalFees)} fees
            {totalShip > 0 && <> · {formatCurrency(totalShip)} ship</>}
          </div>
        </div>
        <div className="bg-bg-surface border border-accent/30 rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest uppercase text-accent">
            <TrendingUp size={12} /> Expected Profit
          </div>
          <div className={`text-xl font-semibold mt-1 ${expectedProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
            {formatCurrency(expectedProfit)}
          </div>
          <div className="text-[11px] text-text-tertiary">{margin.toFixed(1)}% margin</div>
        </div>
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest uppercase text-text-tertiary">
            <Percent size={12} /> ROI
          </div>
          <div className={`text-xl font-semibold mt-1 ${roi >= 30 ? 'text-positive' : roi >= 0 ? 'text-text-primary' : 'text-negative'}`}>
            {roi.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Scan / add item form */}
      {batch.status === 'draft' && (
        <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden mb-5">
          <div className="px-4 py-3 border-b border-border-subtle">
            <h2 className="text-sm font-medium">Scan / Search Product</h2>
            <p className="text-[11px] text-text-tertiary mt-0.5">Enter ASIN, UPC/EAN, or keywords</p>
          </div>
          <div className="p-4 space-y-4">
            <form onSubmit={handleScan} className="flex gap-2">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="B0CNJ7G8CP or 045496597818"
                  autoFocus
                  className="w-full h-10 pl-9 pr-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary focus:outline-none focus:border-accent font-mono"
                />
              </div>
              <button
                type="submit"
                disabled={!query.trim() || searching}
                className="h-10 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
              >
                {searching ? 'Searching…' : 'Scan'}
              </button>
            </form>

            {scanError && (
              <div className="text-sm text-negative">{scanError}</div>
            )}

            {pendingDraftRestored && (
              <div className="flex items-start gap-2 rounded-md border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-text-secondary">
                <AlertCircle size={14} className="mt-0.5 shrink-0 text-accent" />
                <div>
                  Restored an unsaved product entry for this batch. Click Add to Batch when it is ready.
                </div>
              </div>
            )}

            {scanned && (
              <div className="border border-border-subtle rounded-lg overflow-hidden">
                {/* Product header */}
                <div className="flex items-start gap-4 p-4 bg-bg-elevated">
                  {scanned.imageUrl ? (
                    <button
                      type="button"
                      onClick={() => scanned.imageUrl && setLightbox({ src: scanned.imageUrl, title: scanned.name || scanned.asin, asin: scanned.asin, sku: null })}
                      className="shrink-0 rounded-lg overflow-hidden bg-white border border-border-subtle hover:ring-2 hover:ring-accent/40 transition-shadow"
                      title="View larger"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={scanned.imageUrl} alt={scanned.name || ''} className="w-24 h-24 object-contain block p-1.5" />
                    </button>
                  ) : (
                    <div className="w-24 h-24 rounded-lg bg-bg-hover flex items-center justify-center">
                      <Package size={28} className="text-text-tertiary" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-base font-medium text-text-primary line-clamp-2">{scanned.name}</div>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-text-tertiary font-mono">
                      <AsinLink asin={scanned.asin} className="hover:text-accent hover:underline" />
                      {scanned.brand && <span>· {scanned.brand}</span>}
                      <span className={`ml-auto px-1.5 py-0.5 rounded ${scanned.source === 'local' ? 'bg-positive/10 text-positive' : 'bg-accent/10 text-accent'}`}>
                        {scanned.source === 'local' ? 'IN YOUR CATALOG' : 'FROM AMAZON'}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 mt-2 text-[11px]">
                      <div>
                        <span className="text-text-tertiary">Avg sale: </span>
                        <span className="text-text-primary font-mono">{scanned.avgSalePrice ? formatCurrency(scanned.avgSalePrice) : '—'}</span>
                      </div>
                      <div>
                        <span className="text-text-tertiary">Est. fees: </span>
                        {scanned.feeEstimate ? (
                          <span className="text-text-primary font-mono" title={`Referral: ${formatCurrency(scanned.feeEstimate.referralFeeCents)}${scanned.feeEstimate.fbaFeeCents ? ' · FBA: ' + formatCurrency(scanned.feeEstimate.fbaFeeCents) : ''} · ${scanned.feeEstimate.source}`}>
                            {formatCurrency(scanned.feeEstimate.totalFeeCents)}
                          </span>
                        ) : (
                          <span className="text-text-tertiary font-mono">—</span>
                        )}
                      </div>
                      <div>
                        <span className="text-text-tertiary">Sold 30d: </span>
                        <span className="text-text-primary font-mono">{scanned.unitsSoldLast30d ?? 0}</span>
                      </div>
                      <div>
                        <span className="text-text-tertiary">{batch.channel === 'MFN' ? 'Amazon qty: ' : 'FBA stock: '}</span>
                        <span className="text-text-primary font-mono">{scanned.currentFbaStock ?? 0}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Existing Seller Central MSKUs */}
                {(existingSkusLoading || existingSkus.length > 0 || existingSkusError) && (
                  <div className="border-t border-border-subtle p-4">
                    <div className="text-[10px] uppercase tracking-widest text-text-tertiary mb-2 flex items-center gap-2">
                      Existing Seller Central MSKUs
                      {existingSkusLoading && <Loader2 size={10} className="animate-spin" />}
                    </div>

                    {existingSkusLoading && (
                      <div className="text-xs text-text-tertiary">Checking Seller Central…</div>
                    )}

                    {existingSkusError && !existingSkusLoading && (
                      <div className="text-xs text-negative space-y-1">
                        <div>{existingSkusError}</div>
                        <div className="flex gap-3">
                          <button onClick={() => scanned && fetchExistingSkus(scanned.asin)} className="text-accent hover:underline">Retry lookup</button>
                          <button onClick={() => { setExistingSkusError(null); setListingMode('CREATE_NEW'); }} className="text-text-tertiary hover:underline">Create new MSKU instead</button>
                        </div>
                      </div>
                    )}

                    {!existingSkusLoading && existingSkus.length === 0 && !existingSkusError && (
                      <div className="space-y-2">
                        <div className="text-xs text-text-tertiary">
                          No existing Seller Central MSKUs found automatically for this ASIN.
                          If you have an existing MSKU, enter it below to verify against Seller Central.
                        </div>
                        <div className="flex gap-2 items-center">
                          <input
                            type="text"
                            value={manualMsku}
                            onChange={(e) => { setManualMsku(e.target.value); setManualMskuError(null); }}
                            placeholder="Enter MSKU (e.g. LV_01FAFLIP_040126_…)"
                            className="flex-1 text-xs font-mono border border-border-subtle rounded px-2 py-1 bg-surface text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
                            onKeyDown={async (e) => {
                              if (e.key === 'Enter' && manualMsku.trim() && scanned?.asin) {
                                e.preventDefault();
                                setManualMskuVerifying(true);
                                setManualMskuError(null);
                                try {
                                  const res = await fetch(`/api/list/catalog/verify-msku?asin=${encodeURIComponent(scanned.asin)}&sku=${encodeURIComponent(manualMsku.trim())}`);
                                  const data = await res.json();
                                  if (!res.ok) { setManualMskuError(data.error || 'Verification failed'); return; }
                                  setExistingSkus([data]);
                                  setSelectedExistingSku(data);
                                  setListingMode('REPLENISH_EXISTING');
                                  setSku(data.sku);
                                  setManualMsku('');
                                } catch (err) {
                                  setManualMskuError(String(err));
                                } finally {
                                  setManualMskuVerifying(false);
                                }
                              }
                            }}
                          />
                          <button
                            disabled={!manualMsku.trim() || manualMskuVerifying}
                            onClick={async () => {
                              if (!manualMsku.trim() || !scanned?.asin) return;
                              setManualMskuVerifying(true);
                              setManualMskuError(null);
                              try {
                                const res = await fetch(`/api/list/catalog/verify-msku?asin=${encodeURIComponent(scanned.asin)}&sku=${encodeURIComponent(manualMsku.trim())}`);
                                const data = await res.json();
                                if (!res.ok) { setManualMskuError(data.error || 'Verification failed'); return; }
                                setExistingSkus([data]);
                                setSelectedExistingSku(data);
                                setListingMode('REPLENISH_EXISTING');
                                setSku(data.sku);
                                setManualMsku('');
                              } catch (err) {
                                setManualMskuError(String(err));
                              } finally {
                                setManualMskuVerifying(false);
                              }
                            }}
                            className="text-xs px-2 py-1 rounded border border-border-subtle bg-surface text-text-primary hover:bg-surface-hover disabled:opacity-40 whitespace-nowrap"
                          >
                            {manualMskuVerifying ? 'Verifying…' : 'Verify'}
                          </button>
                        </div>
                        {manualMskuError && (
                          <div className="text-xs text-negative">{manualMskuError}</div>
                        )}
                        <div className="text-[10px] text-text-tertiary">Or proceed without selecting an existing MSKU to create a new one.</div>
                      </div>
                    )}

                    {existingSkus.length > 0 && (() => {
                      // Separate AMAZON_INVENTORY (replenishable) from LOCAL_DB (historical context only).
                      const isAmazonSource = (s: ExistingSku) =>
                        s.source === 'AMAZON_INVENTORY' || s.source === 'sp-api';
                      const amazonSkus = existingSkus.filter(isAmazonSource);
                      const localOnlySkus = existingSkus.filter((s) => !isAmazonSource(s));

                      // Ambiguous = multiple replenishable FBA candidates from Amazon (user must choose).
                      const replenishableFbaSkus = amazonSkus.filter(
                        (s) => s.fulfillmentChannel === 'FBA' &&
                               (s.listingStatus === 'ACTIVE' || s.listingStatus === 'DISCOVERABLE')
                      );
                      const isAmbiguous = replenishableFbaSkus.length > 1 ||
                        (replenishableFbaSkus.length === 0 && amazonSkus.length > 0);

                      const filterLower = existingSkuFilter.toLowerCase();
                      const applyFilter = (rows: ExistingSku[]) => existingSkuFilter
                        ? rows.filter((s) => s.sku.toLowerCase().includes(filterLower))
                        : rows;
                      const displayedAmazon = applyFilter(amazonSkus);
                      const displayedLocal = applyFilter(localOnlySkus);

                      const skuStatusLabel = (s: ExistingSku): { label: string; color: string } => {
                        if (s.listingStatus === 'ACTIVE') {
                          if (s.fulfillmentChannel === 'FBA') {
                            return { label: s.fbaStock > 0 ? 'ACTIVE FBA' : 'OUT OF STOCK / ACTIVE FBA', color: 'bg-positive/10 text-positive' };
                          }
                          return { label: 'ACTIVE MFN', color: 'bg-positive/10 text-positive' };
                        }
                        if (s.listingStatus === 'DISCOVERABLE') {
                          return s.fulfillmentChannel === 'MFN'
                            ? { label: 'Active · OOS', color: 'bg-accent/10 text-accent' }
                            : { label: 'OUT OF STOCK / ACTIVE REPLENISHABLE', color: 'bg-accent/10 text-accent' };
                        }
                        if (s.listingStatus === 'SUPPRESSED') return { label: 'SUPPRESSED', color: 'bg-negative/10 text-negative' };
                        if (s.listingStatus === 'INCOMPLETE') return { label: 'INCOMPLETE', color: 'bg-amber-500/10 text-amber-400' };
                        if (s.listingStatus === 'INACTIVE') return { label: 'INACTIVE', color: 'bg-text-tertiary/10 text-text-tertiary' };
                        return { label: s.listingStatus || 'UNKNOWN', color: 'bg-text-tertiary/10 text-text-tertiary' };
                      };

                      const renderSkuRow = (s: ExistingSku, selectable: boolean) => {
                        const { label: statusLabel, color: statusColor } = skuStatusLabel(s);

                        const isSelected = selectedExistingSku?.sku === s.sku;
                        return (
                          <div
                            key={s.sku}
                            className={`flex items-start gap-3 p-2.5 rounded border text-xs transition-colors ${
                              selectable ? 'cursor-pointer' : 'cursor-default opacity-60'
                            } ${
                              isSelected
                                ? 'border-positive/50 bg-positive/5'
                                : selectable
                                  ? 'border-border-default bg-bg-elevated hover:border-accent/40'
                                  : 'border-border-subtle bg-bg-elevated'
                            }`}
                            onClick={() => {
                              if (!selectable) return;
                              setSelectedExistingSku(s);
                              setSku(s.sku);
                              setSkuManuallyEdited(true);
                              setListingMode('REPLENISH_EXISTING');
                              if (s.listPriceCents > 0) setListPrice((s.listPriceCents / 100).toFixed(2));
                            }}
                          >
                            <div className="flex-1 min-w-0">
                              <MskuLink sku={s.sku} className="font-mono text-text-primary break-all hover:text-accent hover:underline" />
                              <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                                <span className={`px-1 py-0.5 rounded text-[9px] font-semibold ${statusColor}`}>
                                  {statusLabel}
                                </span>
                                {/* Source tag — always visible.
                                    For MFN-channel rows the source is shown as
                                    "Seller Central" rather than the internal
                                    "AMAZON_INVENTORY" identifier. */}
                                <span className={`px-1 py-0.5 rounded text-[9px] font-semibold ${
                                  isAmazonSource(s)
                                    ? 'bg-accent/15 text-accent'
                                    : 'bg-text-tertiary/15 text-text-tertiary'
                                }`}>
                                  {isAmazonSource(s)
                                    ? (s.fulfillmentChannel === 'MFN' ? 'Seller Central' : 'AMAZON_INVENTORY')
                                    : 'LOCAL_DB'}
                                </span>
                                {s.conditionType && (
                                  <span className="text-text-tertiary">{s.conditionType.replace(/_/g, ' ')}</span>
                                )}
                                <span className="text-text-tertiary">· stock: {s.fbaStock}</span>
                                {s.listPriceCents > 0 && (
                                  <span className="text-text-tertiary">· {formatCurrency(s.listPriceCents)}</span>
                                )}
                                {s.fnsku ? (
                                  <span className="font-mono text-[10px] text-text-tertiary">FNSKU: {s.fnsku}</span>
                                ) : (
                                  <span className="text-[10px] text-amber-400">no FNSKU</span>
                                )}
                              </div>
                            </div>
                            {selectable && (isSelected ? (
                              <span className="text-positive text-[10px] font-semibold whitespace-nowrap flex items-center gap-1 shrink-0 mt-0.5">
                                <CheckCircle size={11} /> Selected
                              </span>
                            ) : (
                              <span className="text-[11px] text-accent whitespace-nowrap shrink-0 mt-0.5">Select</span>
                            ))}
                          </div>
                        );
                      };

                      return (
                        <div className="space-y-2">
                          {/* Amber prompt when multiple replenishable FBA candidates exist */}
                          {isAmbiguous && listingMode !== 'REPLENISH_EXISTING' && amazonSkus.length > 0 && (
                            <div className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2.5 py-1.5">
                              {amazonSkus.length} Seller Central MSKUs found for this ASIN. Select the one you want to replenish, or create a new MSKU.
                            </div>
                          )}

                          {/* Search filter */}
                          {existingSkus.length > 2 && (
                            <input
                              value={existingSkuFilter}
                              onChange={(e) => setExistingSkuFilter(e.target.value)}
                              placeholder="Filter by SKU…"
                              className="w-full h-8 px-2 bg-bg-elevated border border-border-default rounded text-xs font-mono focus:outline-none focus:border-accent"
                            />
                          )}

                          {displayedAmazon.length === 0 && displayedLocal.length === 0 && existingSkuFilter && (
                            <div className="text-xs text-negative">
                              No MSKU matching &ldquo;{existingSkuFilter}&rdquo; found in results.
                              Paste the exact Seller Central SKU above to filter.
                            </div>
                          )}

                          {/* AMAZON_INVENTORY rows — selectable for replenishment */}
                          {displayedAmazon.length > 0 && (
                            <div className="space-y-1.5">
                              {displayedAmazon.map((s) => renderSkuRow(s, true))}
                            </div>
                          )}

                          {/* LOCAL_DB rows — historical context only, not selectable */}
                          {displayedLocal.length > 0 && (
                            <div className="mt-2">
                              <div className="text-[9px] uppercase tracking-widest text-text-tertiary mb-1.5">
                                Historical local SKUs (cached — not confirmed live in Seller Central)
                              </div>
                              <div className="space-y-1.5">
                                {displayedLocal.map((s) => renderSkuRow(s, false))}
                              </div>
                            </div>
                          )}

                          {/* Selected SKU summary — channel-aware presentation.
                              MFN+REPLENISH uses an "Replenish existing MFN listing" panel that
                              surfaces ASIN/MSKU as clickable links, current Amazon qty/status/price,
                              and a soft note about reusing existing inventory. Other modes keep
                              the original "Selected for replenishment" panel. */}
                          {selectedExistingSku && (() => {
                            const isMfnReplenish = batch?.channel === 'MFN'
                              && listingMode === 'REPLENISH_EXISTING'
                              && selectedExistingSku.fulfillmentChannel === 'MFN';
                            const qtyLabel = selectedExistingSku.fulfillmentChannel === 'MFN'
                              ? 'Amazon qty' : 'FBA stock';
                            const heading = isMfnReplenish
                              ? 'Replenish existing MFN listing'
                              : 'Selected for replenishment';
                            return (
                              <div className="mt-1 bg-positive/5 border border-positive/20 rounded p-2.5 text-[11px]">
                                <div className="text-positive font-semibold mb-1">{heading}</div>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-text-primary">
                                  <span className="text-text-tertiary">MSKU:</span>
                                  <MskuLink sku={selectedExistingSku.sku} className="break-all hover:text-accent hover:underline" />
                                  <span className="text-text-tertiary">ASIN:</span>
                                  {selectedExistingSku.asin
                                    ? <AsinLink asin={selectedExistingSku.asin} className="hover:text-accent hover:underline" />
                                    : <span>—</span>}
                                  {!isMfnReplenish && (
                                    <>
                                      <span className="text-text-tertiary">FNSKU:</span>
                                      <span>{selectedExistingSku.fnsku || '—'}</span>
                                      <span className="text-text-tertiary">Channel:</span>
                                      <span>{selectedExistingSku.fulfillmentChannel}</span>
                                    </>
                                  )}
                                  <span className="text-text-tertiary">Status:</span>
                                  <span>{skuStatusLabel(selectedExistingSku).label}</span>
                                  <span className="text-text-tertiary">{qtyLabel}:</span>
                                  <span>{selectedExistingSku.fbaStock}</span>
                                  {selectedExistingSku.listPriceCents > 0 && (
                                    <><span className="text-text-tertiary">List price:</span><span>{formatCurrency(selectedExistingSku.listPriceCents)}</span></>
                                  )}
                                </div>
                                {isMfnReplenish && (
                                  <div className="mt-2 text-[10px] text-text-tertiary italic">
                                    Links to existing inventory when available.
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          <div className="flex gap-3 mt-1">
                            {listingMode === 'REPLENISH_EXISTING' && (
                              <button
                                onClick={() => { setSelectedExistingSku(null); setListingMode('CREATE_NEW'); setSkuManuallyEdited(false); setSku(''); }}
                                className="text-[11px] text-text-tertiary hover:text-text-secondary"
                              >
                                Create new MSKU instead
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Entry grid */}
                <div className="p-4 grid grid-cols-2 lg:grid-cols-6 gap-3">
                  <div className="col-span-2">
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary flex items-center gap-1">
                      MSKU
                      {listingMode === 'REPLENISH_EXISTING' ? (
                        <span className="text-[9px] text-positive font-semibold normal-case tracking-normal">replenish</span>
                      ) : !skuManuallyEdited && supplier && buyPrice ? (
                        <span className="text-[9px] text-accent/70 normal-case tracking-normal">auto</span>
                      ) : null}
                    </label>
                    <input
                      value={sku}
                      readOnly={listingMode === 'REPLENISH_EXISTING'}
                      onChange={(e) => { setSku(e.target.value); setSkuManuallyEdited(true); }}
                      className={`w-full mt-1 h-9 px-2 bg-bg-elevated border rounded text-sm font-mono focus:outline-none focus:border-accent ${
                        listingMode === 'REPLENISH_EXISTING'
                          ? 'border-positive/40 text-positive cursor-default'
                          : 'border-border-default'
                      }`}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary">Condition</label>
                    <select
                      value={condition}
                      onChange={(e) => setCondition(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm focus:outline-none focus:border-accent"
                    >
                      <option value="NewItem">New</option>
                      <option value="UsedLikeNew">Used - Like New</option>
                      <option value="UsedVeryGood">Used - Very Good</option>
                      <option value="UsedGood">Used - Good</option>
                      <option value="UsedAcceptable">Used - Acceptable</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary">Qty</label>
                    <input
                      type="number"
                      min="1"
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm font-mono focus:outline-none focus:border-accent"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary">Buy Price ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={buyPrice}
                      onChange={(e) => setBuyPrice(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm font-mono focus:outline-none focus:border-accent"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary">List Price ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={listPrice}
                      onChange={(e) => setListPrice(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm font-mono focus:outline-none focus:border-accent"
                    />
                  </div>
                  {batch.channel === 'MFN' && (
                    <div>
                      <label className="text-[10px] uppercase tracking-widest text-text-tertiary flex items-center gap-1">
                        Ship Cost ($)
                        {scanned.shippingEstimate && scanned.shippingEstimate.source !== 'none' && (
                          <span className="text-[9px] text-accent/70 normal-case tracking-normal">
                            {scanned.shippingEstimate.source === 'per-asin' ? 'asin avg' : 'mkt avg'}
                          </span>
                        )}
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        value={shipCost}
                        onChange={(e) => setShipCost(e.target.value)}
                        placeholder="0.00"
                        className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm font-mono focus:outline-none focus:border-accent"
                      />
                    </div>
                  )}
                  <div className={batch.channel === 'MFN' ? 'col-span-1' : 'col-span-2'}>
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary">Supplier</label>
                    <input
                      value={supplier}
                      onChange={(e) => setSupplier(e.target.value)}
                      placeholder="Walmart, Target, …"
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm focus:outline-none focus:border-accent"
                    />
                  </div>

                  {/* Per-item preview */}
                  <div className="col-span-6 border-t border-border-subtle pt-3 mt-1 flex items-center justify-between">
                    <div className="text-xs text-text-tertiary">
                      Projected: <span className={`font-mono ${previewProfit >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(Math.round(previewProfit * 100))}</span>{' '}
                      profit · <span className="text-text-primary font-mono">{previewRoi.toFixed(1)}%</span> ROI{' '}
                      · fees <span className="text-text-primary font-mono">{formatCurrency(previewPerUnitFeeCents * previewQty)}</span>
                      {previewShipTotal > 0 && (
                        <> · ship <span className="text-text-primary font-mono">{formatCurrency(Math.round(previewShipTotal * 100))}</span></>
                      )}
                      <span className="ml-1 text-text-tertiary">({feeSourceLabel})</span>
                    </div>
                    <button
                      onClick={handleAddItem}
                      disabled={!sku || !buyPrice || saving}
                      className="h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                    >
                      <Plus size={14} />
                      {saving
                        ? 'Adding…'
                        : batch.channel === 'MFN' && listingMode === 'REPLENISH_EXISTING'
                          ? 'Add Replenish Item'
                          : batch.channel === 'MFN'
                            ? 'Add to MFN Batch'
                            : 'Add to Batch'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Items table */}
      <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Batch Items</span>
            <span className="text-xs text-text-tertiary">({items.length})</span>
          </div>
        </div>
        {items.length === 0 ? (
          <div className="p-8 text-center text-text-tertiary text-sm">
            No items yet. Scan a product above to get started.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-elevated">
                  <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle">Product</th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-28">Condition</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-16">Qty</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Buy</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">List</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Est. Fees</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-28">Est. Profit</th>
                  <th className="px-2 py-2.5 border-b border-border-subtle w-10"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isEditing = editingItemId === item.id;
                  // Use either committed values or in-flight edit values for the math.
                  const editQty = isEditing ? (parseInt(editForm.quantity) || 0) : item.quantity;
                  const editBuy = isEditing ? Math.round((parseFloat(editForm.buyPrice) || 0) * 100) : item.buyPriceCents;
                  const editList = isEditing ? Math.round((parseFloat(editForm.listPrice) || 0) * 100) : item.listPriceCents;
                  const rev = editList * editQty;
                  const cost = editBuy * editQty;
                  const fees = item.estimatedFeeCents * editQty;
                  const ship = (item.estimatedShipCents || 0) * editQty;
                  const profit = rev - cost - fees - ship;
                  return (
                    <tr
                      key={item.id}
                      className={`border-b border-border-subtle/50 transition-colors ${
                        isEditing
                          ? 'bg-accent/5'
                          : item.labelsPrintedAt
                            ? 'bg-positive/10 hover:bg-positive/15'  // labeled = green tint
                            : 'hover:bg-bg-hover'
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {item.imageUrl ? (
                            <button
                              type="button"
                              onClick={() => item.imageUrl && setLightbox({ src: item.imageUrl, title: item.productName || item.asin, asin: item.asin, sku: item.sku })}
                              className="shrink-0 rounded-lg overflow-hidden bg-white border border-border-subtle hover:ring-2 hover:ring-accent/40 transition-shadow"
                              title="View larger"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={item.imageUrl} alt="" className="w-14 h-14 object-contain block p-1" />
                            </button>
                          ) : (
                            <div className="w-14 h-14 rounded-lg bg-bg-hover shrink-0 flex items-center justify-center">
                              <Package size={18} className="text-text-tertiary" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <a
                              href={`https://www.amazon.com/dp/${item.asin}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-base text-text-primary hover:text-accent hover:underline truncate max-w-[400px] block"
                              title={item.productName || ''}
                            >
                              {item.productName || item.asin}
                            </a>
                            <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary font-mono">
                              <MskuLink sku={item.sku} className="hover:text-accent hover:underline" />
                              {item.listingStatus === 'ACTIVE' && (
                                <span className="text-[9px] text-positive bg-positive/10 px-1 rounded">LIVE</span>
                              )}
                              {item.listingStatus === 'PROCESSING' && (
                                <span className="text-[9px] text-accent bg-accent/10 px-1 rounded">PROCESSING</span>
                              )}
                              {item.listingStatus === 'FAILED' && (
                                <span className="text-[9px] text-negative bg-negative/10 px-1 rounded">FAILED</span>
                              )}
                            </div>
                            {/* Inline warning / error message — always visible, not a tooltip */}
                            {item.listingError && (
                              <div
                                className={`text-[11px] mt-0.5 leading-snug ${
                                  item.listingStatus === 'FAILED' ? 'text-negative' : 'text-amber-400'
                                }`}
                              >
                                {item.listingStatus === 'FAILED' ? '⛔ ' : '⚠ '}
                                {item.listingError}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      {/* Condition — only editable in draft (post-draft would silently diverge from live Amazon listing) */}
                      <td className="px-4 py-2 text-xs text-text-secondary">
                        {isEditing && batch.status === 'draft' ? (
                          <select
                            value={editForm.condition}
                            onChange={(e) => setEditForm({ ...editForm, condition: e.target.value })}
                            className="w-full h-7 px-1 bg-bg-elevated border border-border-default rounded text-xs focus:outline-none focus:border-accent"
                          >
                            <option value="NewItem">New</option>
                            <option value="UsedLikeNew">Used - Like New</option>
                            <option value="UsedVeryGood">Used - Very Good</option>
                            <option value="UsedGood">Used - Good</option>
                            <option value="UsedAcceptable">Used - Acceptable</option>
                          </select>
                        ) : (
                          item.condition.replace(/([A-Z])/g, ' $1').trim()
                        )}
                      </td>
                      {/* Qty */}
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">
                        {isEditing ? (
                          <input
                            type="number"
                            min="1"
                            value={editForm.quantity}
                            onChange={(e) => setEditForm({ ...editForm, quantity: e.target.value })}
                            className="w-14 h-7 px-1 text-right bg-bg-elevated border border-border-default rounded text-xs font-mono focus:outline-none focus:border-accent"
                          />
                        ) : item.quantity}
                      </td>
                      {/* Buy — editable, FlipLedger-local (affects FIFO/COGS, not Amazon) */}
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">
                        {isEditing ? (
                          <input
                            type="number"
                            step="0.01"
                            value={editForm.buyPrice}
                            onChange={(e) => setEditForm({ ...editForm, buyPrice: e.target.value })}
                            className="w-20 h-7 px-1 text-right bg-bg-elevated border border-border-default rounded text-xs font-mono focus:outline-none focus:border-accent"
                          />
                        ) : formatCurrency(cost)}
                      </td>
                      {/* List — only editable in draft (post-draft would silently diverge from live Amazon listing) */}
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-primary">
                        {isEditing && batch.status === 'draft' ? (
                          <input
                            type="number"
                            step="0.01"
                            value={editForm.listPrice}
                            onChange={(e) => setEditForm({ ...editForm, listPrice: e.target.value })}
                            className="w-20 h-7 px-1 text-right bg-bg-elevated border border-border-default rounded text-xs font-mono focus:outline-none focus:border-accent"
                          />
                        ) : formatCurrency(rev)}
                      </td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-negative">
                        {fees + ship > 0 ? (
                          <>
                            {formatCurrency(-(fees + ship))}
                            {ship > 0 && (
                              <div className="text-[10px] text-text-tertiary font-normal">
                                {formatCurrency(-fees)} fees · {formatCurrency(-ship)} ship
                              </div>
                            )}
                          </>
                        ) : '—'}
                      </td>
                      <td className={`px-4 py-2 text-right text-sm font-mono font-medium ${profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {formatCurrency(profit)}
                      </td>
                      {/* Actions */}
                      <td className="px-2 py-2 text-right">
                        {batch.status === 'draft' ? (
                          isEditing ? (
                            <div className="flex items-center justify-end gap-0.5">
                              <button
                                onClick={() => handleSaveEdit(item.id)}
                                disabled={savingEdit}
                                className="p-1 text-positive hover:bg-positive/10 rounded transition-colors disabled:opacity-50"
                                title="Save"
                              >
                                {savingEdit ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                disabled={savingEdit}
                                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors disabled:opacity-50"
                                title="Cancel"
                              >
                                <XIcon size={14} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-0.5">
                              <button
                                onClick={() => handleStartEdit(item)}
                                className="p-1 text-text-tertiary hover:text-accent hover:bg-accent/10 rounded transition-colors"
                                title="Edit"
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                onClick={() => handleRemoveItem(item.id)}
                                className="p-1 text-text-tertiary hover:text-negative hover:bg-negative/10 rounded transition-colors"
                                title="Remove"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          )
                        ) : (
                          // Post-draft (ready/boxing/placement): allow quantity
                          // edits inline + per-row label printing.
                          //
                          // Quantity-only edit pencil is shown when the batch
                          // is still editable (ready/boxing/placement). Once
                          // the batch is in 'shipping'+ states, edits are
                          // locked. We use the SAME isEditing state — but
                          // when isEditing is true on a non-draft batch, the
                          // edit form below renders only the quantity field.
                          isEditing ? (
                            <div className="flex items-center justify-end gap-0.5">
                              <button
                                onClick={() => handleSaveEdit(item.id)}
                                disabled={savingEdit}
                                className="p-1 text-positive hover:bg-positive/10 rounded transition-colors disabled:opacity-50"
                                title="Save"
                              >
                                {savingEdit ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                disabled={savingEdit}
                                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors disabled:opacity-50"
                                title="Cancel"
                              >
                                <XIcon size={14} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-0.5">
                              {/* "Labeled" toggle — green check when done.
                                  Helps physical labeling: click after each
                                  SKU is fully labeled, the row goes green so
                                  unlabeled rows stand out. */}
                              {item.listingStatus === 'ACTIVE' && batch.channel === 'FBA' && (
                                <button
                                  onClick={() => handleToggleLabeled(item.id, !!item.labelsPrintedAt)}
                                  className={`p-1 rounded transition-colors ${
                                    item.labelsPrintedAt
                                      ? 'text-positive bg-positive/10 hover:bg-positive/20'
                                      : 'text-text-tertiary hover:text-positive hover:bg-positive/10'
                                  }`}
                                  title={item.labelsPrintedAt
                                    ? `Labeled at ${new Date(item.labelsPrintedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} — click to unmark`
                                    : 'Mark this SKU as fully labeled'}
                                >
                                  {item.labelsPrintedAt ? <CheckCircle size={14} /> : <Check size={14} />}
                                </button>
                              )}
                              {/* Edit qty (only in ready/boxing/placement) */}
                              {['ready', 'boxing', 'placement'].includes(batch.status) && (
                                <button
                                  onClick={() => handleStartEdit(item)}
                                  className="p-1 text-text-tertiary hover:text-accent hover:bg-accent/10 rounded transition-colors"
                                  title="Edit quantity"
                                >
                                  <Pencil size={14} />
                                </button>
                              )}
                              {/* Per-row FNSKU print */}
                              {item.listingStatus === 'ACTIVE' && batch.channel === 'FBA' && (
                                <PrintRowButton
                                  defaultQty={item.quantity}
                                  isPrinting={printingItemId === item.id}
                                  onPrint={(copies) => handlePrintFnskuLabels('print', 'per-unit', item.id, copies)}
                                  onDownload={(copies) => handlePrintFnskuLabels('download', 'per-unit', item.id, copies)}
                                />
                              )}
                            </div>
                          )
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirmation modal — real Amazon state! */}
      {showSendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !sending && setShowSendModal(false)}>
          <div className="bg-bg-surface border border-border-default rounded-lg p-5 w-[480px] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-3">
              <AlertCircle size={20} className="text-amber-400 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-base font-semibold">
                  {batch.channel === 'FBA' ? 'Send batch to Amazon?' : 'Publish batch to Amazon?'}
                </h2>
                <p className="text-sm text-text-tertiary mt-1">
                  {batch.channel === 'FBA' ? (
                    <>
                      This will create or update <b className="text-text-primary">{items.length}</b> listing{items.length === 1 ? '' : 's'} in your Seller Central account, and create a real inbound shipment plan for{' '}
                      <b className="text-text-primary">{totalUnits}</b> unit{totalUnits === 1 ? '' : 's'}. This action cannot be undone from FlipLedger — cancellation must happen in Seller Central.
                    </>
                  ) : (
                    <>
                      This will create <b className="text-text-primary">{items.length}</b> merchant-fulfilled listing{items.length === 1 ? '' : 's'} on Amazon for <b className="text-text-primary">{totalUnits}</b> unit{totalUnits === 1 ? '' : 's'}. As soon as Amazon finishes verification, customers can buy them — and you&apos;ll be responsible for shipping each order yourself. Unpublishing must be done from Seller Central.
                    </>
                  )}
                </p>
              </div>
            </div>

            <div className="bg-bg-elevated border border-border-subtle rounded p-3 text-xs space-y-1.5 mb-4">
              <div className="flex items-start justify-between gap-2">
                <span className="text-text-tertiary">Channel:</span>
                <span className="text-text-primary">{batch.channel === 'FBA' ? 'Fulfilled by Amazon' : 'Merchant Fulfilled'}</span>
              </div>
              {batch.channel === 'FBA' && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-text-tertiary">Ship from:</span>
                  <span className="text-text-primary text-right">
                    {batch.shipFromCity && batch.shipFromState ? `${batch.shipFromCity}, ${batch.shipFromState}` : <span className="text-negative">missing</span>}
                  </span>
                </div>
              )}
              <div className="flex items-start justify-between gap-2">
                <span className="text-text-tertiary">Expected revenue:</span>
                <span className="font-mono text-text-primary">{formatCurrency(totalRevenue)}</span>
              </div>
              <div className="flex items-start justify-between gap-2">
                <span className="text-text-tertiary">Est. profit:</span>
                <span className={`font-mono ${expectedProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
                  {formatCurrency(expectedProfit)}
                </span>
              </div>
            </div>

            <p className="text-[11px] text-text-tertiary mb-4">
              Amazon will take ~10–15 minutes to verify any new MSKUs. FlipLedger will poll the status automatically — you can close this page and come back.
            </p>

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowSendModal(false)}
                disabled={sending}
                className="h-9 px-3 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSendToAmazon}
                disabled={sending}
                className="h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {sending
                  ? (batch.channel === 'FBA' ? 'Sending…' : 'Publishing…')
                  : (batch.channel === 'FBA' ? 'Yes, send to Amazon' : 'Yes, publish to Amazon')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Photo lightbox — image-dominant, full-res (Prep Ship Hub style) */}
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
              <XIcon size={18} />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
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
                {lightbox.sku && <MskuLink sku={lightbox.sku} className="truncate hover:text-blue-200 hover:underline" />}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SendStatusCard ─────────────────────────────────────────────────────────
// Renders the progress of an in-flight or completed send operation.
function SendStatusCard({
  batch,
  items,
  debugItems,
  onRefresh,
  onForceReady,
}: {
  batch: Batch;
  items: BatchItem[];
  debugItems: Record<number, DebugItem>;
  onRefresh: () => void;
  onForceReady: () => void;
}) {
  const listingsReady = items.filter((i) => i.listingStatus === 'ACTIVE').length;
  const listingsFailed = items.filter((i) => i.listingStatus === 'FAILED').length;
  const listingsProcessing = items.filter((i) => i.listingStatus === 'PROCESSING').length;
  const totalListings = items.length;

  const isFBA = batch.channel === 'FBA';
  const planState = batch.planStatus || 'IN_PROGRESS';
  const isSending = batch.status === 'sending';
  const isReady = batch.status === 'ready';
  const isFailed = batch.status === 'failed';

  // Live elapsed-time counter updated every second.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!isSending || !batch.sentAt) return;
    const base = new Date(batch.sentAt).getTime();
    const update = () => setElapsedSec(Math.floor((Date.now() - base) / 1000));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [isSending, batch.sentAt]);

  const elapsedMin = Math.floor(elapsedSec / 60);
  const elapsedStr = elapsedSec < 60
    ? `${elapsedSec}s`
    : `${elapsedMin}m ${elapsedSec % 60}s`;

  // "Continue anyway" is available after 5 min if the inbound plan exists
  // (meaning the listing was accepted by Amazon — plan creation would have
  // failed if the MSKU wasn't valid).
  const canForceReady = isSending && !!batch.inboundPlanId && elapsedMin >= 5;
  const isTimedOut = elapsedMin >= 15;

  const [showDebug, setShowDebug] = useState(false);

  return (
    <div className={`rounded-lg p-4 mb-5 border ${
      isFailed ? 'border-negative/30 bg-negative/5' :
      isReady ? 'border-positive/30 bg-positive/5' :
      'border-accent/30 bg-accent/5'
    }`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {isFailed ? (
            <AlertCircle size={18} className="text-negative" />
          ) : isReady ? (
            <CheckCircle size={18} className="text-positive" />
          ) : (
            <Loader2 size={18} className="text-accent animate-spin" />
          )}
          <h3 className={`text-sm font-medium ${
            isFailed ? 'text-negative' : isReady ? 'text-positive' : 'text-accent'
          }`}>
            {isFailed
              ? (isFBA ? 'Send failed' : 'Publish failed')
              : isReady
                ? (isFBA ? 'Inbound plan ready' : 'Listings live on Amazon')
                : (isFBA ? 'Sending to Amazon…' : 'Publishing to Amazon…')}
          </h3>
          {isSending && batch.sentAt && (
            <span className={`text-[11px] font-mono ml-1 ${isTimedOut ? 'text-amber-400' : 'text-text-tertiary'}`}>
              {elapsedStr}
            </span>
          )}
        </div>
        {isSending && (
          <button
            onClick={onRefresh}
            className="text-[11px] text-accent hover:text-accent/80 border border-accent/30 rounded px-2 py-0.5"
          >
            Refresh
          </button>
        )}
      </div>

      {/* Timeout warning */}
      {isSending && isTimedOut && (
        <div className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded p-2 mb-3">
          Taking longer than expected ({elapsedStr}). Amazon MSKU verification can stall on new listings.
          {canForceReady && ' The inbound plan was already created — you can proceed to boxing now.'}
        </div>
      )}

      {/* sendError shown for failed OR timeout-advanced batches */}
      {(isFailed || (isReady && batch.sendError)) && batch.sendError && (
        <div className={`text-xs rounded p-2 mb-3 font-mono whitespace-pre-wrap ${
          isFailed ? 'text-text-primary bg-bg-elevated' : 'text-amber-400 bg-amber-500/10 border border-amber-500/20'
        }`}>
          {batch.sendError}
        </div>
      )}

      <div className={`grid grid-cols-1 ${isFBA ? 'sm:grid-cols-2' : ''} gap-3 text-xs`}>
        <div className="bg-bg-elevated rounded p-3">
          <div className="text-text-tertiary uppercase tracking-wider text-[10px] font-medium mb-1">Listings</div>
          <div className="text-text-primary font-mono">
            {listingsReady} active / {listingsProcessing} processing
            {listingsFailed > 0 && <span className="text-negative"> / {listingsFailed} failed</span>}
            <span className="text-text-tertiary"> of {totalListings}</span>
          </div>
        </div>
        {isFBA && (
          <div className="bg-bg-elevated rounded p-3">
            <div className="text-text-tertiary uppercase tracking-wider text-[10px] font-medium mb-1">Inbound plan</div>
            <div className="text-text-primary font-mono">
              {planState === 'SUCCESS' ? 'Active' : planState === 'FAILED' ? 'Failed' : 'Creating…'}
              {batch.inboundPlanId && (
                <span className="text-text-tertiary ml-1 text-[10px]">({batch.inboundPlanId.slice(0, 12)}…)</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Action buttons for stuck batches */}
      {canForceReady && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={onForceReady}
            className="text-xs bg-positive/10 hover:bg-positive/20 text-positive border border-positive/30 rounded px-3 py-1.5"
          >
            Continue to boxing anyway
          </button>
        </div>
      )}

      {/* Per-item go-live tracker — visible whenever something is still in
          flight (sending, or ready with listings that haven't verified yet). */}
      {(isSending || (isReady && listingsProcessing > 0)) && items.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {items.map((item) => {
            const dbg = debugItems[item.id];
            return (
              <GoLiveRow
                key={item.id}
                item={item}
                dbg={dbg}
                isFBA={isFBA}
                showDetails={showDebug}
              />
            );
          })}
          <button
            onClick={() => setShowDebug((v) => !v)}
            className="text-[11px] text-text-tertiary hover:text-text-secondary flex items-center gap-1"
          >
            <ChevronDown size={12} className={showDebug ? 'rotate-180' : ''} />
            {showDebug ? 'Hide details' : 'Show details (Amazon status, submission IDs)'}
          </button>
        </div>
      )}

      {isSending && !isTimedOut && (
        <p className="text-[11px] text-text-tertiary mt-3">
          {isFBA
            ? 'Restocks are near-instant. New SKUs: the offer registers in ~1–2 min, the FNSKU usually follows within 2 min (up to 10), then Amazon’s inbound system takes another 1–6 min before the plan can be created.'
            : 'New listings typically become buyable in 15–30 min; occasionally longer while Amazon validates the offer.'}
          {' '}You can close this page and come back — FlipLedger will track it.
        </p>
      )}
    </div>
  );
}

// ─── GoLiveRow ──────────────────────────────────────────────────────────────
// One row of the go-live tracker: SKU + stage chips that mirror the send
// flow's real gates. FBA: offer submitted → listing on Amazon → FNSKU assigned
// (the ready-for-inbound signal). MFN: … → buyable (the live signal).
function GoLiveRow({
  item,
  dbg,
  isFBA,
  showDetails,
}: {
  item: BatchItem;
  dbg?: DebugItem;
  isFBA: boolean;
  showDetails: boolean;
}) {
  const failed = item.listingStatus === 'FAILED';
  const active = item.listingStatus === 'ACTIVE';
  const fnsku = dbg?.fnsku || item.fnsku || null;
  const isReplenish = item.listingMode === 'REPLENISH_EXISTING';
  const amazonSeen = active || !!fnsku || (dbg?.amazonStatus?.length ?? 0) > 0;
  const buyable = active || (dbg?.amazonStatus || []).includes('BUYABLE');
  const finalDone = isFBA ? (!!fnsku || active) : buyable;

  const stages: { label: string; done: boolean; hint: string }[] = isReplenish
    ? [{ label: 'Live (restock)', done: true, hint: 'Existing listing — no verification needed' }]
    : [
        { label: 'Submitted', done: !failed, hint: 'Offer sent to Amazon' },
        { label: 'On Amazon', done: amazonSeen, hint: 'Usually ~1–2 min after submit' },
        isFBA
          ? { label: fnsku ? `FNSKU ${fnsku}` : 'FNSKU', done: finalDone, hint: 'Usually under 2 min, up to 10 for brand-new SKUs' }
          : { label: 'Buyable', done: finalDone, hint: 'Typically 15–30 min for new listings' },
      ];

  // The first not-done stage is the one in flight (unless the item failed).
  const currentIdx = failed ? -1 : stages.findIndex((s) => !s.done);

  return (
    <div className="bg-bg-elevated rounded p-2">
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <MskuLink sku={item.sku} className="font-mono text-text-primary hover:text-accent hover:underline max-w-[220px] truncate" />
        {failed && <AlertCircle size={12} className="text-negative" />}
        <div className="flex items-center gap-1 ml-auto">
          {stages.map((s, idx) => (
            <span key={s.label} className="flex items-center gap-1" title={s.hint}>
              {idx > 0 && <span className="text-text-tertiary/40">—</span>}
              {failed && idx === 0 ? (
                <AlertCircle size={11} className="text-negative" />
              ) : s.done ? (
                <CheckCircle size={11} className="text-positive" />
              ) : idx === currentIdx ? (
                <Loader2 size={11} className="text-accent animate-spin" />
              ) : (
                <span className="w-[11px] h-[11px] rounded-full border border-text-tertiary/40 inline-block" />
              )}
              <span className={
                failed && idx === 0 ? 'text-negative' :
                s.done ? 'text-text-secondary' :
                idx === currentIdx ? 'text-accent' : 'text-text-tertiary'
              }>
                {failed && idx === 0 ? 'Rejected' : s.label}
              </span>
            </span>
          ))}
        </div>
      </div>
      {item.listingError && (
        <div className="text-amber-400 mt-1 text-[11px]">{item.listingError}</div>
      )}
      {dbg?.pollError && (
        <div className="text-negative mt-1 text-[11px]">Poll error: {dbg.pollError}</div>
      )}
      {showDetails && (
        <div className="mt-1 text-[11px] font-mono text-text-tertiary flex gap-3 flex-wrap">
          <span>ASIN: <AsinLink asin={item.asin} className="text-text-primary hover:text-accent hover:underline" /></span>
          <span>Amazon: {dbg?.amazonStatus?.length ? dbg.amazonStatus.join(', ') : item.listingStatus || '—'}</span>
          {item.listingSubmissionId && <span>Submission: {item.listingSubmissionId}</span>}
          {dbg?.lastChecked && <span>Checked: {new Date(dbg.lastChecked).toLocaleTimeString()}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Amazon placement debug summary ─────────────────────────────────────────

function summarizeAmazonPlacementDebug(debug: any) {
  const placement = debug?.rawPlacementResponse;
  const shipments = debug?.rawShipmentsResponse;
  const plan = debug?.rawInboundPlan;

  const placementOptions: any[] =
    placement?.placementOptions ??
    placement?.payload?.placementOptions ??
    placement?.data?.placementOptions ??
    [];

  const shipmentList: any[] =
    shipments?.shipments ??
    shipments?.payload?.shipments ??
    shipments?.data?.shipments ??
    [];

  return {
    placementKeys: placement ? Object.keys(placement) : [],
    placementOptionCount: placementOptions.length,
    placementOptions: placementOptions.map((o: any) => ({
      placementOptionId: o.placementOptionId,
      shipmentIds: o.shipmentIds ?? o.shipmentIdsByShipmentType ?? o.shipments ?? [],
      fees: o.fees,
      discounts: o.discounts,
      rawKeys: Object.keys(o ?? {}),
    })),
    shipmentKeys: shipments ? Object.keys(shipments) : [],
    shipmentCount: shipmentList.length,
    shipments: shipmentList.map((s: any) => ({
      shipmentId: s.shipmentId,
      warehouseId:
        s.destination?.warehouseId ??
        s.destination?.fulfillmentCenterId ??
        s.destination?.fulfillmentCenterCode ??
        s.warehouseId ??
        s.fulfillmentCenterId ??
        null,
      destinationAddress:
        s.destination?.address ?? s.shipToAddress ?? s.destinationAddress ?? null,
      sourceAddress: s.sourceAddress ?? s.shipFromAddress ?? null,
      boxCount: Array.isArray(s.boxes) ? s.boxes.length : null,
      rawKeys: Object.keys(s ?? {}),
    })),
    inboundPlanKeys: plan ? Object.keys(plan) : [],
    inboundPlanStatus: plan?.status ?? plan?.inboundPlanStatus ?? null,
  };
}

// Scan an arbitrary object for FC code patterns (e.g. BNA6, PBI3, MIT2)
function scanFcCodes(obj: any): string[] {
  const str = JSON.stringify(obj);
  const matches = str.match(/\b([A-Z]{3,4}\d{1,2})\b/g);
  return matches ? [...new Set(matches)] : [];
}

// Known FC coordinates — used as fallback when Amazon doesn't return lat/lng
const FC_LOCATIONS: Record<string, { city: string; state: string; lat: number; lng: number }> = {
  PSC2: { city: 'Pasco',           state: 'WA', lat: 46.2396, lng: -119.1006 },
  MIT2: { city: 'Shafter',         state: 'CA', lat: 35.5005, lng: -119.2718 },
  BNA6: { city: 'Lebanon',         state: 'TN', lat: 36.2081, lng:  -86.2911 },
  PBI3: { city: 'Port St. Lucie',  state: 'FL', lat: 27.2730, lng:  -80.3582 },
  FWA4: { city: 'Fort Wayne',      state: 'IN', lat: 41.0793, lng:  -85.1394 },
  GYR2: { city: 'Goodyear',        state: 'AZ', lat: 33.4353, lng: -112.3576 },
  BFI4: { city: 'Kent',            state: 'WA', lat: 47.3809, lng: -122.2348 },
  SMF3: { city: 'Sacramento',      state: 'CA', lat: 38.5816, lng: -121.4944 },
  SLC2: { city: 'Salt Lake City',  state: 'UT', lat: 40.7608, lng: -111.8910 },
  LAS1: { city: 'Las Vegas',       state: 'NV', lat: 36.1699, lng: -115.1398 },
  PHX3: { city: 'Goodyear',        state: 'AZ', lat: 33.4500, lng: -112.3600 },
  ONT2: { city: 'Ontario',         state: 'CA', lat: 34.0633, lng: -117.6509 },
  DEN2: { city: 'Aurora',          state: 'CO', lat: 39.7392, lng: -104.9903 },
  DFW1: { city: 'Haslet',          state: 'TX', lat: 32.9757, lng:  -97.3427 },
  IAH1: { city: 'Katy',            state: 'TX', lat: 29.7858, lng:  -95.8245 },
};

// Recursively extract destination fields (city, state, postal, FC) from any object
function extractDestination(obj: any): {
  city: string | null; state: string | null; postalCode: string | null;
  fcCode: string | null; foundAt: string[];
} {
  let city: string | null = null, state: string | null = null;
  let postalCode: string | null = null, fcCode: string | null = null;
  const foundAt: string[] = [];

  function walk(o: any, path: string) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o)) {
      const fp = path ? `${path}.${k}` : k;
      const lk = k.toLowerCase();
      if (typeof v === 'string' && v) {
        if (!city && (lk === 'city' || lk.endsWith('city')))
          { city = v; foundAt.push(fp); }
        if (!state && (lk === 'stateorprovincecode' || lk === 'state' || lk === 'statecode') && v.length <= 4)
          { state = v; foundAt.push(fp); }
        if (!postalCode && (lk === 'postalcode' || lk === 'zipcode' || lk === 'zip') && /^\d{5}/.test(v))
          { postalCode = v; foundAt.push(fp); }
        if (!fcCode && /^[A-Z]{3,4}\d{1,2}$/.test(v))
          { fcCode = v; foundAt.push(fp); }
      } else if (v && typeof v === 'object') {
        walk(v, fp);
      }
    }
  }

  walk(obj, '');

  // Fallback: scan full JSON string for FC pattern
  if (!fcCode) {
    const hits = scanFcCodes(obj);
    if (hits[0]) { fcCode = hits[0]; foundAt.push(`scan:${fcCode}`); }
  }
  return { city, state, postalCode, fcCode, foundAt };
}

const REJECT_SHIPPING_MODES = ['LTL', 'FTL', 'FREIGHT', 'PALLET'];
const REJECT_CARRIER_FRAGMENTS = ['total express', 'tex courier', 'itapemirim', 'correios'];

function pickBestTransportOption(options: any[]): any | null {
  const valid = options.filter((o) => {
    const mode = (o.shippingMode || '').toUpperCase();
    const carrier = (o.carrier?.name || '').toLowerCase();
    if (REJECT_SHIPPING_MODES.some((r) => mode.includes(r))) return false;
    if (REJECT_CARRIER_FRAGMENTS.some((r) => carrier.includes(r))) return false;
    return true;
  });
  const upsPartnered = valid.find((o) =>
    o.shippingMode === 'GROUND_SMALL_PARCEL' &&
    o.shippingSolution === 'AMAZON_PARTNERED_CARRIER' &&
    (o.carrier?.name || '').toUpperCase().includes('UPS')
  );
  if (upsPartnered) return upsPartnered;
  const spdPartnered = valid.find((o) =>
    o.shippingMode === 'GROUND_SMALL_PARCEL' && o.shippingSolution === 'AMAZON_PARTNERED_CARRIER'
  );
  if (spdPartnered) return spdPartnered;
  const spd = valid.find((o) => o.shippingMode === 'GROUND_SMALL_PARCEL');
  if (spd) return spd;
  return valid[0] ?? null;
}

interface ShipmentSummary {
  shipmentId: string;
  best: any;
  allOptions: any[];
  fcCode: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  costCents: number;
  destDebug: { foundAt: string[] };
}

interface TransportSummary {
  perShipment: ShipmentSummary[];
  totalShippingCents: number;
  selections: Array<{ shipmentId: string; transportationOptionId: string }>;
  hasPartnerUps: boolean;
}

function buildTransportSummary(rawOptions: any[], shipmentDetails?: any[]): TransportSummary {
  const shipmentIds = [...new Set(rawOptions.map((o) => o.shipmentId).filter(Boolean))] as string[];
  const perShipment: ShipmentSummary[] = [];
  for (const sid of shipmentIds) {
    const opts = rawOptions.filter((o) => o.shipmentId === sid);
    const best = pickBestTransportOption(opts);
    if (best) {
      // Use getShipment data as primary source — destination.warehouseId +
      // address are available even pre-confirmation (preview path normalizes
      // them to destinationFC / destinationWarehouseAddress).
      const shipmentData = shipmentDetails?.find((s: any) => s.shipmentId === sid);
      const warehouseAddr = shipmentData?.destinationWarehouseAddress ?? null;

      // Fall back to extractDestination on the transport option object
      const dest = extractDestination(best);
      const fcCode = shipmentData?.destinationFC ?? dest.fcCode ?? null;

      // Prefer warehouse address fields; fall back to transport option parse; fall back to FC_LOCATIONS
      const lookup = fcCode ? FC_LOCATIONS[fcCode] : null;
      const city = warehouseAddr?.city ?? dest.city ?? lookup?.city ?? null;
      const state = warehouseAddr?.stateOrProvinceCode ?? dest.state ?? lookup?.state ?? null;

      // Lat/lng: try FC_LOCATIONS by FC code, or reverse-lookup by city+state
      let lat: number | null = lookup?.lat ?? null;
      let lng: number | null = lookup?.lng ?? null;
      if ((lat === null || lng === null) && city && state) {
        const revEntry = Object.entries(FC_LOCATIONS).find(([, v]) =>
          v.city.toLowerCase() === city.toLowerCase() && v.state.toLowerCase() === state.toLowerCase()
        );
        if (revEntry) { lat = revEntry[1].lat; lng = revEntry[1].lng; }
      }

      const foundAt = [
        ...(warehouseAddr ? ['destinationWarehouseAddress'] : []),
        ...dest.foundAt,
      ];

      perShipment.push({
        shipmentId: sid, best, allOptions: opts,
        fcCode, city, state, lat, lng,
        costCents: Math.round((best.quote?.cost?.amount || 0) * 100),
        destDebug: { foundAt },
      });
    }
  }
  const totalShippingCents = perShipment.reduce((s, p) => s + p.costCents, 0);
  const selections = perShipment.map((p) => ({
    shipmentId: p.shipmentId,
    transportationOptionId: p.best.transportationOptionId,
  }));
  const hasPartnerUps = perShipment.length > 0 && perShipment.every(
    (p) => p.best.shippingMode === 'GROUND_SMALL_PARCEL' &&
            p.best.shippingSolution === 'AMAZON_PARTNERED_CARRIER' &&
            (p.best.carrier?.name || '').toUpperCase().includes('UPS')
  );
  return { perShipment, totalShippingCents, selections, hasPartnerUps };
}

// ─── BoxingWorkflow ─────────────────────────────────────────────────────────
//
// Phase 3 UI. Drives the batch through three sub-phases:
//   1. Boxing:    enter box dimensions + assign items to boxes
//   2. Placement: Amazon returns 3 options (Optimized/Partial/Minimal), pick one
//   3. Shipping:  confirmed placement — show shipment IDs + destinations (map TBD)

// Small inline control in the box header: shows a Copy icon button.
// Click once = duplicate one identical box (dims, weight, packing group,
// contents). Hold + scroll or use the number input to duplicate N times.
function DuplicateBoxControl({ onDuplicate }: { onDuplicate: (copies: number) => void }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(1);
  return (
    <div className="relative">
      <button
        onClick={() => {
          if (open) {
            onDuplicate(Math.max(1, Math.min(50, count)));
            setOpen(false);
            setCount(1);
          } else {
            setOpen(true);
          }
        }}
        className="p-1 text-text-tertiary hover:text-accent transition-colors inline-flex items-center gap-1"
        title={open ? `Duplicate ${count}x` : 'Duplicate box'}
      >
        <Copy size={12} />
        {open && <span className="text-[10px] font-medium">×{count}</span>}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-10 flex items-center gap-1 bg-bg-elevated border border-border-subtle rounded shadow-sm p-1"
          onMouseLeave={() => { setOpen(false); setCount(1); }}
        >
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
            className="w-12 px-1 py-0.5 text-xs border border-border-subtle rounded bg-bg-base text-text-primary"
            autoFocus
          />
          <button
            onClick={() => { onDuplicate(count); setOpen(false); setCount(1); }}
            className="px-2 py-0.5 text-xs rounded bg-accent text-white"
          >
            Copy
          </button>
        </div>
      )}
    </div>
  );
}

interface BoxingWorkflowProps {
  batch: Batch;
  items: BatchItem[];
  boxes: Box[];
  packGroups: PackGroup[];
  placementOptions: PlacementOption[];
  placementMapData: PlacementMapData | null;
  placementDebug: any;
  hoveredOptionId: string | null;
  onHoverOption: (id: string | null) => void;
  savingBoxes: boolean;
  packing: boolean;
  loadingPlacement: boolean;
  confirmingPlacementId: string | null;
  onAddBox: (packingGroupId?: string) => void;
  onRemoveBox: (idx: number) => void;
  onDuplicateBox: (idx: number, copies?: number) => void;
  onUpdateBoxField: (idx: number, field: keyof Box, value: number) => void;
  onSetBoxItemQty: (boxIdx: number, itemId: number, qty: number) => void;
  onSaveBoxes: () => void;
  onConfirmPacking: () => void;
  onGeneratePlacement: () => void;
  onLoadPlacement: () => void;
  onConfirmPlacement: (optionId: string) => void;
  onConfirmPlacementAndLoadTransport: (placementOptionId: string, shipmentIds: string[], readyToShipStart: string) => Promise<{ success: boolean; options?: any[]; shipments?: any[]; error?: string }>;
  onConfirmTransportation: (selections: Array<{ shipmentId: string; transportationOptionId: string }>, selectedOptions: any[]) => Promise<void>;
  confirmingBothId: string | null;
}

function BoxingWorkflow({
  batch,
  items,
  boxes,
  packGroups,
  placementOptions,
  placementMapData,
  placementDebug,
  hoveredOptionId,
  onHoverOption,
  savingBoxes,
  packing,
  loadingPlacement,
  confirmingPlacementId,
  onAddBox,
  onRemoveBox,
  onDuplicateBox,
  onUpdateBoxField,
  onSetBoxItemQty,
  onSaveBoxes,
  onConfirmPacking,
  onGeneratePlacement,
  onLoadPlacement,
  onConfirmPlacement,
  onConfirmPlacementAndLoadTransport,
  onConfirmTransportation,
  confirmingBothId,
}: BoxingWorkflowProps) {
  // Auto-load placement options when we first transition into placement state
  useEffect(() => {
    if ((batch.status === 'placement' || batch.status === 'shipping') && placementOptions.length === 0) {
      onLoadPlacement();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.status]);

  // Phase 4: Shipments + label printing — fetched once we hit shipping status
  const [shipments, setShipments] = useState<Array<{
    shipmentId: string;
    name: string;
    status: string;
    destination: { city?: string; stateOrProvinceCode?: string; postalCode?: string } | null;
    destinationFC: string | null;
    boxCount: number | null;
    // Extended fields from confirmed_shipments (persisted after transportation confirm)
    confirmationId?: string | null;
    carrier?: string | null;
    carrierCode?: string | null;
    shippingMode?: string | null;
    shippingSolution?: string | null;
    cost?: number | null;
    costCurrency?: string | null;
  }>>([]);
  const [printingLabel, setPrintingLabel] = useState<string | null>(null); // key: `${type}-${shipmentId}`
  const [boxLabelFormat, setBoxLabelFormat] = useState<string>('PackageLabel_Thermal_NonPCP');
  const [fnskuLabelFormat, setFnskuLabelFormat] = useState<'thermal' | 'letter-30up'>('letter-30up');
  const [printingFnskuShipment, setPrintingFnskuShipment] = useState(false);
  const [transportationStatus, setTransportationStatus] = useState<string | null>(batch.transportationStatus || null);
  const [completingTransport, setCompletingTransport] = useState(false);
  const [transportationError, setTransportationError] = useState<string | null>(batch.transportationError || null);

  // Placement inspector — per-option transport data so "load all" can populate all at once
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [transportDataByOption, setTransportDataByOption] = useState<Record<string, {
    loading: boolean;
    options: any[] | null;
    shipments: any[] | null;  // from getShipment — has destinationWarehouseAddress
    error: string | null;
  }>>({});
  // Merge base shipmentMeta from placement API with transport-derived lat/lng from FC_LOCATIONS.
  // Keyed by shipmentId — used by PlacementMap to draw route lines once transport loads.
  const derivedShipmentMeta = useMemo((): Record<string, MapShipmentMeta> => {
    const base: Record<string, MapShipmentMeta> = { ...(placementMapData?.shipmentMeta ?? {}) };
    for (const td of Object.values(transportDataByOption)) {
      if (!td.options) continue;
      const summary = buildTransportSummary(td.options, td.shipments ?? undefined);
      for (const ps of summary.perShipment) {
        const existing = base[ps.shipmentId];
        base[ps.shipmentId] = {
          shipmentId: ps.shipmentId,
          fcCode: ps.fcCode ?? existing?.fcCode ?? null,
          city: ps.city ?? existing?.city ?? null,
          state: ps.state ?? existing?.state ?? null,
          lat: ps.lat ?? existing?.lat ?? null,
          lng: ps.lng ?? existing?.lng ?? null,
          distanceMiles: existing?.distanceMiles ?? null,
        };
      }
    }
    return base;
  }, [placementMapData?.shipmentMeta, transportDataByOption]);

  // Ship date for transportation options — shared across all options, defaults to tomorrow
  const [shipDate, setShipDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  });

  async function handleCompleteTransportation() {
    setCompletingTransport(true);
    setTransportationError(null);
    try {
      // Pass shipment IDs from the confirmed placement option so listShipments isn't needed
      const confirmedOpt = placementOptions.find((o) => o.placementOptionId === batch.placementOptionId);
      const shipmentIds = confirmedOpt?.shipmentIds ?? [];
      const readyToShipStart = shipDate
        ? new Date(`${shipDate}T09:00:00`).toISOString()
        : undefined;
      const res = await fetch(`/api/list/batches/${batch.id}/transportation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate-and-confirm', shipmentIds, readyToShipStart }),
      });
      const data = await res.json();
      if (data.success) {
        setTransportationStatus('SUCCESS');
      } else {
        setTransportationError(data.error || 'Transportation step failed — check pm2 logs');
      }
    } catch (err) {
      setTransportationError(String(err));
    }
    setCompletingTransport(false);
  }

  function handleSelectOption(optionId: string) {
    setSelectedOptionId((prev) => (prev === optionId ? null : optionId));
  }

  // Called when placement is not yet confirmed — confirms placement first, then generates transport.
  async function handleConfirmAndLoadTransport(optionId: string) {
    if (!shipDate) return;
    const opt = placementOptions.find((o) => o.placementOptionId === optionId);
    const shipmentIds = opt?.shipmentIds ?? [];
    const readyToShipStart = new Date(`${shipDate}T09:00:00`).toISOString();

    setTransportDataByOption((prev) => ({
      ...prev,
      [optionId]: { loading: true, options: null, shipments: null, error: null },
    }));
    const result = await onConfirmPlacementAndLoadTransport(optionId, shipmentIds, readyToShipStart);
    setTransportDataByOption((prev) => ({
      ...prev,
      [optionId]: {
        loading: false,
        options: result.options ?? null,
        shipments: result.shipments ?? null,
        error: result.success ? null : (result.error ?? 'Failed — check pm2 logs'),
      },
    }));
  }

  // No-commitment shipping estimate for an UNCONFIRMED placement option.
  // Uses the transportation 'preview' action: generates + lists carrier
  // quotes for the candidate option without confirming anything, and returns
  // per-shipment destinations (available from Amazon pre-confirmation).
  async function handleLoadTransportPreview(optionId: string) {
    if (!shipDate) return;
    const opt = placementOptions.find((o) => o.placementOptionId === optionId);
    const shipmentIds = opt?.shipmentIds ?? [];
    const readyToShipStart = new Date(`${shipDate}T09:00:00`).toISOString();

    setTransportDataByOption((prev) => ({
      ...prev,
      [optionId]: { loading: true, options: null, shipments: null, error: null },
    }));
    try {
      const res = await fetch(`/api/list/batches/${batch.id}/transportation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', placementOptionId: optionId, shipmentIds, readyToShipStart }),
      });
      const data = await res.json();
      setTransportDataByOption((prev) => ({
        ...prev,
        [optionId]: {
          loading: false,
          options: data.options ?? null,
          shipments: data.shipments ?? null,
          error: data.error ?? (data.options ? null : 'No options returned'),
        },
      }));
    } catch (err) {
      setTransportDataByOption((prev) => ({
        ...prev,
        [optionId]: { loading: false, options: null, shipments: null, error: String(err) },
      }));
    }
  }

  // Called when placement is already confirmed (page reload, or after confirmation) — just generate+list transport.
  async function handleLoadTransportForConfirmed(optionId: string) {
    if (!shipDate) return;
    const opt = placementOptions.find((o) => o.placementOptionId === optionId);
    const shipmentIds = opt?.shipmentIds ?? [];
    const readyToShipStart = new Date(`${shipDate}T09:00:00`).toISOString();

    setTransportDataByOption((prev) => ({
      ...prev,
      [optionId]: { loading: true, options: null, shipments: null, error: null },
    }));
    try {
      const res = await fetch(`/api/list/batches/${batch.id}/transportation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', shipmentIds, readyToShipStart }),
      });
      const data = await res.json();
      setTransportDataByOption((prev) => ({
        ...prev,
        [optionId]: {
          loading: false,
          options: data.options ?? null,
          shipments: data.shipments ?? null,
          error: data.error ?? (data.options ? null : 'No options returned'),
        },
      }));
    } catch (err) {
      setTransportDataByOption((prev) => ({
        ...prev,
        [optionId]: { loading: false, options: null, shipments: null, error: String(err) },
      }));
    }
  }

  async function handlePrintFnskuShipmentLabels(action: 'print' | 'download') {
    const qs = new URLSearchParams({ action, mode: 'per-unit', format: fnskuLabelFormat });
    if (action === 'download') {
      window.open(`/api/list/batches/${batch.id}/fnsku-labels?${qs}`, '_blank');
      return;
    }
    setPrintingFnskuShipment(true);
    try {
      const res = await fetch(`/api/list/batches/${batch.id}/fnsku-labels?${qs}`);
      const data = await res.json();
      if (data.success) {
        const missing = data.missingFnsku?.length
          ? `\n\n⚠ Missing FNSKU for: ${data.missingFnsku.join(', ')}`
          : '';
        alert(`✓ Printed ${data.labelCount} FNSKU labels to ${data.printer}${data.jobId ? ' — job ' + data.jobId : ''}.${missing}`);
      } else {
        alert(`Print failed: ${data.error}${data.hint ? '\n\n' + data.hint : ''}`);
      }
    } catch (err) {
      alert(`Print error: ${err}`);
    }
    setPrintingFnskuShipment(false);
  }

  // Prefer confirmed_shipments from DB (populated after transportation confirm) over
  // the /shipments API call, which 403s on some SP-API accounts.
  const confirmedShipmentData = useMemo((): ConfirmedShipment[] => {
    if (!batch.confirmedShipments) return [];
    try { return JSON.parse(batch.confirmedShipments); } catch { return []; }
  }, [batch.confirmedShipments]);

  useEffect(() => {
    if (batch.status !== 'shipping' && batch.status !== 'shipped') return;
    if (shipments.length > 0) return;
    // If we already have persisted confirmed shipment data, use it and skip the API call
    if (confirmedShipmentData.length > 0) {
      setShipments(confirmedShipmentData.map((cs) => ({
        shipmentId: cs.shipmentId,
        name: cs.confirmationId || cs.shipmentId,
        status: 'WORKING',
        destination: cs.destinationAddress ? {
          city: cs.destinationCity ?? undefined,
          stateOrProvinceCode: cs.destinationState ?? undefined,
        } : null,
        destinationFC: cs.destinationFC,
        boxCount: null,
        // Extended fields from confirmed data
        confirmationId: cs.confirmationId,
        carrier: cs.carrier,
        carrierCode: cs.carrierCode,
        shippingMode: cs.shippingMode,
        shippingSolution: cs.shippingSolution,
        cost: cs.cost,
        costCurrency: cs.costCurrency,
      })));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/list/batches/${batch.id}/shipments`);
        const data = await res.json();
        if (!cancelled && data.shipments) setShipments(data.shipments);
      } catch (err) {
        console.warn('shipments fetch failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [batch.status, batch.id, shipments.length, confirmedShipmentData]);

  async function handlePrintLabels(shipmentId: string, type: 'fnsku' | 'box') {
    const key = `${type}-${shipmentId}`;
    setPrintingLabel(key);
    try {
      const qs = new URLSearchParams({ type, shipmentId, action: 'print' });
      if (type === 'box') qs.set('pageType', boxLabelFormat);
      const res = await fetch(`/api/list/batches/${batch.id}/labels?${qs}`);
      const data = await res.json();
      if (data.success) {
        alert(`✓ Printed ${type === 'fnsku' ? 'FNSKU' : 'Box ID'} labels for ${shipmentId}\nPrinter: ${data.printer}${data.jobId ? ' (job ' + data.jobId + ')' : ''}`);
      } else {
        const hint = data.hint ? `\n\n${data.hint}` : '';
        alert(`Print failed: ${data.error}${hint}\n\nTry "Download PDF" instead and print manually.`);
      }
    } catch (err) {
      alert(`Print error: ${err}`);
    }
    setPrintingLabel(null);
  }

  function handleDownloadLabels(shipmentId: string, type: 'fnsku' | 'box') {
    const qs = new URLSearchParams({ type, shipmentId, action: 'download' });
    if (type === 'box') qs.set('pageType', boxLabelFormat);
    window.open(`/api/list/batches/${batch.id}/labels?${qs}`, '_blank');
  }

  // Build an itemId → batch item map for quick lookups
  const itemMap = new Map<number, BatchItem>();
  for (const it of items) itemMap.set(it.id, it);

  // For each batch item, how many units are already allocated across boxes?
  const allocated = new Map<number, number>();
  for (const box of boxes) {
    for (const bi of box.items) {
      allocated.set(bi.itemId, (allocated.get(bi.itemId) || 0) + bi.quantity);
    }
  }
  const fullyAllocated = items.every((it) => (allocated.get(it.id) || 0) === it.quantity);

  // Multi-group: pre-compute which boxes belong to each pack group, plus
  // per-group unallocated items. For single-group batches we render the same
  // layout but without the group headers.
  const isMultiGroup = packGroups.length > 1;
  const groupSections: Array<{
    group: PackGroup | null;          // null for single-group batches with no group metadata
    boxIndices: number[];             // indexes into the global boxes[] array
    unallocatedInGroup: Array<{ item: BatchItem; remaining: number }>;
  }> = [];

  if (packGroups.length === 0) {
    // No group metadata yet — treat all boxes as one section, all batch items as that section's expected items
    const unallocatedInGroup = items
      .map((it) => ({ item: it, remaining: it.quantity - (allocated.get(it.id) || 0) }))
      .filter((x) => x.remaining > 0);
    groupSections.push({
      group: null,
      boxIndices: boxes.map((_, i) => i),
      unallocatedInGroup,
    });
  } else {
    for (const g of packGroups) {
      const boxIndices = boxes
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => b.packingGroupId === g.packingGroupId)
        .map(({ i }) => i);
      const groupItemIds = new Set(g.items.map((it) => it.itemId));
      const allocatedInThisGroup = new Map<number, number>();
      for (const idx of boxIndices) {
        for (const bi of boxes[idx].items) {
          if (groupItemIds.has(bi.itemId)) {
            allocatedInThisGroup.set(bi.itemId, (allocatedInThisGroup.get(bi.itemId) || 0) + bi.quantity);
          }
        }
      }
      const unallocatedInGroup = g.items
        .map((it) => {
          const batchItem = itemMap.get(it.itemId);
          if (!batchItem) return null;
          const remaining = it.quantity - (allocatedInThisGroup.get(it.itemId) || 0);
          return remaining > 0 ? { item: batchItem, remaining } : null;
        })
        .filter((x): x is { item: BatchItem; remaining: number } => x !== null);
      groupSections.push({ group: g, boxIndices, unallocatedInGroup });
    }
  }

  const totalUnallocated = groupSections.reduce((s, sec) => s + sec.unallocatedInGroup.length, 0);

  // Total boxes weight for the summary bar
  const totalBoxWeight = boxes.reduce((sum, b) => sum + (b.weightLb || 0), 0);

  const isBoxingPhase = batch.status === 'ready' || batch.status === 'boxing';
  const isPlacementPhase = batch.status === 'placement';
  const isShippingPhase = batch.status === 'shipping';
  const packingLocked = batch.packingStatus === 'SUCCESS';

  return (
    <div className="bg-bg-surface border border-accent/20 rounded-lg mb-5 overflow-hidden">
      {/* Workflow header + step indicator */}
      <div className="px-4 py-3 border-b border-border-subtle bg-accent/5">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-accent" />
            <h3 className="text-sm font-medium text-text-primary">Ship to Amazon</h3>
          </div>
          <div className="text-xs text-text-tertiary font-mono">
            {boxes.length} box{boxes.length === 1 ? '' : 'es'} · {totalBoxWeight.toFixed(1)} lb total
          </div>
        </div>
        {/* Three-step breadcrumb */}
        <div className="flex items-center gap-2 text-[11px]">
          <StepChip
            label="1. Box"
            active={isBoxingPhase}
            done={packingLocked || isPlacementPhase || isShippingPhase}
          />
          <span className="text-text-tertiary">→</span>
          <StepChip
            label="2. Placement"
            active={isPlacementPhase}
            done={isShippingPhase || !!batch.placementOptionId}
          />
          <span className="text-text-tertiary">→</span>
          <StepChip label="3. Ship" active={isShippingPhase} done={false} />
        </div>
      </div>

      {/* ─── Step 1: Boxing ─── */}
      {isBoxingPhase && (
        <div className="p-4 space-y-4">
          {/* Multi-group banner: tell the user what Amazon decided */}
          {isMultiGroup && (
            <div className="text-[11px] text-text-secondary bg-accent/5 border border-accent/20 rounded p-2.5">
              <strong className="text-accent">Amazon split this batch into {packGroups.length} pack groups.</strong>{' '}
              Each group ships separately and may go to a different fulfillment center. Box each group&apos;s items in their own boxes below.
            </div>
          )}

          {/* Per-group sections */}
          {groupSections.map((section, sectionIdx) => {
            const isLastSection = sectionIdx === groupSections.length - 1;
            return (
              <div
                key={section.group?.packingGroupId || 'single'}
                className={isMultiGroup ? 'border border-accent/20 rounded-lg overflow-hidden' : ''}
              >
                {/* Group header (only shown for multi-group) */}
                {isMultiGroup && section.group && (
                  <div className="px-3 py-2 bg-accent/10 border-b border-accent/20 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent text-white text-[10px] font-semibold">
                        {sectionIdx + 1}
                      </span>
                      <span className="text-xs font-medium text-text-primary">Pack Group {sectionIdx + 1}</span>
                      <span className="text-[10px] text-text-tertiary font-mono">{section.group.packingGroupId.slice(0, 12)}…</span>
                    </div>
                    <span className="text-[11px] text-text-tertiary">
                      {section.group.items.reduce((s, it) => s + it.quantity, 0)} unit{section.group.items.reduce((s, it) => s + it.quantity, 0) === 1 ? '' : 's'} · {section.boxIndices.length} box{section.boxIndices.length === 1 ? '' : 'es'}
                    </span>
                  </div>
                )}

                <div className={isMultiGroup ? 'p-3 space-y-3' : 'space-y-3'}>
                  {/* Box list for this group */}
                  {section.boxIndices.map((idx, boxIdxInSection) => {
                    const box = boxes[idx];
                    const boxItemsInThisBox = box.items.map((bi) => ({
                      batchItem: itemMap.get(bi.itemId),
                      quantity: bi.quantity,
                    }));
                    const boxUnits = box.items.reduce((s, bi) => s + bi.quantity, 0);
                    return (
                      <div key={idx} className="border border-border-subtle rounded-lg bg-bg-elevated overflow-hidden">
                        <div className="px-3 py-2 flex items-center gap-3 border-b border-border-subtle">
                          <BoxIcon size={14} className="text-text-tertiary" />
                          <span className="text-xs font-medium text-text-primary">Box {boxIdxInSection + 1}</span>
                          <span className="text-[11px] text-text-tertiary ml-auto">{boxUnits} unit{boxUnits === 1 ? '' : 's'}</span>
                          {!packingLocked && (
                            <DuplicateBoxControl
                              onDuplicate={(copies) => onDuplicateBox(idx, copies)}
                            />
                          )}
                          {!packingLocked && section.boxIndices.length > 1 && (
                            <button
                              onClick={() => onRemoveBox(idx)}
                              className="p-1 text-text-tertiary hover:text-negative transition-colors"
                              title="Remove box"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                        <div className="p-3 grid grid-cols-4 gap-2">
                          <DimensionInput label="L (in)" value={box.lengthIn} onChange={(v) => onUpdateBoxField(idx, 'lengthIn', v)} disabled={packingLocked} />
                          <DimensionInput label="W (in)" value={box.widthIn} onChange={(v) => onUpdateBoxField(idx, 'widthIn', v)} disabled={packingLocked} />
                          <DimensionInput label="H (in)" value={box.heightIn} onChange={(v) => onUpdateBoxField(idx, 'heightIn', v)} disabled={packingLocked} />
                          <DimensionInput label="Weight (lb)" value={box.weightLb} onChange={(v) => onUpdateBoxField(idx, 'weightLb', v)} disabled={packingLocked} />
                        </div>
                        <div className="px-3 pb-3">
                          <div className="text-[10px] uppercase tracking-widest text-text-tertiary mb-1.5">Contents</div>
                          {boxItemsInThisBox.length === 0 ? (
                            <div className="text-[11px] text-text-tertiary italic py-1">No items assigned yet</div>
                          ) : (
                            <div className="space-y-1">
                              {boxItemsInThisBox.map(({ batchItem, quantity }) => {
                                if (!batchItem) return null;
                                return (
                                  <div key={batchItem.id} className="flex items-center gap-2 text-[11px]">
                                    <span className="text-text-primary truncate flex-1" title={batchItem.productName || ''}>
                                      {batchItem.productName || batchItem.asin}
                                    </span>
                                    <MskuLink sku={batchItem.sku} className="text-text-tertiary font-mono hover:text-accent hover:underline" />
                                    {packingLocked ? (
                                      <span className="text-text-secondary font-mono w-10 text-right">× {quantity}</span>
                                    ) : (
                                      <input
                                        type="number"
                                        min="0"
                                        max={batchItem.quantity}
                                        value={quantity}
                                        onChange={(e) => onSetBoxItemQty(idx, batchItem.id, parseInt(e.target.value) || 0)}
                                        className="w-12 h-6 px-1 text-right bg-bg-surface border border-border-default rounded text-[11px] font-mono focus:outline-none focus:border-accent"
                                      />
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Unallocated items in this group */}
                  {!packingLocked && section.unallocatedInGroup.length > 0 && (
                    <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3">
                      <div className="text-[11px] text-amber-400 mb-1.5 font-medium uppercase tracking-widest">
                        Unassigned items {isMultiGroup ? `(in this group)` : ''}
                      </div>
                      <div className="space-y-1">
                        {section.unallocatedInGroup.map(({ item: it, remaining }) => (
                          <UnassignedItemRow
                            key={it.id}
                            item={it}
                            remaining={remaining}
                            boxIndices={section.boxIndices}
                            boxes={boxes}
                            onAdd={(boxIdx, qty) => {
                              const existing = boxes[boxIdx].items.find((bi) => bi.itemId === it.id);
                              const newQty = (existing?.quantity || 0) + qty;
                              onSetBoxItemQty(boxIdx, it.id, newQty);
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Per-group "Add box" button */}
                  {!packingLocked && (
                    <button
                      onClick={() => onAddBox(section.group?.packingGroupId)}
                      className="h-8 px-3 bg-bg-elevated border border-border-default rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-1.5"
                    >
                      <Plus size={12} /> Add box {isMultiGroup ? `to group ${sectionIdx + 1}` : ''}
                    </button>
                  )}
                </div>

                {/* Spacer between groups */}
                {!isLastSection && isMultiGroup && <div className="h-1" />}
              </div>
            );
          })}

          {/* Global action bar */}
          {!packingLocked && (
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-subtle">
              <button
                onClick={onSaveBoxes}
                disabled={savingBoxes || !fullyAllocated || packing}
                className="h-9 px-3 bg-bg-elevated border border-border-default rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Save boxes to FlipLedger without pushing to Amazon"
              >
                {savingBoxes ? 'Saving…' : 'Save draft'}
              </button>
              <button
                onClick={onConfirmPacking}
                disabled={packing || !fullyAllocated || boxes.length === 0}
                className="h-9 px-4 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
              >
                {packing ? <Loader2 size={12} className="animate-spin" /> : <BoxIcon size={12} />}
                {packing ? 'Confirming with Amazon…' : 'Confirm packing'}
              </button>
            </div>
          )}

          {!fullyAllocated && !packingLocked && totalUnallocated > 0 && (
            <p className="text-[11px] text-amber-400">
              All items must be fully assigned to boxes before you can confirm packing.
            </p>
          )}

          {batch.packingError && (
            <div className="text-[11px] text-negative bg-negative/5 border border-negative/30 rounded p-2 font-mono">
              Packing error: {batch.packingError}
            </div>
          )}
        </div>
      )}

      {/* ─── Step 2: Placement ─── */}
      {(isPlacementPhase || isShippingPhase) && (
        <div className="p-4 space-y-3">
          {loadingPlacement && placementOptions.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-text-tertiary">
              <Loader2 size={12} className="animate-spin" />
              Loading placement options from Amazon…
            </div>
          )}

          {!loadingPlacement && placementOptions.length === 0 && isPlacementPhase && !batch.placementStatus && (
            <button
              onClick={onGeneratePlacement}
              className="h-9 px-4 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 transition-colors flex items-center gap-1.5"
            >
              <MapPin size={12} /> Generate placement options
            </button>
          )}

          {placementOptions.length > 0 && (
            <div className="space-y-4">
              {/* Map — hero element */}
              {placementMapData && (
                <PlacementMap
                  options={placementOptions}
                  shipmentMeta={derivedShipmentMeta}
                  shipFromLat={placementMapData.shipFromLat}
                  shipFromLng={placementMapData.shipFromLng}
                  hoveredOptionId={selectedOptionId ?? hoveredOptionId}
                  confirmedOptionId={batch.placementOptionId ?? undefined}
                  height={400}
                />
              )}

              {/* Ship date — shared, set before confirming */}
              <div className="flex items-center gap-3">
                <div>
                  <label className="text-[10px] text-text-muted uppercase tracking-wider block mb-1">Ship Date</label>
                  <input
                    type="date"
                    value={shipDate}
                    min={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => { setShipDate(e.target.value); setTransportDataByOption({}); }}
                    className="h-8 px-2 bg-bg-surface border border-border-subtle rounded text-xs text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>
                <p className="text-[11px] text-text-muted mt-3">
                  Shipping estimates and FC destinations are loaded after confirming a placement option.
                </p>
              </div>

              {/* Placement option list */}
              <div className="space-y-2">
                {placementOptions.map((opt, idx) => {
                  const isSelected = selectedOptionId === opt.placementOptionId;
                  const isConfirmed = batch.placementOptionId === opt.placementOptionId;
                  const anotherConfirmed = !!(batch.placementOptionId && !isConfirmed);
                  const tData = transportDataByOption[opt.placementOptionId];
                  const tLoading = tData?.loading ?? false;
                  const tOptions = tData?.options ?? null;
                  const tShipments = tData?.shipments ?? null;
                  const tError = tData?.error ?? null;
                  const placementFee = opt.placementFeeCents ??
                    opt.fees.reduce((s, f) => s + Math.round((f.value?.amount || 0) * 100), 0);
                  const tSummary = tOptions ? buildTransportSummary(tOptions, tShipments ?? undefined) : null;
                  const totalShippingCents = tSummary?.totalShippingCents ?? 0;
                  const transportSelections = tSummary?.selections ?? [];

                  return (
                    <div
                      key={opt.placementOptionId}
                      className={`border rounded-lg overflow-hidden transition-opacity ${
                        isConfirmed
                          ? 'border-positive/30 bg-positive/5'
                          : anotherConfirmed
                            ? 'border-border-subtle/30 bg-bg-elevated opacity-50'
                            : 'border-border-subtle bg-bg-elevated'
                      }`}
                    >
                      {/* Row */}
                      <div
                        className={`flex items-center gap-3 px-4 py-3 transition-colors select-none ${anotherConfirmed ? '' : 'cursor-pointer hover:bg-bg-surface/50'} ${isSelected ? 'bg-bg-surface/30' : ''}`}
                        onClick={() => { if (!anotherConfirmed) handleSelectOption(opt.placementOptionId); }}
                      >
                        <span className="text-sm font-semibold text-text-primary shrink-0">Option {idx + 1}</span>

                        {isConfirmed && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-positive/10 text-positive border border-positive/30 shrink-0">✓ CONFIRMED</span>
                        )}
                        {anotherConfirmed && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-text-muted/10 text-text-muted border border-text-muted/20 shrink-0">EXPIRED</span>
                        )}

                        <span className="text-xs text-text-secondary shrink-0">
                          Inbound <span className="font-semibold text-text-primary">{formatCurrency(placementFee)}</span>
                        </span>

                        {/* Shipping + total — shown for any option with transport data
                            loaded (preview for unconfirmed, real for confirmed) */}
                        {tLoading && (
                          <span className="text-xs text-text-muted flex items-center gap-1 shrink-0">
                            <Loader2 size={10} className="animate-spin" /> loading shipping…
                          </span>
                        )}
                        {tSummary && totalShippingCents > 0 && (
                          <span className="text-xs text-text-secondary shrink-0">
                            + Ship{!isConfirmed ? ' (est.)' : ''} <span className="font-semibold text-text-primary">{formatCurrency(totalShippingCents)}</span>
                            {' = '}
                            <span className="font-bold text-text-primary">{formatCurrency(placementFee + totalShippingCents)}</span>
                          </span>
                        )}

                        <span className="text-xs text-text-muted shrink-0">
                          {opt.shipmentIds.length} Shipment{opt.shipmentIds.length !== 1 ? 's' : ''}
                        </span>

                        {/* Shipment chips — FC codes come from the placement GET's
                            per-shipment meta (available pre-confirmation), enriched
                            by transport data once loaded */}
                        <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
                          {opt.shipmentIds.map((sid, si) => {
                            const fcCode =
                              tSummary?.perShipment.find((p) => p.shipmentId === sid)?.fcCode
                              ?? derivedShipmentMeta[sid]?.fcCode
                              ?? null;
                            const fcState = derivedShipmentMeta[sid]?.state ?? null;
                            return (
                              <span key={sid} className="text-[11px] px-2 py-0.5 bg-bg-surface rounded border border-border-subtle font-mono flex items-center gap-1 shrink-0">
                                Shipment {si + 1}
                                {tLoading ? (
                                  <Loader2 size={10} className="animate-spin text-text-muted ml-0.5" />
                                ) : fcCode ? (
                                  <span className="font-bold text-text-primary">
                                    · {fcCode}{fcState ? <span className="font-normal text-text-tertiary"> {fcState}</span> : null}
                                  </span>
                                ) : (
                                  <span className="text-text-muted/50">· —</span>
                                )}
                              </span>
                            );
                          })}
                        </div>

                        {!anotherConfirmed && (
                          <ChevronDown size={14} className={`text-text-muted shrink-0 transition-transform duration-200 ${isSelected ? 'rotate-180' : ''}`} />
                        )}
                      </div>

                      {/* Inspector — only for selected, non-expired options */}
                      {isSelected && !anotherConfirmed && (
                        <div className="border-t border-border-subtle bg-bg-surface/20 p-4 space-y-3">

                          {/* Case: loading */}
                          {tLoading && (
                            <div className="flex items-center gap-2 text-[11px] text-text-muted">
                              <Loader2 size={12} className="animate-spin" />
                              {isConfirmed ? 'Generating shipping options…' : 'Confirming placement and loading shipping options…'}
                            </div>
                          )}

                          {/* Case: error */}
                          {!tLoading && tError && (
                            <div className="space-y-2">
                              <div className="text-[11px] text-negative">{tError}</div>
                              {isConfirmed && (
                                <button
                                  onClick={() => handleLoadTransportForConfirmed(opt.placementOptionId)}
                                  disabled={!shipDate}
                                  className="h-7 px-3 bg-bg-surface border border-border-subtle rounded text-xs text-text-secondary hover:text-text-primary disabled:opacity-50 transition-colors"
                                >
                                  Retry
                                </button>
                              )}
                            </div>
                          )}

                          {/* Case: placement not yet confirmed — estimate (free) or commit */}
                          {!tLoading && !tError && !tData && !isConfirmed && (
                            <div className="space-y-2">
                              <p className="text-[11px] text-text-tertiary">
                                Get a shipping estimate first to compare total cost across options — it commits nothing.
                              </p>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => handleLoadTransportPreview(opt.placementOptionId)}
                                  disabled={!!confirmingBothId || !shipDate}
                                  className="h-8 px-4 bg-bg-surface border border-accent/40 text-accent rounded text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 hover:bg-accent/10"
                                >
                                  Get shipping estimate
                                </button>
                                <button
                                  onClick={() => handleConfirmAndLoadTransport(opt.placementOptionId)}
                                  disabled={!!confirmingBothId || !shipDate}
                                  className="h-8 px-4 bg-accent text-white rounded text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                                >
                                  {confirmingBothId === opt.placementOptionId && <Loader2 size={10} className="animate-spin" />}
                                  {confirmingBothId === opt.placementOptionId
                                    ? 'Confirming…'
                                    : 'Confirm placement and load shipping options'}
                                </button>
                              </div>
                              <p className="text-[10px] text-text-muted">
                                Confirming commits the {formatCurrency(placementFee)} inbound fee and creates real shipments on Amazon.
                              </p>
                            </div>
                          )}

                          {/* Case: placement confirmed, transport not yet loaded (page reload) */}
                          {!tLoading && !tError && !tData && isConfirmed && (
                            <div className="space-y-2">
                              <p className="text-[11px] text-text-tertiary">
                                Placement confirmed. Load shipping options to see carrier and cost.
                              </p>
                              <button
                                onClick={() => handleLoadTransportForConfirmed(opt.placementOptionId)}
                                disabled={!shipDate}
                                className="h-8 px-3 bg-bg-surface border border-border-subtle rounded text-xs text-text-secondary hover:text-text-primary disabled:opacity-50 transition-colors flex items-center gap-1.5"
                              >
                                Load shipping options
                              </button>
                            </div>
                          )}

                          {/* Case: transport loaded successfully */}
                          {!tLoading && tSummary && tSummary.perShipment.length > 0 && (
                            <>
                              {!tSummary.hasPartnerUps && (
                                <div className="text-[11px] text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded px-2 py-1">
                                  No Amazon partnered UPS SPD option available — showing best alternative.
                                </div>
                              )}

                              {/* Selected option summary per shipment */}
                              <div className="space-y-1">
                                {tSummary.perShipment.map((ps) => {
                                  const prec: string[] = Array.isArray(ps.best.preconditions) ? ps.best.preconditions : [];
                                  const needsWindow = prec.some((p) => p.toUpperCase().includes('DELIVERY_WINDOW'))
                                    || ps.best.shippingSolution === 'USE_YOUR_OWN_CARRIER';
                                  return (
                                    <div key={ps.shipmentId} className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] font-mono bg-bg-surface/30 rounded px-2 py-1">
                                      <span className="text-text-muted">{ps.shipmentId.slice(-8)}</span>
                                      <span className={ps.best.shippingSolution === 'AMAZON_PARTNERED_CARRIER' ? 'text-positive' : 'text-amber-400'}>
                                        {ps.best.shippingSolution || '?'}
                                      </span>
                                      <span className="text-text-tertiary">{ps.best.shippingMode || '?'}</span>
                                      <span>{ps.best.carrier?.name || '?'}</span>
                                      {ps.costCents > 0 && <span className="text-positive">{formatCurrency(ps.costCents)}</span>}
                                      {needsWindow && <span className="text-amber-400">⚠ DELIVERY_WINDOW</span>}
                                      {prec.length > 0 && !needsWindow && <span className="text-text-muted">[{prec.join(', ')}]</span>}
                                    </div>
                                  );
                                })}
                              </div>

                              <div className="space-y-2">
                                {tSummary.perShipment.map((ps, si) => {
                                  const warehouseAddr = tShipments?.find((s: any) => s.shipmentId === ps.shipmentId)?.destinationWarehouseAddress;
                                  const displayCity = warehouseAddr?.city ?? ps.city;
                                  const displayState = warehouseAddr?.stateOrProvinceCode ?? ps.state;
                                  const displayPostal = warehouseAddr?.postalCode;
                                  return (
                                    <div key={ps.shipmentId} className="flex items-center justify-between text-[11px]">
                                      <div className="flex items-center gap-1.5 text-text-secondary">
                                        <span>Shipment {si + 1}</span>
                                        {(ps.fcCode || displayCity) && <span className="text-text-muted">→</span>}
                                        {ps.fcCode && <span className="font-mono font-bold text-text-primary">{ps.fcCode}</span>}
                                        {displayCity && (
                                          <span className="text-text-tertiary">
                                            {displayCity}{displayState ? `, ${displayState}` : ''}{displayPostal ? ` ${displayPostal}` : ''}
                                          </span>
                                        )}
                                        {ps.best.carrier?.name && <span className="text-text-muted">· {ps.best.carrier.name}</span>}
                                        {ps.best.shippingMode && (
                                          <span className="text-[10px] text-text-muted/60">({ps.best.shippingMode.replace(/_/g, ' ')})</span>
                                        )}
                                      </div>
                                      <span className="font-mono text-text-secondary">
                                        {ps.costCents > 0 ? formatCurrency(ps.costCents) : '—'}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>

                              <div className="border-t border-border-subtle pt-2 space-y-1">
                                <div className="flex justify-between text-[11px] text-text-secondary">
                                  <span>Shipping</span>
                                  <span className="font-mono">{formatCurrency(totalShippingCents)}</span>
                                </div>
                                <div className="flex justify-between text-[11px] text-text-secondary">
                                  <span>Inbound placement</span>
                                  <span className="font-mono">{formatCurrency(placementFee)}</span>
                                </div>
                                <div className="flex justify-between text-[11px] font-semibold text-text-primary">
                                  <span>Total estimated</span>
                                  <span className="font-mono">{formatCurrency(placementFee + totalShippingCents)}</span>
                                </div>
                              </div>

                              {/* Preview-loaded UNCONFIRMED option: the next step is
                                  confirming placement (which re-generates real transport
                                  quotes) — confirming transportation directly would fail. */}
                              {!isConfirmed && (
                                <div className="space-y-2">
                                  <button
                                    onClick={() => handleConfirmAndLoadTransport(opt.placementOptionId)}
                                    disabled={!!confirmingBothId || !shipDate}
                                    className="w-full h-8 px-3 bg-accent text-white rounded text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                                  >
                                    {confirmingBothId === opt.placementOptionId && <Loader2 size={10} className="animate-spin" />}
                                    {confirmingBothId === opt.placementOptionId
                                      ? 'Confirming…'
                                      : `Confirm this option (${formatCurrency(placementFee)} inbound fee)`}
                                  </button>
                                  <p className="text-[10px] text-text-muted">
                                    Estimates above are non-binding. Confirming locks the placement and loads final quotes.
                                  </p>
                                </div>
                              )}

                              {isConfirmed && isPlacementPhase && batch.transportationStatus !== 'SUCCESS' && (() => {
                                // Full option objects for the server's delivery-window detector
                                const selectedOptionObjs = tSummary.perShipment.map((ps) => ps.best);
                                const anyNeedsWindow = tSummary.perShipment.some((ps) => {
                                  const prec: string[] = Array.isArray(ps.best.preconditions) ? ps.best.preconditions : [];
                                  return prec.some((p) => p.toUpperCase().includes('DELIVERY_WINDOW'))
                                    || ps.best.shippingSolution === 'USE_YOUR_OWN_CARRIER';
                                });
                                return (
                                  <div className="space-y-2">
                                    {anyNeedsWindow && (
                                      <div className="text-[11px] text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded px-2 py-1">
                                        Delivery window confirmation required — will run automatically before transportation confirmation.
                                      </div>
                                    )}
                                    <button
                                      onClick={() => onConfirmTransportation(transportSelections, selectedOptionObjs)}
                                      disabled={!!confirmingBothId || transportSelections.length === 0}
                                      className="w-full h-8 px-3 bg-accent text-white rounded text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                                    >
                                      {confirmingBothId === 'transport-only' && <Loader2 size={10} className="animate-spin" />}
                                      {confirmingBothId === 'transport-only'
                                        ? (anyNeedsWindow ? 'Confirming delivery windows + transportation…' : 'Confirming transportation…')
                                        : 'Confirm transportation'}
                                    </button>
                                  </div>
                                );
                              })()}

                              {batch.transportationStatus === 'SUCCESS' && (
                                <div className="flex items-center gap-2 text-[11px] text-positive">
                                  <CheckCircle size={12} /> Transportation confirmed
                                </div>
                              )}

                              <details className="text-[10px] text-text-muted border-t border-border-subtle pt-2">
                                <summary className="cursor-pointer select-none hover:text-text-tertiary mb-1">
                                  Dev: All transportation options ({tOptions?.length ?? 0})
                                </summary>
                                <div className="space-y-1 max-h-48 overflow-y-auto mt-1">
                                  {tOptions?.map((o, i) => {
                                    const d = extractDestination(o);
                                    return (
                                      <div key={i} className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono bg-bg-surface/50 rounded px-2 py-1 text-[9px]">
                                        <span className="text-text-muted/60">{(o.transportationOptionId || '?').slice(-8)}</span>
                                        <span className="text-text-muted/60">{o.shipmentId?.slice(-8) || '?'}</span>
                                        <span className="text-text-tertiary">{o.shippingMode || '?'}</span>
                                        <span className="text-text-tertiary">{o.shippingSolution || '?'}</span>
                                        <span>{o.carrier?.name || '?'}</span>
                                        {o.quote?.cost?.amount != null && <span className="text-positive">${o.quote.cost.amount}</span>}
                                        {d.fcCode && <span className="text-accent">{d.fcCode}</span>}
                                        {d.city && <span className="text-blue-400">{d.city}{d.state ? `, ${d.state}` : ''}</span>}
                                        {d.foundAt.length > 0 && <span className="text-text-muted/40">[{d.foundAt.join(' ')}]</span>}
                                        {Array.isArray(o.preconditions) && o.preconditions.length > 0 && (
                                          <span className="text-amber-400">⚠ {(o.preconditions as string[]).join(', ')}</span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </details>

                              {/* Dev: raw getShipment destination data */}
                              {tShipments && tShipments.length > 0 && (
                                <details className="text-[10px] text-text-muted border-t border-border-subtle pt-2">
                                  <summary className="cursor-pointer select-none hover:text-text-tertiary mb-1">
                                    Dev: getShipment destination data ({tShipments.length})
                                  </summary>
                                  <div className="space-y-1 mt-1 font-mono text-[9px]">
                                    {tShipments.map((s: any, i: number) => {
                                      const addr = s.destinationWarehouseAddress;
                                      return (
                                        <div key={i} className="bg-bg-surface/50 rounded px-2 py-1 flex flex-wrap gap-x-3 gap-y-0.5">
                                          <span className="text-text-muted/60">{s.shipmentId?.slice(-8)}</span>
                                          {addr ? (
                                            <>
                                              <span className="text-blue-400">{addr.addressLine1 || ''}</span>
                                              <span className="text-blue-400">{addr.city}, {addr.stateOrProvinceCode} {addr.postalCode}</span>
                                            </>
                                          ) : (
                                            <span className="text-amber-400">no destinationWarehouseAddress</span>
                                          )}
                                          {s.shipmentConfirmationId && <span className="text-positive">conf:{s.shipmentConfirmationId.slice(-8)}</span>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </details>
                              )}
                            </>
                          )}

                          {/* No valid options after filtering */}
                          {!tLoading && tSummary && tSummary.perShipment.length === 0 && (
                            <div className="space-y-2">
                              <div className="text-[11px] text-text-muted italic">No valid SPD options after filtering — all options below:</div>
                              <div className="space-y-1">
                                {tOptions?.map((o, i) => (
                                  <div key={i} className="text-[10px] font-mono bg-bg-surface/50 rounded px-2 py-1 text-text-muted">
                                    {o.shippingMode} / {o.shippingSolution} / {o.carrier?.name} / {o.quote?.cost?.amount ?? 'no quote'}
                                    {Array.isArray(o.preconditions) && o.preconditions.length > 0 && ` ⚠ ${(o.preconditions as string[]).join(', ')}`}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {batch.placementError && (
            <div className="text-[11px] text-negative bg-negative/5 border border-negative/30 rounded p-2 font-mono">
              Placement error: {batch.placementError}
            </div>
          )}

          {/* Amazon debug panel — shows raw API response for diagnosing data shape */}
          {placementDebug && (
            <details className="text-[11px] border border-border-subtle rounded">
              <summary className="px-3 py-2 cursor-pointer text-text-muted hover:text-text-tertiary select-none">
                Amazon debug data
              </summary>
              <pre className="p-3 overflow-x-auto text-[10px] text-text-muted bg-bg-base max-h-96 overflow-y-auto leading-relaxed">
                {JSON.stringify(placementDebug, null, 2)}
              </pre>
            </details>
          )}

          {isShippingPhase && (
            <>
              <div className="border border-positive/30 bg-positive/5 rounded p-3">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle size={14} className="text-positive" />
                  <span className="text-xs font-medium text-positive">
                    Placement confirmed
                    {shipments.length > 0 && ` — ${shipments.length} shipment${shipments.length === 1 ? '' : 's'}`}
                  </span>
                </div>
              </div>

              {/* ─── Transportation step ─────────────────────────────────── */}
              {transportationStatus !== 'SUCCESS' ? (
                <div className="border border-amber-500/40 bg-amber-500/5 rounded p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertCircle size={14} className="text-amber-400 shrink-0" />
                    <span className="text-xs font-medium text-amber-400">Transportation step required</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary">
                    Amazon requires <code className="bg-bg-surface px-1 rounded">generateTransportationOptions</code> +{' '}
                    <code className="bg-bg-surface px-1 rounded">confirmTransportationOptions</code> before Seller Central
                    will allow shipment completion. This takes ~30 seconds.
                  </p>
                  <div className="flex items-end gap-3">
                    <div>
                      <label className="text-[10px] text-amber-400/70 uppercase tracking-wider block mb-1">Ship Date</label>
                      <input
                        type="date"
                        value={shipDate}
                        min={new Date().toISOString().slice(0, 10)}
                        onChange={(e) => setShipDate(e.target.value)}
                        className="h-7 px-2 bg-bg-surface border border-amber-500/30 rounded text-xs text-text-primary focus:outline-none focus:border-amber-500"
                      />
                    </div>
                    <button
                      onClick={handleCompleteTransportation}
                      disabled={completingTransport || !shipDate}
                      className="h-7 px-3 bg-amber-500 text-white rounded text-[11px] font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                    >
                      {completingTransport && <Loader2 size={10} className="animate-spin" />}
                      {completingTransport ? 'Confirming transportation…' : 'Complete Transportation Step'}
                    </button>
                  </div>
                  {transportationError && (
                    <div className="text-[11px] text-negative bg-negative/5 border border-negative/30 rounded p-2 font-mono break-all">
                      {transportationError}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Transportation confirmed summary */}
                  <div className="border border-positive/20 bg-positive/5 rounded px-3 py-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <CheckCircle size={12} className="text-positive" />
                      <span className="text-[11px] text-positive font-medium">Transportation confirmed — Seller Central is now unlocked</span>
                    </div>
                    {confirmedShipmentData.length > 0 && (() => {
                      const totalCost = confirmedShipmentData.reduce((sum, cs) => sum + (cs.cost ?? 0), 0);
                      const carrier = confirmedShipmentData.find(cs => cs.carrier)?.carrier;
                      const solution = confirmedShipmentData.find(cs => cs.shippingSolution)?.shippingSolution;
                      return (
                        <div className="text-[11px] text-text-secondary flex flex-wrap gap-x-3 gap-y-0.5">
                          <span>{confirmedShipmentData.length} destination{confirmedShipmentData.length > 1 ? 's' : ''}</span>
                          {carrier && <span>· {carrier}{solution === 'AMAZON_PARTNERED_CARRIER' ? ' (partnered)' : ''}</span>}
                          {totalCost > 0 && <span>· Est. carrier charges: ${totalCost.toFixed(2)}</span>}
                        </div>
                      );
                    })()}
                  </div>
                  {/* Open in Seller Central */}
                  {batch.inboundPlanId && (
                    <a
                      href={`https://sellercentral.amazon.com/fba/sendtoamazon/confirm_content?wf=SEND&reference_id=${batch.inboundPlanId}`}
                      target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-[11px] text-accent hover:underline"
                    >
                      <ExternalLink size={10} />
                      Open in Seller Central
                    </a>
                  )}
                </>
              )}

              {/* Per-shipment print cards */}
              {shipments.length === 0 ? (
                <div className="text-[11px] text-text-tertiary italic">Loading shipments…</div>
              ) : (
                <div className="space-y-2">
                  {shipments.map((s) => {
                    const dest = s.destination;
                    const fcCode = s.destinationFC;
                    const destLabel = dest?.city
                      ? `${fcCode ? fcCode + ' · ' : ''}${dest.city}, ${dest.stateOrProvinceCode || ''}`
                      : (fcCode || 'Destination TBD');
                    return (
                      <div key={s.shipmentId} className="border border-border-subtle rounded-lg bg-bg-elevated p-3">
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            {/* Show confirmationId (FBA19...) prominently, v2024 UUID secondary */}
                            <div className="text-xs font-medium text-text-primary font-mono">
                              {s.confirmationId || s.shipmentId}
                            </div>
                            <div className="text-[11px] text-text-tertiary mt-0.5">
                              <MapPin size={10} className="inline mr-0.5" />
                              {destLabel}
                              {s.boxCount != null && <> · {s.boxCount} box{s.boxCount === 1 ? '' : 'es'}</>}
                              {s.carrier && <> · {s.carrier}{s.cost != null ? ` $${s.cost.toFixed(2)}` : ''}</>}
                            </div>
                          </div>
                          <span className="text-[10px] text-text-tertiary uppercase tracking-wider px-1.5 py-0.5 bg-bg-surface rounded">
                            {s.status}
                          </span>
                        </div>

                        {/* Print actions */}
                        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border-subtle">
                          {/* FNSKU unit labels */}
                          <select
                            value={fnskuLabelFormat}
                            onChange={(e) => setFnskuLabelFormat(e.target.value as 'thermal' | 'letter-30up')}
                            className="h-7 px-1.5 bg-bg-surface border border-border-default rounded text-[11px] text-text-secondary"
                            title="FNSKU label format"
                          >
                            <option value="letter-30up">30-up Letter</option>
                            <option value="thermal">2×1 Thermal</option>
                          </select>
                          <button
                            onClick={() => handlePrintFnskuShipmentLabels('print')}
                            disabled={printingFnskuShipment}
                            className="h-7 px-2.5 bg-accent text-white rounded text-[11px] font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors flex items-center gap-1"
                            title="Print FNSKU per-unit labels (applied over original UPC on each product)"
                          >
                            {printingFnskuShipment ? <Loader2 size={10} className="animate-spin" /> : null}
                            Print FNSKU labels
                          </button>
                          <button
                            onClick={() => handlePrintFnskuShipmentLabels('download')}
                            className="h-7 px-2 bg-bg-surface border border-border-default rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                            title="Download FNSKU unit labels as PDF"
                          >
                            Download FNSKU PDF
                          </button>
                          <span className="text-text-tertiary text-[11px]">·</span>
                          {/* Box/carton labels */}
                          <select
                            value={boxLabelFormat}
                            onChange={(e) => setBoxLabelFormat(e.target.value)}
                            className="h-7 px-1.5 bg-bg-surface border border-border-default rounded text-[11px] text-text-secondary"
                            title="Box label format"
                          >
                            <option value="PackageLabel_Thermal_NonPCP">4×6 Thermal</option>
                            <option value="PackageLabel_Plain_Paper">Plain Paper</option>
                          </select>
                          <button
                            onClick={() => handlePrintLabels(s.shipmentId, 'box')}
                            disabled={printingLabel === `box-${s.shipmentId}`}
                            className="h-7 px-2.5 bg-bg-surface border border-border-default rounded text-[11px] font-medium text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors flex items-center gap-1"
                            title="Print box/carton labels to Rollo (2D barcode taped to outside of each box)"
                          >
                            {printingLabel === `box-${s.shipmentId}` ? <Loader2 size={10} className="animate-spin" /> : null}
                            Print box labels
                          </button>
                          <button
                            onClick={() => handleDownloadLabels(s.shipmentId, 'box')}
                            className="h-7 px-2 bg-bg-surface border border-border-default rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                            title="Download box/carton labels as PDF"
                          >
                            Download box label PDF
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Fallback: still expose Seller Central in case anything fails */}
              {batch.inboundPlanId && (
                <a
                  href="https://sellercentral.amazon.com/fba/inboundshipments"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-accent hover:underline"
                >
                  <ExternalLink size={10} /> Or open in Seller Central
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── PrintRowButton ─────────────────────────────────────────────────────────
// Per-row FNSKU print picker. Click the package icon → small popover opens
// with a quantity input + "Print all (N)" / "Print 1" shortcuts. Defaults to
// the row's full quantity; user can type any number for partial reprints.
function PrintRowButton({
  defaultQty,
  isPrinting,
  onPrint,
  onDownload,
}: {
  defaultQty: number;
  isPrinting: boolean;
  onPrint: (copies: number) => void;
  onDownload: (copies: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(String(defaultQty));
  // Smart positioning: flip the popover above the trigger when the row is
  // near the bottom of the viewport and the default below-positioning would
  // get cut off. Decided on open via getBoundingClientRect().
  const [openAbove, setOpenAbove] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQty(String(defaultQty));
    // Decide direction: the popover is ~150-200px tall depending on shortcuts.
    // If there's < 220px below the trigger but more above, flip up.
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setOpenAbove(spaceBelow < 220 && spaceAbove > spaceBelow);
    }
  }, [open, defaultQty]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function go(action: 'print' | 'download') {
    const n = parseInt(qty);
    if (!Number.isFinite(n) || n < 1 || n > 200) {
      alert('Quantity must be 1–200');
      return;
    }
    setOpen(false);
    if (action === 'print') onPrint(n);
    else onDownload(n);
  }

  // Show the "All (N)" / "1 (replacement)" shortcuts only when they're
  // actually useful (i.e., qty > 1). For qty=1 rows the input already
  // contains 1 and both shortcuts are no-ops.
  const showShortcuts = defaultQty > 1;

  return (
    <div ref={ref} className="relative inline-flex justify-end">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        disabled={isPrinting}
        className="p-1 text-text-tertiary hover:text-accent hover:bg-accent/10 rounded transition-colors disabled:opacity-50"
        title={`Print FNSKU label (${defaultQty} unit${defaultQty === 1 ? '' : 's'})`}
      >
        {isPrinting ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
      </button>
      {open && (
        <div className={`absolute right-0 z-50 w-64 bg-bg-elevated border border-border-default rounded-md shadow-xl p-3 text-sm ${openAbove ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2">Print FNSKU labels</div>
          <div className="flex items-center gap-2 mb-2">
            <input
              type="number"
              min="1"
              max="200"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') go('print'); }}
              autoFocus
              className="w-20 h-8 px-2 bg-bg-surface border border-border-default rounded text-sm font-mono text-text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-[11px] text-text-tertiary">label{parseInt(qty) === 1 ? '' : 's'}</span>
          </div>
          {showShortcuts && (
            <div className="flex items-center gap-1 mb-2">
              <button
                onClick={() => setQty(String(defaultQty))}
                className="text-[11px] px-2 py-1 bg-bg-surface border border-border-default rounded hover:bg-bg-hover transition-colors"
                title={`Reset to all ${defaultQty} units`}
              >
                All ({defaultQty})
              </button>
              <button
                onClick={() => setQty('1')}
                className="text-[11px] px-2 py-1 bg-bg-surface border border-border-default rounded hover:bg-bg-hover transition-colors"
                title="Print just 1 — useful for replacing a damaged label"
              >
                1 (replacement)
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-border-subtle">
            <button
              onClick={() => go('download')}
              className="text-[11px] px-2 py-1.5 text-text-secondary hover:text-text-primary transition-colors"
            >
              Download PDF
            </button>
            <button
              onClick={() => go('print')}
              disabled={isPrinting}
              className="h-7 px-3 bg-accent text-white rounded text-xs font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              Print to Rollo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FnskuPrintButton ───────────────────────────────────────────────────────
// Split-button: primary action prints 1 label per SKU (Rollo dialog handles
// quantity). Caret opens a small menu for the other mode (1 per unit) plus
// PDF download options.
function FnskuPrintButton({
  printing,
  onPrint,
  onDownload,
}: {
  printing: boolean;
  onPrint: (mode: 'per-sku' | 'per-unit') => void;
  onDownload: (mode: 'per-sku' | 'per-unit') => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        onClick={() => onPrint('per-sku')}
        disabled={printing}
        className="flex items-center gap-2 h-9 pl-3 pr-2 bg-bg-elevated border border-border-default rounded-l-md border-r-0 text-sm text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors"
        title="Print 1 FNSKU label per unique SKU. Set the copy count at the Rollo print dialog."
      >
        {printing ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
        {printing ? 'Printing…' : 'Print FNSKU (1/SKU)'}
      </button>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={printing}
        className="flex items-center justify-center h-9 px-1.5 bg-bg-elevated border border-border-default rounded-r-md text-sm text-text-secondary hover:bg-bg-hover disabled:opacity-50 transition-colors"
        title="More label options"
        aria-label="More options"
      >
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-bg-elevated border border-border-default rounded-md shadow-xl py-1 text-sm">
          <button
            onClick={() => { setOpen(false); onPrint('per-unit'); }}
            className="w-full text-left px-3 py-2 hover:bg-bg-hover transition-colors"
          >
            <div className="text-text-primary">Print all units (pre-counted)</div>
            <div className="text-[11px] text-text-tertiary">One label per unit. No Rollo qty dialog.</div>
          </button>
          <div className="my-1 border-t border-border-subtle"></div>
          <button
            onClick={() => { setOpen(false); onDownload('per-sku'); }}
            className="w-full text-left px-3 py-2 hover:bg-bg-hover transition-colors"
          >
            <div className="text-text-secondary">Download PDF (1/SKU)</div>
          </button>
          <button
            onClick={() => { setOpen(false); onDownload('per-unit'); }}
            className="w-full text-left px-3 py-2 hover:bg-bg-hover transition-colors"
          >
            <div className="text-text-secondary">Download PDF (all units)</div>
          </button>
        </div>
      )}
    </div>
  );
}

function UnassignedItemRow({
  item,
  remaining,
  boxIndices,
  boxes,
  onAdd,
}: {
  item: BatchItem;
  remaining: number;
  boxIndices: number[];
  boxes: Box[];
  onAdd: (boxIdx: number, qty: number) => void;
}) {
  const [qty, setQty] = useState(remaining);
  const [targetBoxIdx, setTargetBoxIdx] = useState<number>(boxIndices[boxIndices.length - 1] ?? 0);

  // Reset qty when remaining changes (e.g. after a partial add)
  useEffect(() => { setQty(remaining); }, [remaining]);
  // Reset target box if it's no longer in this group's boxes
  useEffect(() => {
    if (!boxIndices.includes(targetBoxIdx)) {
      setTargetBoxIdx(boxIndices[boxIndices.length - 1] ?? 0);
    }
  }, [boxIndices, targetBoxIdx]);

  const canAdd = qty > 0 && qty <= remaining && boxIndices.length > 0;
  // Map global box index → display label (1-based within this group's section)
  const boxLabel = (idx: number) => `Box ${boxIndices.indexOf(idx) + 1}`;

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-text-primary truncate flex-1" title={item.productName || ''}>
        {item.productName || item.asin}
      </span>
      <MskuLink sku={item.sku} className="text-text-tertiary font-mono hover:text-accent hover:underline" />
      <span className="text-amber-400 font-mono w-14 text-right">{remaining} left</span>
      <input
        type="number"
        min="1"
        max={remaining}
        value={qty}
        onChange={(e) => setQty(Math.max(0, Math.min(remaining, parseInt(e.target.value) || 0)))}
        className="w-14 h-6 px-1 text-right bg-bg-surface border border-border-default rounded text-[11px] font-mono focus:outline-none focus:border-accent"
      />
      {boxIndices.length > 1 ? (
        <select
          value={targetBoxIdx}
          onChange={(e) => setTargetBoxIdx(parseInt(e.target.value))}
          className="h-6 px-1 bg-bg-surface border border-border-default rounded text-[11px] focus:outline-none focus:border-accent"
        >
          {boxIndices.map((idx) => (
            <option key={idx} value={idx}>{boxLabel(idx)}</option>
          ))}
        </select>
      ) : (
        <span className="text-text-tertiary text-[10px]">→ Box 1</span>
      )}
      <button
        onClick={() => canAdd && onAdd(targetBoxIdx, qty)}
        disabled={!canAdd}
        className="h-6 px-2 bg-accent/10 border border-accent/30 rounded text-[10px] text-accent hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Add
      </button>
    </div>
  );
}

function StepChip({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider ${
        done
          ? 'border-positive/30 text-positive bg-positive/5'
          : active
            ? 'border-accent/30 text-accent bg-accent/10'
            : 'border-border-subtle text-text-tertiary bg-bg-elevated'
      }`}
    >
      {done && <CheckCircle size={10} className="mr-1" />}
      {label}
    </span>
  );
}

function DimensionInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-widest text-text-tertiary">{label}</label>
      <input
        type="number"
        step="0.1"
        min="0"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full mt-0.5 h-8 px-2 bg-bg-surface border border-border-default rounded text-xs font-mono focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  );
}
