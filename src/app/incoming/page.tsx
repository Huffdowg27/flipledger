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
import { AlertCircle, CheckCircle, ChevronDown, Clock, ExternalLink, Loader2, Package, RefreshCw, Truck } from 'lucide-react';

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
  const overdue = open.filter((r) => r.overdue);
  const onTrack = open.filter((r) => !r.overdue);
  const openIssues = issues.filter((i) => i.status === 'open');

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
            { label: 'Bought today', main: fmt(stats.purchasedToday.cents), sub: `${stats.purchasedToday.units} units · ${stats.purchasedToday.orders} orders` },
            { label: 'This week', main: fmt(stats.purchasedWeek.cents), sub: `${stats.purchasedWeek.units} units · ${stats.purchasedWeek.orders} orders` },
            { label: 'This month', main: fmt(stats.purchasedMonth.cents), sub: `${stats.purchasedMonth.units} units · ${stats.purchasedMonth.orders} orders` },
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
      <div className="flex items-center gap-1 mb-4">
        {([['incoming', `Incoming (${open.length})`], ['issues', `Issues (${openIssues.length})`], ['received', 'Recently received']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`h-8 px-3 rounded text-xs font-medium transition-colors ${tab === key ? 'bg-accent/15 text-accent border border-accent/40' : 'text-text-secondary hover:text-text-primary border border-transparent'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && <div className="flex items-center gap-2 text-sm text-text-tertiary"><Loader2 size={14} className="animate-spin" /> Loading…</div>}

      {!loading && tab === 'incoming' && (
        <div className="space-y-5">
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

// ─── IncomingCard ───────────────────────────────────────────────────────────

function IncomingCard({ row, onChanged }: { row: IncomingRow; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [good, setGood] = useState(String(row.remaining));
  const [issueQty, setIssueQty] = useState('0');
  const [issueType, setIssueType] = useState('damaged');
  const [issueNote, setIssueNote] = useState('');
  const [bin, setBin] = useState('');
  const [skuChoice, setSkuChoice] = useState(row.sku || '');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const skuMismatch = row.sku != null && row.skuInSellerCentral === false && row.liveSkusForAsin.length > 0;
  const needsSku = !row.sku && row.liveSkusForAsin.length !== 1;

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
    } catch (e) {
      setErr(String(e));
    }
    setBusy(null);
  }

  return (
    <div className={`border rounded-lg bg-bg-elevated ${row.overdue ? 'border-amber-500/30' : 'border-border-subtle'}`}>
      <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none" onClick={() => setOpen((v) => !v)}>
        {row.imageUrl && <img src={row.imageUrl} alt="" className="w-8 h-8 rounded object-cover bg-white shrink-0" />}
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

          {err && <div className="text-[11px] text-negative bg-negative/5 border border-negative/30 rounded px-2 py-1 whitespace-pre-wrap">{err}</div>}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => act({
                action: 'receive',
                quantityGood: parseInt(good) || 0,
                quantityIssue: parseInt(issueQty) || 0,
                issueType: parseInt(issueQty) > 0 ? issueType : undefined,
                issueNote: issueNote || undefined,
                sku: skuChoice || undefined,
                binLocation: bin || undefined,
              }, 'receive')}
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
        </div>
      )}
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
