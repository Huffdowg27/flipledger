'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, Package, ImageOff, Printer, X } from 'lucide-react';
import StatusBadge, { StatusBadgeTone } from '@/components/ui/StatusBadge';
import { IdentifierChip, OrderReference } from '@/components/ui/IdentifierLinks';
import { PrintLabelIcon } from '@/components/ui/PrintLabel';

interface MfnOrderRow {
  orderId: string;
  purchaseDate: string;
  status: string;
  marketplace: string;
  orderTotal: number;
  shipServiceLevel: string | null;
  latestShipDate: string | null;
  itemCount: number;
  quantity: number;
  sku: string | null;
  asin: string | null;
  upc: string | null;
  productName: string | null;
  imageUrl: string | null;
  bin: string | null;
}

interface Counts {
  all: number;
  amazon: number;
  walmart: number;
  ebay: number;
  shopify: number;
}

interface StatusCounts {
  awaiting: number;
  pending: number;
  shipped: number;
  canceled: number;
  all: number;
}

type StatusFilter = 'awaiting' | 'pending' | 'shipped' | 'canceled' | 'all';
type DateFilter = 'all' | 'today' | '7d';

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'awaiting', label: 'Ready to Ship' },
  { value: 'pending', label: 'Pending' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'all', label: 'All Open' },
];

// Amazon's ShipmentServiceLevelCategory → operator-facing label + badge tone.
// These mirror Seller Central's "Order type" column (Standard / Expedited / Second Day…).
function shipLevelBadge(level: string | null | undefined): { label: string; tone: StatusBadgeTone } {
  switch ((level || '').toLowerCase()) {
    case 'expedited':    return { label: 'Expedited', tone: 'info' };
    case 'secondday':    return { label: '2nd Day',   tone: 'warning' };
    case 'nextday':      return { label: 'Next Day',  tone: 'negative' };
    case 'sameday':      return { label: 'Same Day',  tone: 'negative' };
    case 'priority':     return { label: 'Priority',  tone: 'info' };
    case 'scheduleddelivery': return { label: 'Scheduled', tone: 'info' };
    case 'standard':     return { label: 'Standard',  tone: 'neutral' };
    default:             return { label: level || 'Standard', tone: 'neutral' };
  }
}

// Only surface a real barcode (8-14 digits); the backfill stores '-' for "checked, none".
function cleanUpc(upc: string | null | undefined): string | null {
  const value = (upc ?? '').trim();
  return /^\d{8,14}$/.test(value) ? value : null;
}

