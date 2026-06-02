'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Search, RefreshCw, Boxes, ImageOff, Copy, X, ArrowRight, Package } from 'lucide-react';

interface InvRow {
  asin: string | null;
  sku: string | null;
  marketplace: string;
  productName: string | null;
  imageUrl: string | null;
  fulfillable: number;
  inbound: number;
  reserved: number;
  unfulfillable: number;
  listPrice: number | null;
}

interface MerchantRow {
  sku: string | null;
  asin: string | null;
  productName: string | null;
  imageUrl: string | null;
  qty: number;
  costCents: number | null;
  status: string | null;
}

interface Stats {
  fba: { skus: number; units: number; inbound: number };
  wfs: { skus: number; units: number; inbound: number };
  totalUnits: number;
}

type Channel = 'amazon' | 'walmart' | 'merchant';

const TABS: { value: Channel; label: string }[] = [
  { value: 'amazon', label: 'FBA' },
  { value: 'walmart', label: 'WFS' },
  { value: 'merchant', label: 'Merchant' },
];

function sellerCentralSkuUrl(sku: string | null | undefined): string | null {
  const v = (sku ?? '').trim();
  return v ? `https://sellercentral.amazon.com/myinventory/inventory?searchField=all&searchTerm=${encodeURIComponent(v)}` : null;
}

function IdentifierChip({ label, value, href }: { label: string; value: string | null | undefined; href?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-1 min-w-0">
      <span className="text-text-tertiary/60 uppercase tracking-wide shrink-0">{label}</span>
      {href
        ? <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-accent truncate hover:underline" title={`Open ${label} in Seller Central: ${value}`}>{value}</a>
        : <span className="text-text-secondary truncate" title={value}>{value}</span>}
      <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(value); }} title={`Copy ${label}`} className="shrink-0 text-text-tertiary/40 hover:text-text-tertiary transition-colors">
        <Copy size={10} />
      </button>
    </div>
  );
}

type CardTone = 'neutral' | 'accent' | 'amazon' | 'walmart' | 'positive';
const CARD_TONE: Record<CardTone, { card: string; value: string }> = {
  neutral:  { card: 'border-border-default bg-bg-surface', value: 'text-text-primary' },
  accent:   { card: 'border-accent/30 bg-accent/5',        value: 'text-accent' },
  amazon:   { card: 'border-amazon/30 bg-amazon/5',        value: 'text-amazon' },
  walmart:  { card: 'border-walmart/30 bg-walmart/5',      value: 'text-walmart' },
  positive: { card: 'border-positive/30 bg-positive/5',    value: 'text-positive' },
};

