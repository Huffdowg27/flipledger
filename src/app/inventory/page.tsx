'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Search, RefreshCw, Boxes, ImageOff, Copy, X, Package, Truck, Store, BarChart3 } from 'lucide-react';

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

interface ChannelStat { skus: number; units: number; inbound: number; reserved: number; unfulfillable: number }
interface Stats {
  fba: ChannelStat;
  wfs: ChannelStat;
  totalUnits: number;
  totalReserved: number;
}

const EMPTY_CHANNEL: ChannelStat = { skus: 0, units: 0, inbound: 0, reserved: 0, unfulfillable: 0 };

type Channel = 'amazon' | 'walmart' | 'merchant';

const CHANNEL_TABS: { value: Channel; label: string; icon: React.ReactNode }[] = [
  { value: 'amazon', label: 'FBA', icon: <Package size={16} /> },
  { value: 'walmart', label: 'WFS', icon: <Store size={16} /> },
  { value: 'merchant', label: 'Merchant', icon: <Truck size={16} /> },
];

type Tone = 'accent' | 'amazon' | 'walmart' | 'positive';
const CARD_TONE: Record<Tone, { card: string; value: string; iconBg: string }> = {
  accent:   { card: 'border-accent/30 bg-accent/5',     value: 'text-accent',   iconBg: 'bg-accent/15' },
  amazon:   { card: 'border-amazon/30 bg-amazon/5',     value: 'text-amazon',   iconBg: 'bg-amazon/15' },
  walmart:  { card: 'border-walmart/30 bg-walmart/5',   value: 'text-walmart',  iconBg: 'bg-walmart/15' },
  positive: { card: 'border-positive/30 bg-positive/5', value: 'text-positive', iconBg: 'bg-positive/15' },
};

type SubTone = 'positive' | 'warning' | 'accent' | 'neutral';
const SUB_TONE: Record<SubTone, string> = {
  positive: 'border-positive/25 bg-positive/10 text-positive',
  warning:  'border-warning/25 bg-warning/10 text-warning',
  accent:   'border-accent/25 bg-accent/10 text-accent',
  neutral:  'border-border-subtle bg-bg-elevated text-text-secondary',
};

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

function MerchantStatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-text-tertiary text-xs">—</span>;
  const tone = status === 'active'
    ? 'bg-positive/10 text-positive border-positive/30'
    : status === 'oos'
      ? 'bg-warning/10 text-warning border-warning/30'
      : 'bg-bg-elevated text-text-tertiary border-border-subtle';
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize ${tone}`}>{status}</span>;
}

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

interface Sub { label: string; value: string; tone: SubTone }
function RichStatCard({ label, count, icon, tone, subs, onClick, active }: {
  label: string; count: string; icon: React.ReactNode; tone: Tone; subs: [Sub, Sub]; onClick?: () => void; active?: boolean;
}) {
  const t = CARD_TONE[tone];
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`rounded-lg border p-4 text-left ${t.card} ${onClick ? 'transition hover:brightness-110' : 'cursor-default'} ${active ? 'ring-1 ring-inset ring-accent' : ''}`}
    >
      <div className="flex items-start justify-between">
        <div className={`text-xs font-semibold uppercase tracking-wide ${t.value}`}>{label}</div>
        <span className={`grid h-8 w-8 place-items-center rounded-full ${t.iconBg} ${t.value}`}>{icon}</span>
      </div>
      <div className="mt-1 font-mono text-2xl font-bold text-text-primary">{count}</div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {subs.map((s) => (
          <div key={s.label} className={`rounded-md border px-2 py-1.5 ${SUB_TONE[s.tone]}`}>
            <div className="text-[10px] font-medium uppercase tracking-wide opacity-80">{s.label}</div>
            <div className="font-mono text-sm font-bold">{s.value}</div>
          </div>
        ))}
      </div>
    </button>
  );
}

export default function InventoryHubPage() {
  const [channel, setChannel] = useState<Channel>('amazon');
  const [rows, setRows] = useState<InvRow[]>([]);
  const [merchantRows, setMerchantRows] = useState<MerchantRow[]>([]);
  const [stats, setStats] = useState<Stats>({ fba: EMPTY_CHANNEL, wfs: EMPTY_CHANNEL, totalUnits: 0, totalReserved: 0 });
  const [merchantCount, setMerchantCount] = useState<number | null>(null);
  const [merchantListed, setMerchantListed] = useState(0);
  const [merchantLocal, setMerchantLocal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [lightbox, setLightbox] = useState<{ src: string; title: string; asin: string | null; sku: string | null } | null>(null);

  const isMerchant = channel === 'merchant';

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
  // Merchant counts for the stat strip — fetched once so the card shows on any tab.
  useEffect(() => {
    fetch('/api/data/merchant-inventory')
      .then((r) => r.json())
      .then((d) => {
        const listed = (d.listed || []).length;
        const local = (d.localOnly || []).length;
        setMerchantListed(listed); setMerchantLocal(local); setMerchantCount(listed + local);
      })
      .catch(() => {});
  }, []);

  const empty = isMerchant ? merchantRows.length === 0 : rows.length === 0;
  const totalOnHand = stats.totalUnits + stats.totalReserved;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-text-primary">Inventory</h1>
        <div className="flex items-center gap-2">
          <Link href="/analyze/inventory-valuation" className="flex items-center gap-1.5 rounded-md border border-border-default bg-bg-surface px-3 py-1.5 text-sm text-text-secondary hover:border-accent/50 hover:text-text-primary">
            <BarChart3 size={14} /> Valuation
          </Link>
          <button onClick={load} className="flex items-center gap-2 rounded-md border border-border-default bg-bg-surface px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-elevated">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Channel tab bar */}
      <div className="mb-4 flex gap-1 border-b border-border-subtle">
        {CHANNEL_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setChannel(tab.value)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              channel === tab.value ? 'border-accent text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Rich stat cards */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <RichStatCard
          label="Total" tone="accent" icon={<Boxes size={16} />} count={totalOnHand.toLocaleString()}
          subs={[
            { label: 'Available', value: stats.totalUnits.toLocaleString(), tone: 'positive' },
            { label: 'Reserved', value: stats.totalReserved.toLocaleString(), tone: 'warning' },
          ]}
        />
        <RichStatCard
          label="FBA" tone="amazon" icon={<Package size={16} />} count={stats.fba.units.toLocaleString()}
          onClick={() => setChannel('amazon')} active={channel === 'amazon'}
          subs={[
            { label: 'Reserved', value: stats.fba.reserved.toLocaleString(), tone: 'warning' },
            { label: 'Inbound', value: stats.fba.inbound.toLocaleString(), tone: 'accent' },
          ]}
        />
        <RichStatCard
          label="Merchant" tone="positive" icon={<Truck size={16} />} count={merchantCount != null ? merchantCount.toLocaleString() : '—'}
          onClick={() => setChannel('merchant')} active={channel === 'merchant'}
          subs={[
            { label: 'Listed', value: merchantListed.toLocaleString(), tone: 'positive' },
            { label: 'Local', value: merchantLocal.toLocaleString(), tone: 'neutral' },
          ]}
        />
        <RichStatCard
          label="WFS" tone="walmart" icon={<Store size={16} />} count={stats.wfs.units.toLocaleString()}
          onClick={() => setChannel('walmart')} active={channel === 'walmart'}
          subs={[
            { label: 'Reserved', value: stats.wfs.reserved.toLocaleString(), tone: 'warning' },
            { label: 'Inbound', value: stats.wfs.inbound.toLocaleString(), tone: 'accent' },
          ]}
        />
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
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
              <tr><td colSpan={5} className="py-16 text-center text-sm text-text-tertiary">Loading inventory…</td></tr>
            ) : empty ? (
              <tr><td colSpan={5} className="py-16 text-center">
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