/** Operator-friendly age: "Today", "1 day", "5 days". */
function ageLabel(dateStr: string): string {
  const then = new Date(dateStr);
  const now = new Date();
  const days = Math.floor((now.getTime() - then.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

/** "Ship by" deadline, color-coded by urgency. Overdue/today = red, tomorrow
 *  = amber, later = muted. Label is relative ("Today", "Tomorrow", weekday). */
function shipByLabel(dateStr: string): { label: string; tone: string } {
  const due = new Date(dateStr);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / 86400000);
  let label: string;
  if (days < 0) label = `${Math.abs(days)}d overdue`;
  else if (days === 0) label = 'today';
  else if (days === 1) label = 'tomorrow';
  else if (days <= 6) label = due.toLocaleDateString('en-US', { weekday: 'short' });
  else label = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const tone = days <= 0 ? 'text-negative font-semibold' : days === 1 ? 'text-warning' : 'text-text-tertiary';
  return { label, tone };
}

function withinDateFilter(dateStr: string, filter: DateFilter): boolean {
  if (filter === 'all') return true;
  const days = (Date.now() - new Date(dateStr).getTime()) / 86400000;
  if (filter === 'today') return days < 1;
  return days < 7;
}

export default function MfnOrdersPage() {
  const [orders, setOrders] = useState<MfnOrderRow[]>([]);
  const [counts, setCounts] = useState<Counts>({ all: 0, amazon: 0, walmart: 0, ebay: 0, shopify: 0 });
  const [statusCounts, setStatusCounts] = useState<StatusCounts>({ awaiting: 0, pending: 0, shipped: 0, canceled: 0, all: 0 });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>('awaiting');
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [lightbox, setLightbox] = useState<{ src: string; title: string; asin: string | null; sku: string | null } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/data/mfn-orders?status=${status}`);
      const data = await res.json();
      setOrders(data.orders || []);
      setCounts(data.counts || { all: 0, amazon: 0, walmart: 0, ebay: 0, shopify: 0 });
      setStatusCounts(data.statusCounts || { awaiting: 0, pending: 0, shipped: 0, canceled: 0, all: 0 });
    } finally {
      setLoading(false);
    }
  }

  // Refresh = ask Amazon for live state (new orders + reconcile shipped/canceled),
  // then reload the list. Falls back to a plain reload if the sync call fails —
  // but a failed live sync must never masquerade as fresh data, so any errors
  // from the sync are surfaced in a banner above the list.
  async function refresh() {
    setSyncing(true);
    setSyncWarning(null);
    try {
      const res = await fetch('/api/sync/mfn-refresh', { method: 'POST' });
      const data = await res.json().catch(() => null);
      const errors: string[] = Array.isArray(data?.errors) ? data.errors : [];
      if (!res.ok) {
        setSyncWarning('Live Amazon refresh failed — showing local data, which may be stale.');
      } else if (errors.length > 0) {
        setSyncWarning(
          `Live Amazon refresh had ${errors.length === 1 ? 'an error' : `${errors.length} errors`} — some orders may be stale. First: ${errors[0]}`
        );
      }
    } catch {
      /* sync unreachable — still reload local data below so the button never dead-ends */
      setSyncWarning('Live Amazon refresh failed — showing local data, which may be stale.');
    } finally {
      setSyncing(false);
    }
    await load();
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (!withinDateFilter(o.purchaseDate, dateFilter)) return false;
      if (!q) return true;
      return (
        o.orderId.toLowerCase().includes(q) ||
        (o.sku || '').toLowerCase().includes(q) ||
        (o.productName || '').toLowerCase().includes(q)
      );
    });
  }, [orders, search, dateFilter]);

  const stores = [
    { key: 'all', label: 'All Stores', n: counts.all, tone: 'text-text-primary' },
    { key: 'amazon', label: 'Amazon', n: counts.amazon, tone: 'text-amazon' },
    { key: 'walmart', label: 'Walmart', n: counts.walmart, tone: 'text-walmart' },
    { key: 'ebay', label: 'eBay', n: counts.ebay, tone: 'text-ebay' },
  ];

  return (
    <div className="flex h-full gap-4 p-4">
      {/* Stores sidebar */}
      <aside className="w-56 shrink-0 rounded-lg border border-border-default bg-bg-surface p-3">
        <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-text-tertiary">Stores</div>
        <div className="space-y-1">
          {stores.map((s) => (
            <div
              key={s.key}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${
                s.key === 'all' ? 'border border-amazon/40 bg-amazon/5' : 'hover:bg-bg-elevated'
              }`}
            >
              <span className={`font-medium ${s.tone}`}>{s.label}</span>
              <span className="font-mono text-text-secondary">{s.n}</span>
            </div>
          ))}
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header + toolbar */}
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">MFN Orders</h1>
            <p className="text-sm text-text-tertiary">Merchant-fulfilled orders awaiting shipment</p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/labels?mode=warehouse"
              className="flex items-center gap-2 rounded-md border border-border-default bg-bg-surface px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-elevated"
            >
              <Printer size={14} />
              Print labels
            </a>
            <button
              onClick={refresh}
              disabled={syncing || loading}
              className="flex items-center gap-2 rounded-md border border-border-default bg-bg-surface px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-elevated disabled:opacity-60"
            >
              <RefreshCw size={14} className={syncing || loading ? 'animate-spin' : ''} />
              {syncing ? 'Checking Amazon…' : 'Refresh'}
            </button>
          </div>
        </div>

        {syncWarning && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
            <span>{syncWarning}</span>
            <button
              onClick={() => setSyncWarning(null)}
              className="shrink-0 text-warning/70 hover:text-warning"
              aria-label="Dismiss refresh warning"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search order number, SKU, or title…"
              className="h-9 w-full rounded-md border border-border-default bg-bg-input pl-9 pr-3 text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
            />
          </div>

          <div className="flex rounded-md border border-border-default bg-bg-surface p-0.5">
            {STATUS_TABS.map((t) => {
              const n = statusCounts[t.value];
              const active = status === t.value;
              return (
                <button
                  key={t.value}
                  onClick={() => setStatus(t.value)}
                  className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                    active ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {t.label}
                  <span
                    className={`min-w-[1.25rem] rounded-full px-1.5 text-center font-mono text-[11px] ${
                      active
                        ? 'bg-white/20 text-white'
                        : t.value === 'canceled' && n > 0
                          ? 'bg-negative/15 text-negative'
                          : 'bg-bg-elevated text-text-tertiary'
                    }`}
                  >
                    {n}
                  </span>
                </button>
              );
            })}
          </div>

          <select
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value as DateFilter)}
            className="h-9 rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-secondary focus:border-accent focus:outline-none"
          >
            <option value="all">All Times</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
          </select>
        </div>

        {/* Column header */}
        <div className="grid grid-cols-[1fr_180px_120px_110px_90px] gap-3 border-b border-border-default px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
          <div>Order Details</div>
          <div>Status</div>
          <div>Items</div>
          <div>Shipping</div>
          <div className="text-right">Age</div>
        </div>

        {/* Rows */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-16 text-center text-sm text-text-tertiary">Loading orders…</div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-text-tertiary">
              <Package size={28} className="mb-2 opacity-50" />
              <div className="text-sm">No orders match this view.</div>
            </div>
          ) : (
            visible.map((o) => (
              <div
                key={o.orderId}
                className="grid grid-cols-[1fr_180px_120px_110px_90px] items-center gap-3 border-b border-border-subtle px-3 py-3 hover:bg-bg-elevated/50"
              >
                {/* Order Details */}
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => o.imageUrl && setLightbox({ src: o.imageUrl, title: o.productName || o.asin || o.orderId, asin: o.asin, sku: o.sku })}
                    disabled={!o.imageUrl}
                    title={o.imageUrl ? 'View photo' : undefined}
                    className={`grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-md border border-border-subtle bg-bg-elevated ${o.imageUrl ? 'cursor-zoom-in hover:border-accent/60' : ''}`}
                  >
                    {o.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={o.imageUrl} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <ImageOff size={16} className="text-text-tertiary" />
                    )}
                  </button>
                  <div className="min-w-0">
                    <OrderReference orderId={o.orderId} marketplace={o.marketplace} prefix="#" className="font-mono text-sm font-semibold" />
                    <div className="truncate text-sm text-text-primary" title={o.productName || ''}>
                      {o.productName || '—'}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs font-mono text-text-tertiary">
                      <IdentifierChip label="MSKU" value={o.sku || o.asin} kind="sku" />
                      <IdentifierChip label="ASIN" value={o.asin} kind="asin" />
                      <IdentifierChip label="UPC" value={cleanUpc(o.upc)} kind="text" />
                      {o.bin && <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 font-semibold text-accent">Bin {o.bin}</span>}
                      <PrintLabelIcon item={{ title: o.productName, asin: o.asin, sku: o.sku, bin: o.bin }} />
                      {o.itemCount > 1 && <span className="shrink-0">· {o.itemCount} items</span>}
                    </div>
                  </div>
                </div>

                {/* Status */}
                <div className="flex flex-col gap-1">
                  {o.status === 'Canceled' || o.status === 'Cancelled' ? (
                    <StatusBadge tone="negative" size="xs">Order: CANCELED</StatusBadge>
                  ) : o.status === 'Shipped' ? (
                    <>
                      <StatusBadge tone="positive" size="xs">Order: SHIPPED</StatusBadge>
                      <StatusBadge tone="positive" size="xs">Payment: PAID</StatusBadge>
                    </>
                  ) : (
                    <>
                      <StatusBadge tone="info" size="xs">Order: OPEN</StatusBadge>
                      <StatusBadge tone="warning" size="xs">
                        {o.status === 'PartiallyShipped' ? 'Fulfillment: PARTIAL' : 'Fulfillment: UNSHIPPED'}
                      </StatusBadge>
                      <StatusBadge tone="positive" size="xs">Payment: PAID</StatusBadge>
                    </>
                  )}
                </div>

                {/* Items */}
                <div className="text-sm text-text-secondary">
                  <div>Ordered: <span className="font-mono text-text-primary">{o.quantity ?? 0}</span></div>
                </div>

                {/* Shipping — Amazon ship-service level + ship-by deadline */}
                <div className="space-y-1">
                  {(() => {
                    const { label, tone } = shipLevelBadge(o.shipServiceLevel);
                    return (
                      <StatusBadge tone={tone} size="xs" className="uppercase tracking-wide">
                        {label}
                      </StatusBadge>
                    );
                  })()}
                  {o.latestShipDate && o.status !== 'Shipped' && o.status !== 'Canceled' && (() => {
                    const due = shipByLabel(o.latestShipDate);
                    return (
                      <div className={`text-[11px] ${due.tone}`} title={`Ship by ${new Date(o.latestShipDate).toLocaleString()}`}>
                        Ship by {due.label}
                      </div>
                    );
                  })()}
                </div>

                {/* Age */}
                <div className="text-right text-sm text-text-secondary">{ageLabel(o.purchaseDate)}</div>
              </div>
            ))
          )}
        </div>
      </div>

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
                  <IdentifierChip label="ASIN" value={lightbox.asin} kind="asin" />
                  <IdentifierChip label="MSKU" value={lightbox.sku} kind="sku" />
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
            {/* eslint-disable-next-line @next/next/no-img-element */}
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