function StatCard({ label, value, sub, tone = 'neutral' }: { label: string; value: string; sub?: string; tone?: CardTone }) {
  const t = CARD_TONE[tone];
  return (
    <div className={`rounded-lg border p-4 ${t.card}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-bold ${t.value}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-text-tertiary">{sub}</div>}
    </div>
  );
}

function MerchantStatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-text-tertiary text-xs">—</span>;
  const tone = status === 'active'
    ? 'bg-positive/10 text-positive border-positive/30'
    : status === 'oos'
      ? 'bg-warning/10 text-warning border-warning/30'
      : 'bg-bg-elevated text-text-tertiary border-border-subtle';
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize ${tone}`}>{status}</span>;
}

/** Product cell shared by all tabs: white image card (lightbox), title (Amazon link), ASIN/MSKU chips. */
function ProductCell({ row, onImage }: { row: { asin: string | null; sku: string | null; productName: string | null; imageUrl: string | null }; onImage: () => void }) {
  return (
    <div className="flex items-start gap-3">
      {row.imageUrl
        ? <button onClick={(e) => { e.stopPropagation(); onImage(); }} className="block shrink-0 cursor-zoom-in" title="View larger image">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={row.imageUrl} alt="" className="h-16 w-16 rounded-lg border border-border-subtle bg-white object-contain p-1 transition-colors hover:border-accent" />
          </button>
        : <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-bg-elevated"><Package size={20} className="text-text-tertiary/40" /></div>}
      <div className="min-w-0">
        {row.asin
          ? <a href={`https://www.amazon.com/dp/${row.asin}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="line-clamp-2 text-sm font-medium leading-snug text-accent hover:underline" title={row.productName || row.asin}>{row.productName || row.asin}</a>
          : <span className="line-clamp-2 text-sm font-medium leading-snug text-text-primary" title={row.productName || ''}>{row.productName || '—'}</span>}
        <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] font-mono">
          <IdentifierChip label="ASIN" value={row.asin} />
          <IdentifierChip label="MSKU" value={row.sku} href={sellerCentralSkuUrl(row.sku)} />
        </div>
      </div>
    </div>
  );
}

export default function InventoryHubPage() {
  const [channel, setChannel] = useState<Channel>('amazon');
  const [rows, setRows] = useState<InvRow[]>([]);
  const [merchantRows, setMerchantRows] = useState<MerchantRow[]>([]);
  const [stats, setStats] = useState<Stats>({ fba: { skus: 0, units: 0, inbound: 0 }, wfs: { skus: 0, units: 0, inbound: 0 }, totalUnits: 0 });
  const [merchantCount, setMerchantCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [lightbox, setLightbox] = useState<{ src: string; title: string; asin: string | null; sku: string | null } | null>(null);

  const isMerchant = channel === 'merchant';
  const colCount = 5;

  async function load() {
    setLoading(true);
    try {
      if (channel === 'merchant') {
        const res = await fetch('/api/data/merchant-inventory');
        const d = await res.json();
        const all = [...(d.listed || []), ...(d.localOnly || [])];
        const q = search.trim().toLowerCase();
        const mapped: MerchantRow[] = all.map((r: any) => ({
          sku: r.sku ?? null,
          asin: r.asin ?? null,
          productName: r.product_name ?? null,
          imageUrl: r.image_url ?? null,
          qty: r.quantity_remaining ?? r.amazon_qty ?? 0,
          costCents: r.parsed_cost_cents ?? r.cost_cents ?? null,
          status: r.live_state ?? r.amazon_status ?? null,
        }));
        const filtered = q ? mapped.filter((m) => `${m.sku ?? ''} ${m.asin ?? ''} ${m.productName ?? ''}`.toLowerCase().includes(q)) : mapped;
        setMerchantRows(filtered);
        setMerchantCount(mapped.length);
      } else {
        const res = await fetch(`/api/data/fba-inventory?channel=${channel}&q=${encodeURIComponent(search)}`);
        const data = await res.json();
        setRows(data.rows || []);
        if (data.stats) setStats(data.stats);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [channel]);
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [search]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const empty = isMerchant ? merchantRows.length === 0 : rows.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Inventory</h1>
          <p className="text-sm text-text-tertiary">Live stock across fulfillment channels</p>
        </div>
        <button onClick={load} className="flex items-center gap-2 rounded-md border border-border-default bg-bg-surface px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-elevated">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Stat strip */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total Units" value={stats.totalUnits.toLocaleString()} sub="FBA + WFS fulfillable" tone="accent" />
        <StatCard label="FBA" value={stats.fba.units.toLocaleString()} sub={`${stats.fba.skus.toLocaleString()} SKUs · ${stats.fba.inbound} inbound`} tone="amazon" />
        <StatCard label="WFS" value={stats.wfs.units.toLocaleString()} sub={`${stats.wfs.skus.toLocaleString()} SKUs · ${stats.wfs.inbound} inbound`} tone="walmart" />
        <div className="flex flex-col gap-2">
          <button onClick={() => setChannel('merchant')} className="flex items-center justify-between rounded-lg border border-positive/30 bg-positive/5 px-4 py-2.5 text-sm font-medium text-positive hover:border-positive/50">
            <span>Merchant{merchantCount != null ? ` · ${merchantCount}` : ''}</span> <ArrowRight size={14} />
          </button>
          <Link href="/analyze/inventory-valuation" className="flex items-center justify-between rounded-lg border border-border-default bg-bg-surface px-4 py-2.5 text-sm text-text-secondary hover:border-accent/50 hover:text-text-primary">
            Inventory Valuation <ArrowRight size={14} />
          </Link>
        </div>
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border-default bg-bg-surface p-0.5">
          {TABS.map((t) => (
            <button key={t.value} onClick={() => setChannel(t.value)} className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${channel === t.value ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[220px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product, SKU, or ASIN…" className="h-9 w-full rounded-md border border-border-default bg-bg-input pl-9 pr-3 text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25" />
        </div>
      </div>

      {/* Rich table (matches /analyze/merchant-inventory) */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-subtle">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-bg-surface">
            <tr className="border-b border-border-default text-left text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              <th className="px-4 py-2.5">Product</th>
              {isMerchant ? (
                <>
                  <th className="px-4 py-2.5 text-right w-24">Qty</th>
                  <th className="px-4 py-2.5 text-right w-28">Cost</th>
                  <th className="px-4 py-2.5 text-right w-28">Status</th>
                </>
              ) : (
                <>
                  <th className="px-4 py-2.5 text-right w-24">Fulfillable</th>
                  <th className="px-4 py-2.5 text-right w-20">Inbound</th>
                  <th className="px-4 py-2.5 text-right w-20">Reserved</th>
                  <th className="px-4 py-2.5 text-right w-24">Unfulfillable</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={colCount} className="py-16 text-center text-sm text-text-tertiary">Loading inventory…</td></tr>
            ) : empty ? (
              <tr><td colSpan={colCount} className="py-16 text-center">
                <div className="flex flex-col items-center text-text-tertiary">
                  <Boxes size={28} className="mb-2 opacity-50" />
                  <span className="text-sm">{channel === 'walmart' ? 'No WFS inventory synced yet.' : isMerchant ? 'No merchant inventory matches this view.' : 'No inventory matches this view.'}</span>
                </div>
              </td></tr>
            ) : isMerchant ? (
              merchantRows.map((r, i) => (
                <tr key={`m-${r.sku}-${i}`} className="border-b border-border-subtle/50 transition-colors hover:bg-bg-hover">
                  <td className="px-4 py-3 max-w-[420px]"><ProductCell row={r} onImage={() => r.imageUrl && setLightbox({ src: r.imageUrl, title: r.productName || r.sku || '', asin: r.asin, sku: r.sku })} /></td>
                  <td className="px-4 py-3 text-right font-mono text-sm text-text-primary">{r.qty}</td>
                  <td className="px-4 py-3 text-right font-mono text-sm text-text-secondary">{r.costCents != null ? `$${(r.costCents / 100).toFixed(2)}` : '—'}</td>
                  <td className="px-4 py-3 text-right"><MerchantStatusBadge status={r.status} /></td>
                </tr>
              ))
            ) : (
              rows.map((r, i) => (
                <tr key={`${r.asin}-${r.sku}-${i}`} className="border-b border-border-subtle/50 transition-colors hover:bg-bg-hover">
                  <td className="px-4 py-3 max-w-[420px]"><ProductCell row={r} onImage={() => r.imageUrl && setLightbox({ src: r.imageUrl, title: r.productName || r.asin || '', asin: r.asin, sku: r.sku })} /></td>
                  <td className="px-4 py-3 text-right font-mono text-sm font-medium text-text-primary">{r.fulfillable}</td>
                  <td className="px-4 py-3 text-right font-mono text-sm text-text-secondary">{r.inbound || '—'}</td>
                  <td className="px-4 py-3 text-right font-mono text-sm text-text-secondary">{r.reserved || '—'}</td>
                  <td className={`px-4 py-3 text-right font-mono text-sm ${r.unfulfillable > 0 ? 'text-warning' : 'text-text-secondary'}`}>{r.unfulfillable || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onClick={() => setLightbox(null)}>
          <div className="relative flex flex-col overflow-hidden rounded-xl bg-white shadow-2xl max-w-[92vw] max-h-[92vh]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 border-b border-border-subtle bg-bg-elevated px-5 py-3.5">
              <div className="min-w-0">
                <div className="line-clamp-2 text-base font-semibold leading-snug text-text-primary">{lightbox.title}</div>
                <div className="mt-1 flex gap-4 text-[11px] font-mono text-text-tertiary">
                  {lightbox.asin && <span>ASIN {lightbox.asin}</span>}
                  {lightbox.sku && (sellerCentralSkuUrl(lightbox.sku)
                    ? <a href={sellerCentralSkuUrl(lightbox.sku)!} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">MSKU {lightbox.sku}</a>
                    : <span>MSKU {lightbox.sku}</span>)}
                </div>
              </div>
              <button onClick={() => setLightbox(null)} className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-tertiary hover:bg-bg-hover hover:text-text-primary" title="Close (Esc)">
                <X size={20} />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={lightbox.src.replace(/\._[A-Z0-9,]+_\.(jpg|jpeg|png)/i, '.$1')} alt={lightbox.title} className="h-[80vh] w-auto max-w-[92vw] bg-white object-contain" />
          </div>
        </div>
      )}
    </div>
  );
}
