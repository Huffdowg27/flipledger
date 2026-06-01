'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, Package, ExternalLink, ImageOff } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

interface MfnOrderRow {
  orderId: string;
  purchaseDate: string;
  status: string;
  marketplace: string;
  orderTotal: number;
  itemCount: number;
  quantity: number;
  sku: string | null;
  asin: string | null;
  productName: string | null;
  imageUrl: string | null;
}

interface Counts {
  all: number;
  amazon: number;
  walmart: number;
  ebay: number;
  shopify: number;
}

type StatusFilter = 'awaiting' | 'pending' | 'shipped' | 'all';
type DateFilter = 'all' | 'today' | '7d';

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'awaiting', label: 'Awaiting' },
  { value: 'pending', label: 'Pending' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'all', label: 'All Open' },
];

function amazonOrderUrl(orderId: string): string {
  return `https://sellercentral.amazon.com/orders-v3/order/${encodeURIComponent(orderId)}`;
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

function withinDateFilter(dateStr: string, filter: DateFilter): boolean {
  if (filter === 'all') return true;
  const days = (Date.now() - new Date(dateStr).getTime()) / 86400000;
  if (filter === 'today') return days < 1;
  return days < 7;
}

export default function MfnOrdersPage() {
  const [orders, setOrders] = useState<MfnOrderRow[]>([]);
  const [counts, setCounts] = useState<Counts>({ all: 0, amazon: 0, walmart: 0, ebay: 0, shopify: 0 });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusFilter>('awaiting');
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/data/mfn-orders?status=${status}`);
      const data = await res.json();
      setOrders(data.orders || []);
      setCounts(data.counts || { all: 0, amazon: 0, walmart: 0, ebay: 0, shopify: 0 });
    } finally {
      setLoading(false);
    }
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
          <button
            onClick={load}
            className="flex items-center gap-2 rounded-md border border-border-default bg-bg-surface px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-elevated"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

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
            {STATUS_TABS.map((t) => (
              <button
                key={t.value}
                onClick={() => setStatus(t.value)}
                className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  status === t.value ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {t.label}
              </button>
            ))}
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
                  <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-md border border-border-subtle bg-bg-elevated">
                    {o.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={o.imageUrl} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <ImageOff size={16} className="text-text-tertiary" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <a
                      href={amazonOrderUrl(o.orderId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-sm font-semibold text-accent hover:underline"
                    >
                      #{o.orderId}
                      <ExternalLink size={12} className="opacity-70" />
                    </a>
                    <div className="truncate text-sm text-text-primary" title={o.productName || ''}>
                      {o.productName || '—'}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-text-tertiary">
                      <span className="rounded bg-bg-elevated px-1.5 py-0.5 font-mono">{o.sku || o.asin || '—'}</span>
                      {o.itemCount > 1 && <span>· {o.itemCount} items</span>}
                    </div>
                  </div>
                </div>

                {/* Status */}
                <div className="flex flex-col gap-1">
                  <StatusBadge tone="info" size="xs">Order: OPEN</StatusBadge>
                  <StatusBadge tone="warning" size="xs">
                    {o.status === 'PartiallyShipped' ? 'Fulfillment: PARTIAL' : 'Fulfillment: UNSHIPPED'}
                  </StatusBadge>
                  <StatusBadge tone="positive" size="xs">Payment: PAID</StatusBadge>
                </div>

                {/* Items */}
                <div className="text-sm text-text-secondary">
                  <div>Ordered: <span className="font-mono text-text-primary">{o.quantity ?? 0}</span></div>
                </div>

                {/* Shipping */}
                <div className="text-sm text-text-tertiary" title="Ship-service level not synced">Standard</div>

                {/* Age */}
                <div className="text-right text-sm text-text-secondary">{ageLabel(o.purchaseDate)}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
