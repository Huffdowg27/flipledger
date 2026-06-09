'use client';

import { useState, useCallback } from 'react';
import { Upload, Truck, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { formatCurrency } from '@/lib/formatters';

interface ImportResult {
  preview: boolean;
  overwrite: boolean;
  totals: {
    ordersInCsv: number; labelRows: number; skippedNoCost: number;
    toSet: number; toSetCents: number; unchanged: number;
    skippedExisting: number; notFound: number; applied: number;
  };
  nonUsdCurrency: string[];
  skippedExisting: { orderId: string; existingCents: number; veeqoCents: number }[];
  notFound: string[];
  willSet: { orderId: string; veeqoCents: number; channel: string | null }[];
}

export default function ImportShippingPage() {
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [overwrite, setOverwrite] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [committed, setCommitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (csv: string, commit: boolean, ow: boolean) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/sync/import-shipping-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, commit, overwrite: ow }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Import failed'); setResult(null); return; }
      setResult(data); setCommitted(commit);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const onFile = (f: File) => {
    setCommitted(false); setResult(null); setError(null); setFileName(f.name);
    f.text().then((txt) => { setCsvText(txt); run(txt, false, overwrite); });
  };

  const t = result?.totals;

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <Truck size={22} className="text-accent" />
        <h1 className="text-xl font-semibold tracking-tight">Import Shipping Costs (Veeqo)</h1>
      </div>
      <p className="text-sm text-text-tertiary mb-6">
        Upload a Veeqo <span className="font-mono">Shipping Report</span> CSV. Label costs are matched
        to orders by Amazon order number and written to each MFN order&apos;s shipping cost. FBA rows
        (no label cost) are skipped. Re-uploading is safe.
      </p>

      {/* Upload */}
      <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border-default rounded-lg p-8 cursor-pointer hover:bg-bg-hover transition-colors">
        <Upload size={24} className="text-text-tertiary" />
        <span className="text-sm text-text-secondary">{fileName || 'Choose a Veeqo shipping CSV…'}</span>
        <input type="file" accept=".csv,text/csv" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
      </label>

      <label className="flex items-center gap-2 mt-3 text-sm text-text-secondary cursor-pointer">
        <input type="checkbox" checked={overwrite}
          onChange={(e) => { setOverwrite(e.target.checked); if (csvText) run(csvText, false, e.target.checked); }} />
        Overwrite orders that already have a shipping cost (make Veeqo authoritative)
      </label>

      {loading && (
        <div className="flex items-center gap-2 mt-6 text-sm text-text-tertiary">
          <Loader2 size={16} className="animate-spin" /> Working…
        </div>
      )}

      {error && (
        <div className="mt-6 flex items-start gap-2 rounded-lg border border-negative/40 bg-negative/10 p-4 text-sm text-negative">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {result && t && (
        <div className="mt-6 space-y-4">
          {committed ? (
            <div className="flex items-center gap-2 rounded-lg border border-positive/40 bg-positive/10 p-4 text-sm text-positive">
              <CheckCircle size={16} /> Imported — set shipping cost on <b>{t.applied}</b> orders ({formatCurrency(t.toSetCents)}).
            </div>
          ) : (
            <div className="text-sm text-text-secondary">
              Preview — nothing written yet. <b>{t.ordersInCsv}</b> orders in CSV, <b>{t.skippedNoCost}</b> FBA/no-cost rows skipped.
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Will set" value={`${t.toSet}`} sub={formatCurrency(t.toSetCents)} accent="positive" />
            <Stat label="Unchanged" value={`${t.unchanged}`} />
            <Stat label="Already has cost" value={`${t.skippedExisting}`} accent={t.skippedExisting ? 'warning' : undefined} />
            <Stat label="Not in FlipLedger" value={`${t.notFound}`} accent={t.notFound ? 'warning' : undefined} />
          </div>

          {result.nonUsdCurrency.length > 0 && (
            <div className="text-xs text-warning">⚠ Non-USD currency seen: {result.nonUsdCurrency.join(', ')} — values imported as-is.</div>
          )}

          {!committed && t.toSet > 0 && (
            <button
              onClick={() => csvText && run(csvText, true, overwrite)}
              className="px-4 h-10 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors"
            >
              Import {t.toSet} orders ({formatCurrency(t.toSetCents)})
            </button>
          )}

          {result.skippedExisting.length > 0 && (
            <Details title={`${result.skippedExisting.length} already have a shipping cost (turn on Overwrite to replace)`}>
              {result.skippedExisting.map((s) => (
                <Row key={s.orderId} left={s.orderId}
                  right={`${formatCurrency(s.existingCents)} → Veeqo ${formatCurrency(s.veeqoCents)}`} />
              ))}
            </Details>
          )}
          {result.notFound.length > 0 && (
            <Details title={`${result.notFound.length} order(s) not found in FlipLedger`}>
              {result.notFound.map((o) => <Row key={o} left={o} right="" />)}
            </Details>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'positive' | 'warning' }) {
  const color = accent === 'positive' ? 'text-positive' : accent === 'warning' ? 'text-warning' : 'text-text-primary';
  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-widest text-text-tertiary">{label}</div>
      <div className={`text-lg font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-xs text-text-tertiary font-mono">{sub}</div>}
    </div>
  );
}

function Details({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-lg border border-border-subtle bg-bg-surface">
      <summary className="cursor-pointer px-4 py-2 text-sm text-text-secondary">{title}</summary>
      <div className="border-t border-border-subtle divide-y divide-border-subtle/50">{children}</div>
    </details>
  );
}

function Row({ left, right }: { left: string; right: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-1.5 text-xs font-mono">
      <span className="text-text-secondary">{left}</span>
      <span className="text-text-tertiary">{right}</span>
    </div>
  );
}
