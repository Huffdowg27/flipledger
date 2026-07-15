'use client';

/**
 * Incoming — purchases on their way in (synced hourly from Airtable 💳 Orders).
 *
 * Receive flow: good units become inventory lots (entering FIFO/valuation at
 * that moment), issue units go to the Issues queue where each resolution is a
 * money-correct event. Overdue aging surfaces stalled eBay/Amazon orders while
 * refund windows are still open.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle, ChevronDown, Clock, ExternalLink, Link2, Loader2, Package, Printer, RefreshCw, Truck } from 'lucide-react';
import { ImageLightbox, type LightboxData } from '@/components/ui/ImageLightbox';
import { IdentifierChip, OrderReference } from '@/components/ui/IdentifierLinks';
import { PrintLabelIcon } from '@/components/ui/PrintLabel';

function fmt(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

interface IncomingRow {
  id: number;
  airtableRecordId: string | null;
  orderSource: string | null;
  orderRef: string | null;
  asin: string | null;
  sku: string | null;
  productName: string | null;
  imageUrl: string | null;
  quantity: number;
  quantityReceived: number;
  unitCostCents: number;
  orderedAt: string | null;
  trackingNumber: string | null;
  deliveryStatus: string | null;
  status: string;
  notes: string | null;
  daysOutstanding: number;
  overdue: boolean;
  remaining: number;
  skuInSellerCentral: boolean | null;
  liveSkusForAsin: Array<{ sku: string; status: string | null }>;
  reconciliationCandidates: ReconciliationCandidate[];
  highConfidenceReconciliation: boolean;
  bulkReconciliation: BulkReconciliation;
}

interface ReconciliationCandidate {
  inventoryLedgerId: number;
  asin: string | null;
  sku: string | null;
  quantity: number;
  quantityReceived: number;
  quantityRemaining: number;
  attributedUnits: number;
  availableToReconcile: number;
  buyPriceCents: number;
  datePurchased: string;
  receivedAt: string | null;
  binLocation: string | null;
  matchType: 'sku' | 'asin' | 'asin_date';
}

type BulkReconciliation =
  | {
      highConfidence: true;
      inventoryLedgerId: number;
      quantity: number;
      lotDate: string;
    }
  | {
      highConfidence: false;
      reason: string;
    };

interface BulkReconcileResult {
  purchaseId: number | null;
  success: boolean;
  status?: string | number;
  error?: string;
  inventoryLedgerId?: number;
  quantityReconciled?: number;
  replayed?: boolean;
}

interface IssueRow {
  id: number;
  incomingPurchaseId: number | null;
  asin: string | null;
  sku: string | null;
  quantity: number;
  issueType: string;
  note: string | null;
  status: string;
  resolution: string | null;
  refundCents: number | null;
  resolvedAt: string | null;
  createdAt: string;
  productName: string | null;
  orderRef: string | null;
  unitCostCents: number | null;
}

export default function IncomingPage() {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'incoming' | 'issues' | 'received'>('incoming');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/incoming');
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setData(d);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSyncNow() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch('/api/sync/airtable-purchases', { method: 'POST' });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      await load();
    } catch (err) {
      setError(String(err));
    }
    setSyncing(false);
  }

  const open: IncomingRow[] = data?.open ?? [];
  const issues: IssueRow[] = data?.issues ?? [];
  const received = data?.received ?? [];
  const stats = data?.stats;
  const highConfidenceRows = useMemo(
    () => open.filter((row) => row.bulkReconciliation?.highConfidence),
    [open],
  );
  const overdue = open.filter((r) => r.overdue);
  const onTrack = open.filter((r) => !r.overdue);
  const openIssues = issues.filter((i) => i.status === 'open');
  const [bulkReviewOpen, setBulkReviewOpen] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkReconcileResult[]>([]);

  const openBulkReview = () => {
    setBulkSelectedIds(new Set(highConfidenceRows.map((row) => row.id)));
    setBulkResults([]);
    setBulkReviewOpen(true);
  };

  const toggleBulkRow = (purchaseId: number, checked: boolean) => {
    setBulkSelectedIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(purchaseId);
      else next.delete(purchaseId);
      return next;
    });
  };

  async function handleBulkReconcile() {
    const selectedRows = highConfidenceRows.filter((row) => bulkSelectedIds.has(row.id));
    setBulkBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/incoming/bulk-reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedRows.map((row) => {
          const bulk = row.bulkReconciliation as Extract<BulkReconciliation, { highConfidence: true }>;
          return {
            purchaseId: row.id,
            inventoryLedgerId: bulk.inventoryLedgerId,
            quantity: bulk.quantity,
            expectedQuantityReceived: row.quantityReceived,
            receiptKey: crypto.randomUUID(),
          };
        })),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setBulkResults(d.results || []);
      await load();
    } catch (err) {
      setError(String(err));
    }
    setBulkBusy(false);
  }

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Incoming</h1>
        <button
          onClick={handleSyncNow}
          disabled={syncing}
          className="h-8 px-3 bg-bg-elevated border border-border-default rounded text-xs text-text-secondary hover:text-text-primary flex items-center gap-1.5 disabled:opacity-50"
        >
          {syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {syncing ? 'Syncing from Airtable…' : 'Sync now'}
        </button>
      </div>
      <p className="text-sm text-text-tertiary mb-5">
        Purchases from Airtable 💳 Orders — receive here to create inventory lots.
      </p>

      {error && (
        <div className="text-xs text-negative bg-negative/5 border border-negative/30 rounded p-2 mb-4 whitespace-pre-wrap">{error}</div>
      )}

      {/* Purchased dashboard + money in flight */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          {[
            { label: 'Bought today', main: fmt(stats.purchasedToday.cents), sub: `${stats.purchasedToday.units} units · est. profit ${fmt(stats.purchasedToday.profitCents)}` },
            { label: 'This week', main: fmt(stats.purchasedWeek.cents), sub: `${stats.purchasedWeek.units} units · est. profit ${fmt(stats.purchasedWeek.profitCents)}` },
            { label: 'This month', main: fmt(stats.purchasedMonth.cents), sub: `${stats.purchasedMonth.units} units · est. profit ${fmt(stats.purchasedMonth.profitCents)}` },
            { label: 'On order', main: fmt(stats.onOrderCents), sub: `${stats.onOrderUnits} units incoming` },
            { label: `Overdue (${stats.overdueDays}d+)`, main: fmt(stats.overdueCents), sub: `${stats.overdueCount} orders`, alert: stats.overdueCount > 0 },
            { label: 'Open issues', main: fmt(stats.openIssuesCents), sub: `${stats.openIssuesCount} unresolved`, alert: stats.openIssuesCount > 0 },
          ].map((c: any) => (
            <div key={c.label} className={`bg-bg-elevated border rounded-lg p-3 border-t-2 ${c.alert ? 'border-amber-500/40 border-t-amber-400' : 'border-border-subtle border-t-accent'}`}>
              <div className="text-[10px] text-text-muted uppercase tracking-wider mb-1">{c.label}</div>
              <div className="text-base font-semibold text-text-primary font-mono">{c.main}</div>
              <div className="text-[10px] text-text-tertiary mt-0.5">{c.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 flex-wrap">
        {([['incoming', `Incoming (${open.length})`], ['issues', `Issues (${openIssues.length})`], ['received', 'Recently received']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`h-8 px-3 rounded text-xs font-medium transition-colors ${tab === key ? 'bg-accent/15 text-accent border border-accent/40' : 'text-text-secondary hover:text-text-primary border border-transparent'}`}
          >
            {label}
          </button>
        ))}
        {tab === 'incoming' && highConfidenceRows.length > 0 && (
          <button
            type="button"
            onClick={openBulkReview}
            className="h-8 px-3 ml-auto rounded bg-amber-500/15 border border-amber-500/40 text-xs font-semibold text-amber-300 hover:bg-amber-500/20 flex items-center gap-1.5"
          >
            <Link2 size={12} />
            Review & link all ({highConfidenceRows.length})
          </button>
        )}
      </div>

      {loading && <div className="flex items-center gap-2 text-sm text-text-tertiary"><Loader2 size={14} className="animate-spin" /> Loading…</div>}

      {!loading && tab === 'incoming' && (
        <div className="space-y-5">
          {bulkReviewOpen && (highConfidenceRows.length > 0 || bulkResults.length > 0) && (
            <BulkReconcileReview
              rows={highConfidenceRows}
              selectedIds={bulkSelectedIds}
              results={bulkResults}
              busy={bulkBusy}
              onToggle={toggleBulkRow}
              onClose={() => setBulkReviewOpen(false)}
              onConfirm={handleBulkReconcile}
            />
          )}
          {open.length === 0 && (
            <p className="text-sm text-text-tertiary italic">
              Nothing incoming. Punch purchases into Airtable 💳 Orders and they appear here within the hour (or hit Sync now).
            </p>
          )}
          {overdue.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Clock size={12} /> Overdue — check the order, refund windows close
              </h2>
              <div className="space-y-2">
                {overdue.map((r) => <IncomingCard key={r.id} row={r} onChanged={load} />)}
              </div>
            </section>
          )}
          {onTrack.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Truck size={12} /> On order
              </h2>
              <div className="space-y-2">
                {onTrack.map((r) => <IncomingCard key={r.id} row={r} onChanged={load} />)}
              </div>
            </section>
          )}
        </div>
      )}

      {!loading && tab === 'issues' && (
        <div className="space-y-2">
          {issues.length === 0 && <p className="text-sm text-text-tertiary italic">No receiving issues. 🎉</p>}
          {issues.map((i) => <IssueCard key={i.id} issue={i} onChanged={load} />)}
        </div>
      )}

      {!loading && tab === 'received' && (
        <div className="space-y-1">
          {received.length === 0 && <p className="text-sm text-text-tertiary italic">Nothing received yet.</p>}
          {received.map((r: any) => (
            <div key={r.id} className="flex items-center gap-3 text-xs bg-bg-elevated border border-border-subtle rounded px-3 py-2">
              {r.status === 'cancelled' ? <AlertCircle size={12} className="text-text-muted shrink-0" /> : <CheckCircle size={12} className="text-positive shrink-0" />}
              <span className="text-text-primary truncate">{r.productName || r.sku || r.asin}</span>
              <span className="text-text-muted font-mono shrink-0">{r.quantityReceived}/{r.quantity}</span>
              <span className="text-text-tertiary font-mono shrink-0">{fmt(r.unitCostCents * r.quantity)}</span>
              <span className="text-text-muted ml-auto shrink-0">{r.status === 'cancelled' ? 'cancelled' : `received ${r.receivedAt?.slice(0, 10) ?? ''}`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BulkReconcileReview({
  rows,
  selectedIds,
  results,
  busy,
  onToggle,
  onClose,
  onConfirm,
}: {
  rows: IncomingRow[];
  selectedIds: Set<number>;
  results: BulkReconcileResult[];
  busy: boolean;
  onToggle: (purchaseId: number, checked: boolean) => void;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const selectedCount = rows.filter((row) => selectedIds.has(row.id)).length;

  return (
    <section className="border border-amber-500/30 bg-amber-500/5 rounded-lg">
      <div className="px-3 py-2.5 border-b border-amber-500/20 flex items-center gap-2">
        <Link2 size={13} className="text-amber-400 shrink-0" />
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-amber-300">Review & link all</h2>
          <p className="text-[11px] text-text-tertiary">Exact SKU, one lot, received after order, enough unlinked units.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto h-7 px-2 rounded border border-border-subtle text-[10px] text-text-secondary hover:text-text-primary"
        >
          Close
        </button>
      </div>

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="text-text-muted uppercase tracking-wider border-b border-border-subtle">
              <tr>
                <th className="w-8 px-3 py-2 text-left">
                  <span className="sr-only">Selected</span>
                </th>
                <th className="px-2 py-2 text-left font-medium">Product</th>
                <th className="px-2 py-2 text-left font-medium">Order</th>
                <th className="px-2 py-2 text-left font-medium">SKU</th>
                <th className="px-2 py-2 text-left font-medium">Ordered</th>
                <th className="px-2 py-2 text-left font-medium">Lot</th>
                <th className="px-2 py-2 text-left font-medium">Lot received</th>
                <th className="px-3 py-2 text-right font-medium">Units</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map((row) => {
                const bulk = row.bulkReconciliation as Extract<BulkReconciliation, { highConfidence: true }>;
                return (
                  <tr key={row.id} className="text-text-secondary">
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(row.id)}
                        onChange={(event) => onToggle(row.id, event.target.checked)}
                      />
                    </td>
                    <td className="px-2 py-2 align-top text-text-primary min-w-[220px] max-w-[320px]">
                      <span className="block truncate">{row.productName || row.sku || row.asin || 'Unknown item'}</span>
                    </td>
                    <td className="px-2 py-2 align-top font-mono text-text-tertiary whitespace-nowrap">{row.orderRef || `#${row.id}`}</td>
                    <td className="px-2 py-2 align-top font-mono whitespace-nowrap">{row.sku}</td>
                    <td className="px-2 py-2 align-top whitespace-nowrap">{row.orderedAt?.slice(0, 10) || '—'}</td>
                    <td className="px-2 py-2 align-top font-mono whitespace-nowrap">#{bulk.inventoryLedgerId}</td>
                    <td className="px-2 py-2 align-top whitespace-nowrap">{bulk.lotDate.slice(0, 10)}</td>
                    <td className="px-3 py-2 align-top text-right font-mono text-text-primary">{bulk.quantity}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="px-3 py-2.5 border-t border-border-subtle flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || selectedCount === 0}
          className="h-8 px-3 rounded bg-amber-500/15 border border-amber-500/40 text-xs font-semibold text-amber-300 disabled:opacity-40 flex items-center gap-1.5"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
          Link {selectedCount} selected
        </button>
        <span className="text-[10px] text-text-muted">This records receipt identity only; inventory lots, cost, and FIFO stay unchanged.</span>
      </div>

      {results.length > 0 && (
        <div className="px-3 pb-3 space-y-1">
          {results.map((result, index) => (
            <div
              key={`${result.purchaseId ?? 'row'}-${index}`}
              className={`text-[11px] rounded border px-2 py-1 ${result.success ? 'border-positive/30 bg-positive/5 text-positive' : 'border-negative/30 bg-negative/5 text-negative'}`}
            >
              {result.success
                ? `Purchase #${result.purchaseId} linked ${result.quantityReconciled} units to lot #${result.inventoryLedgerId}${result.replayed ? ' (replay)' : ''}.`
                : `Purchase #${result.purchaseId ?? '?'} failed: ${result.error}`}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── IncomingCard ───────────────────────────────────────────────────────────

function IncomingCard({ row, onChanged }: { row: IncomingRow; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [good, setGood] = useState(String(row.remaining));
  const [issueQty, setIssueQty] = useState('0');
  const [issueType, setIssueType] = useState('damaged');
  const [issueNote, setIssueNote] = useState('');
  const [bin, setBin] = useState('');
  const [skuChoice, setSkuChoice] = useState(row.sku || '');
  const [showReconcile, setShowReconcile] = useState(false);
  const [selectedLotId, setSelectedLotId] = useState('');
  const [reconcileQty, setReconcileQty] = useState(String(row.remaining));
  const [reconcileConfirmed, setReconcileConfirmed] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastReceiveLabelHref, setLastReceiveLabelHref] = useState<string | null>(null);

  const skuMismatch = row.sku != null && row.skuInSellerCentral === false && row.liveSkusForAsin.length > 0;
  const needsSku = !row.sku && row.liveSkusForAsin.length !== 1;
  const candidates = row.reconciliationCandidates || [];
  const selectedCandidate = candidates.find((candidate) => String(candidate.inventoryLedgerId) === selectedLotId);

  function toggleReconcileReview() {
    const nextOpen = !showReconcile;
    setShowReconcile(nextOpen);
    if (!nextOpen) return;
    const availableCandidates = candidates.filter((candidate) => candidate.availableToReconcile > 0);
    if (availableCandidates.length === 1) {
      const [candidate] = availableCandidates;
      setSelectedLotId(String(candidate.inventoryLedgerId));
      setReconcileQty(String(Math.min(row.remaining, candidate.availableToReconcile)));
      setReconcileConfirmed(false);
    }
  }

  async function act(body: any, label: string) {
    setBusy(label);
    setErr(null);
    try {
      const res = await fetch(`/api/incoming/${row.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      await onChanged();
      if (label === 'receive' && (parseInt(good) || 0) > 0 && row.asin) {
        const labelRow = [
          row.asin,
          d.sku || skuChoice || row.sku || '',
          row.productName || row.asin,
          '',
          bin || '',
          '',
          String(parseInt(good) || 1),
        ].join(' | ');
        setLastReceiveLabelHref(`/labels?mode=warehouse&row=${encodeURIComponent(labelRow)}`);
      }
    } catch (e) {
      setErr(String(e));
    }
    setBusy(null);
  }

  return (
    <div className={`border rounded-lg bg-bg-elevated ${row.overdue ? 'border-amber-500/30' : 'border-border-subtle'}`}>
      <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none" onClick={() => setOpen((v) => !v)}>
        {row.imageUrl && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setLightbox({ src: row.imageUrl!, title: row.productName || row.sku || row.asin || '', asin: row.asin, sku: row.sku }); }}
            className="shrink-0 rounded overflow-hidden bg-white hover:ring-2 hover:ring-accent/40 transition-shadow"
            title="View larger"
          >
            <img src={row.imageUrl} alt="" className="w-8 h-8 object-cover block" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs text-text-primary truncate">{row.productName || row.sku || row.asin || 'Unknown item'}</div>
          <div className="text-[10px] text-text-tertiary flex items-center gap-2 flex-wrap mt-0.5">
            {row.orderSource && <span>{row.orderSource}</span>}
            {row.orderRef && <span className="font-mono">#{row.orderRef}</span>}
            {row.orderedAt && <span>ordered {row.orderedAt.slice(0, 10)}</span>}
            <span className={row.overdue ? 'text-amber-400 font-semibold' : ''}>{row.daysOutstanding}d outstanding</span>
            {row.deliveryStatus && <span className="text-text-muted">{row.deliveryStatus}</span>}
          </div>
        </div>
        {skuMismatch && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30 shrink-0" title="The stored SKU doesn't exist in Seller Central — pick the live SKU when receiving.">
            SKU MISMATCH
          </span>
        )}
        <div className="text-right shrink-0">
          <div className="text-xs font-mono text-text-primary">{row.remaining} of {row.quantity}</div>
          <div className="text-[10px] font-mono text-text-tertiary">{fmt(row.unitCostCents)} ea · {fmt(row.unitCostCents * row.remaining)}</div>
        </div>
        <ChevronDown size={14} className={`text-text-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </div>

      {open && (
        <div className="border-t border-border-subtle px-3 py-3 space-y-3">
          {/* Quick-copy identifiers for working the order in Amazon/elsewhere */}
          <div className="flex items-center gap-2 flex-wrap">
            <OrderReference orderId={row.orderRef} marketplace={row.orderSource} className="h-6 rounded border border-border-subtle bg-bg-surface px-2 text-[10px] font-mono" />
            <IdentifierChip label="ASIN" value={row.asin} kind="asin" className="h-6 rounded border border-border-subtle bg-bg-surface px-2 text-[10px] font-mono" />
            <IdentifierChip label="SKU" value={row.sku} kind="sku" className="h-6 rounded border border-border-subtle bg-bg-surface px-2 text-[10px] font-mono" />
            <span className="inline-flex h-6 items-center rounded border border-border-subtle bg-bg-surface px-2" title="Print item labels">
              <PrintLabelIcon item={{ title: row.productName, asin: row.asin, sku: row.sku }} qty={Math.max(1, row.remaining || 1)} />
            </span>
          </div>
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wider block mb-1">Good units</label>
              <input type="number" min="0" max={row.remaining} value={good} onChange={(e) => setGood(e.target.value)}
                className="h-8 w-20 px-2 bg-bg-surface border border-border-subtle rounded text-xs text-text-primary focus:outline-none focus:border-accent" />
            </div>
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wider block mb-1">Issue units</label>
              <input type="number" min="0" max={row.remaining} value={issueQty} onChange={(e) => setIssueQty(e.target.value)}
                className="h-8 w-20 px-2 bg-bg-surface border border-border-subtle rounded text-xs text-text-primary focus:outline-none focus:border-accent" />
            </div>
            {parseInt(issueQty) > 0 && (
              <>
                <div>
                  <label className="text-[10px] text-text-muted uppercase tracking-wider block mb-1">Issue type</label>
                  <select value={issueType} onChange={(e) => setIssueType(e.target.value)}
                    className="h-8 px-2 bg-bg-surface border border-border-subtle rounded text-xs text-text-primary focus:outline-none focus:border-accent">
                    <option value="damaged">Damaged</option>
                    <option value="wrong_item">Wrong item</option>
                    <option value="not_as_described">Not as described</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="flex-1 min-w-[160px]">
                  <label className="text-[10px] text-text-muted uppercase tracking-wider block mb-1">Issue note</label>
                  <input value={issueNote} onChange={(e) => setIssueNote(e.target.value)} placeholder="what's wrong"
                    className="h-8 w-full px-2 bg-bg-surface border border-border-subtle rounded text-xs text-text-primary focus:outline-none focus:border-accent" />
                </div>
              </>
            )}
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wider block mb-1">Bin</label>
              <input value={bin} onChange={(e) => setBin(e.target.value)} placeholder="R1-A3"
                className="h-8 w-20 px-2 bg-bg-surface border border-border-subtle rounded text-xs text-text-primary focus:outline-none focus:border-accent" />
            </div>
          </div>

          {/* SKU pick/relink — shown when stored SKU is missing or wrong */}
          {(skuMismatch || needsSku) && (
            <div className="space-y-1">
              <label className="text-[10px] text-amber-400 uppercase tracking-wider block">
                {skuMismatch ? `Stored SKU "${row.sku}" isn't in Seller Central — receive as:` : 'Pick the Seller Central SKU to receive against:'}
              </label>
              <div className="flex items-center gap-2 flex-wrap">
                {row.liveSkusForAsin.slice(0, 6).map((ls) => (
                  <button key={ls.sku} onClick={() => setSkuChoice(ls.sku)}
                    className={`h-7 px-2 rounded text-[10px] font-mono border transition-colors ${skuChoice === ls.sku ? 'bg-accent/15 border-accent text-accent' : 'bg-bg-surface border-border-subtle text-text-secondary hover:text-text-primary'}`}>
                    {ls.sku}{ls.status ? ` · ${ls.status}` : ''}
                  </button>
                ))}
                <input value={skuChoice} onChange={(e) => setSkuChoice(e.target.value)} placeholder="or type a SKU"
                  className="h-7 w-56 px-2 bg-bg-surface border border-border-subtle rounded text-[10px] font-mono text-text-primary focus:outline-none focus:border-accent" />
              </div>
            </div>
          )}

          {candidates.length > 0 && (
            <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
              <div className="flex items-start gap-2">
                <Link2 size={13} className="text-amber-400 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-amber-300">Possible existing inventory</div>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    A matching received lot already exists. Review it before receiving these units as new inventory.
                  </p>
                </div>
                <button type="button" onClick={toggleReconcileReview}
                  className="h-7 px-2 rounded border border-amber-500/30 text-[10px] font-semibold text-amber-300 hover:bg-amber-500/10">
                  {showReconcile ? 'Hide review' : 'Review lot'}
                </button>
              </div>

              {showReconcile && (
                <fieldset className="space-y-2">
                  <legend className="sr-only">Choose an existing inventory lot</legend>
                  {candidates.map((candidate) => (
                    <label key={candidate.inventoryLedgerId}
                      className={`flex items-start gap-2 rounded border p-2 text-[11px] ${candidate.availableToReconcile > 0 ? 'border-border-subtle bg-bg-surface cursor-pointer' : 'border-border-subtle/50 opacity-60'}`}>
                      <input type="radio" name={`reconcile-lot-${row.id}`} value={candidate.inventoryLedgerId}
                        checked={selectedLotId === String(candidate.inventoryLedgerId)}
                        disabled={candidate.availableToReconcile <= 0}
                        onChange={() => {
                          setSelectedLotId(String(candidate.inventoryLedgerId));
                          setReconcileQty(String(Math.min(row.remaining, candidate.availableToReconcile)));
                          setReconcileConfirmed(false);
                        }}
                        className="mt-0.5" />
                      <span className="min-w-0">
                        <span className="font-mono text-text-primary">Lot #{candidate.inventoryLedgerId}</span>
                        <span className="text-text-tertiary"> · received {candidate.receivedAt?.slice(0, 10) || candidate.datePurchased}</span>
                        {candidate.matchType === 'asin_date' && (
                          <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400" title={`Same ASIN bought within a few days — SKU differs (lot: ${candidate.sku || 'none'})`}>
                            ASIN + date match — SKU differs
                          </span>
                        )}
                        <span className="block text-text-muted">
                          {candidate.quantityReceived} received · {candidate.availableToReconcile} available to link
                          {candidate.binLocation ? ` · bin ${candidate.binLocation}` : ''}
                        </span>
                      </span>
                    </label>
                  ))}

                  <div className="flex items-end gap-3 flex-wrap">
                    <div>
                      <label htmlFor={`reconcile-qty-${row.id}`} className="text-[10px] text-text-muted uppercase tracking-wider block mb-1">Units already in lot</label>
                      <input id={`reconcile-qty-${row.id}`} type="number" min="1"
                        max={Math.min(row.remaining, selectedCandidate?.availableToReconcile || row.remaining)}
                        value={reconcileQty} onChange={(event) => setReconcileQty(event.target.value)}
                        className="h-8 w-20 px-2 bg-bg-surface border border-border-subtle rounded text-xs text-text-primary focus:outline-none focus:border-accent" />
                    </div>
                    <label className="flex items-center gap-2 text-[11px] text-text-secondary pb-2">
                      <input type="checkbox" checked={reconcileConfirmed}
                        onChange={(event) => setReconcileConfirmed(event.target.checked)} />
                      I verified these units are already in the selected lot.
                    </label>
                    <button type="button"
                      onClick={() => act({
                        action: 'reconcile',
                        receiptKey: crypto.randomUUID(),
                        expectedQuantityReceived: row.quantityReceived,
                        inventoryLedgerId: Number(selectedLotId),
                        quantity: Number(reconcileQty),
                        // ASIN+date suggestions have a differing SKU — the
                        // verify checkbox is the operator's explicit sign-off.
                        confirmMismatch: selectedCandidate?.sku !== row.sku,
                      }, 'reconcile')}
                      disabled={!!busy || !selectedCandidate || !reconcileConfirmed
                        || !Number.isInteger(Number(reconcileQty)) || Number(reconcileQty) <= 0
                        || Number(reconcileQty) > Math.min(row.remaining, selectedCandidate?.availableToReconcile || 0)}
                      className="h-8 px-3 rounded bg-amber-500/15 border border-amber-500/40 text-xs font-semibold text-amber-300 disabled:opacity-40 flex items-center gap-1.5">
                      {busy === 'reconcile' ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
                      Link without adding inventory
                    </button>
                  </div>
                  <p className="text-[10px] text-text-muted">This closes the Incoming quantity only. It does not change the lot, inventory count, cost, or FIFO.</p>
                </fieldset>
              )}
            </div>
          )}

          {err && <div role="alert" className="text-[11px] text-negative bg-negative/5 border border-negative/30 rounded px-2 py-1 whitespace-pre-wrap">{err}</div>}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => {
                if (candidates.length > 0 && !confirm('A matching received lot exists. Receive as NEW inventory only if these units are not already represented by that lot. Continue?')) return;
                act({
                  action: 'receive',
                  receiptKey: crypto.randomUUID(),
                  expectedQuantityReceived: row.quantityReceived,
                  quantityGood: parseInt(good) || 0,
                  quantityIssue: parseInt(issueQty) || 0,
                  issueType: parseInt(issueQty) > 0 ? issueType : undefined,
                  issueNote: issueNote || undefined,
                  sku: skuChoice || undefined,
                  binLocation: bin || undefined,
                }, 'receive');
              }}
              disabled={!!busy || ((parseInt(good) || 0) + (parseInt(issueQty) || 0)) === 0}
              className="h-8 px-4 bg-accent text-white rounded text-xs font-bold disabled:opacity-50 flex items-center gap-1.5"
            >
              {busy === 'receive' ? <Loader2 size={11} className="animate-spin" /> : <Package size={11} />}
              Receive
            </button>
            <button onClick={() => act({ action: 'snooze', days: 7 }, 'snooze')} disabled={!!busy}
              className="h-8 px-3 bg-bg-surface border border-border-subtle rounded text-xs text-text-secondary hover:text-text-primary disabled:opacity-50">
              Snooze 7d
            </button>
            <button
              onClick={() => { if (confirm('Mark as cancelled/refunded? No inventory lot will be created.')) act({ action: 'cancel' }, 'cancel'); }}
              disabled={!!busy}
              className="h-8 px-3 bg-bg-surface border border-negative/30 rounded text-xs text-negative/80 hover:text-negative disabled:opacity-50">
              Cancelled / refunded
            </button>
            {row.trackingNumber && (
              <a href={`https://www.google.com/search?q=${encodeURIComponent(row.trackingNumber)}`} target="_blank" rel="noopener noreferrer"
                className="text-[11px] text-text-tertiary hover:text-accent flex items-center gap-1 ml-auto">
                <ExternalLink size={10} /> {row.trackingNumber}
              </a>
            )}
          </div>
          {lastReceiveLabelHref && (
            <a href={lastReceiveLabelHref} className="inline-flex h-8 items-center gap-1.5 rounded border border-border-default bg-bg-surface px-3 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary">
              <Printer size={12} />
              Print labels
            </a>
          )}
        </div>
      )}
      <ImageLightbox data={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}

// ─── IssueCard ──────────────────────────────────────────────────────────────

const RESOLUTION_LABELS: Record<string, string> = {
  refunded_returned: 'Returned for refund',
  disposed: 'Disposed (write-off)',
  kept_partial_refund: 'Kept — partial refund',
  kept_as_is: 'Kept — sell as-is',
  no_impact: 'Resolved, no impact',
};

function IssueCard({ issue, onChanged }: { issue: IssueRow; onChanged: () => Promise<void> }) {
  const [resolution, setResolution] = useState('refunded_returned');
  const [refund, setRefund] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isOpen = issue.status === 'open';
  const needsRefund = resolution === 'refunded_returned' || resolution === 'kept_partial_refund';

  async function resolve() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/issues/${issue.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolution,
          refundCents: Math.round((parseFloat(refund) || 0) * 100),
          note: note || undefined,
        }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      await onChanged();
    } catch (e) {
      setErr(String(e));
    }
    setBusy(false);
  }

  return (
    <div className={`border rounded-lg bg-bg-elevated px-3 py-2.5 ${isOpen ? 'border-amber-500/30' : 'border-border-subtle opacity-70'}`}>
      <div className="flex items-center gap-2 text-xs flex-wrap">
        {isOpen ? <AlertCircle size={12} className="text-amber-400 shrink-0" /> : <CheckCircle size={12} className="text-positive shrink-0" />}
        <span className="text-text-primary truncate max-w-[280px]">{issue.productName || issue.sku || issue.asin}</span>
        <span className="font-mono text-text-tertiary">×{issue.quantity}</span>
        <span className="px-1.5 py-0.5 bg-bg-surface rounded text-[10px] uppercase tracking-wider text-text-secondary">{issue.issueType.replace(/_/g, ' ')}</span>
        {issue.unitCostCents != null && <span className="font-mono text-text-tertiary">{fmt(issue.unitCostCents * issue.quantity)} at stake</span>}
        {issue.orderRef && <span className="font-mono text-text-muted">#{issue.orderRef}</span>}
        <span className="text-text-muted ml-auto">{issue.createdAt?.slice(0, 10)}</span>
      </div>
      {issue.note && <div className="text-[11px] text-text-tertiary mt-1 whitespace-pre-wrap">{issue.note}</div>}

      {!isOpen && (
        <div className="text-[11px] text-text-secondary mt-1">
          {RESOLUTION_LABELS[issue.resolution || ''] || issue.resolution}
          {issue.refundCents ? ` · ${fmt(issue.refundCents)} refunded` : ''}
          {issue.resolvedAt ? ` · ${issue.resolvedAt.slice(0, 10)}` : ''}
        </div>
      )}

      {isOpen && (
        <div className="mt-2 pt-2 border-t border-border-subtle space-y-2">
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wider block mb-1">Resolution</label>
              <select value={resolution} onChange={(e) => setResolution(e.target.value)}
                className="h-8 px-2 bg-bg-surface border border-border-subtle rounded text-xs text-text-primary focus:outline-none focus:border-accent">
                {Object.entries(RESOLUTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {needsRefund && (
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wider block mb-1">Refund ($)</label>
                <input type="number" min="0" step="0.01" value={refund} onChange={(e) => setRefund(e.target.value)}
                  className="h-8 w-24 px-2 bg-bg-surface border border-border-subtle rounded text-xs text-text-primary focus:outline-none focus:border-accent" />
              </div>
            )}
            <div className="flex-1 min-w-[160px]">
              <label className="text-[10px] text-text-muted uppercase tracking-wider block mb-1">Note</label>
              <input value={note} onChange={(e) => setNote(e.target.value)}
                className="h-8 w-full px-2 bg-bg-surface border border-border-subtle rounded text-xs text-text-primary focus:outline-none focus:border-accent" />
            </div>
            <button onClick={resolve} disabled={busy}
              className="h-8 px-4 bg-accent text-white rounded text-xs font-bold disabled:opacity-50 flex items-center gap-1.5">
              {busy && <Loader2 size={11} className="animate-spin" />} Resolve
            </button>
          </div>
          <p className="text-[10px] text-text-muted">
            Returned → cost recovered. Disposed → write-off expense. Kept w/ partial refund → lot at reduced basis. Kept as-is → lot at full basis.
          </p>
          {err && <div className="text-[11px] text-negative whitespace-pre-wrap">{err}</div>}
        </div>
      )}
    </div>
  );
}
