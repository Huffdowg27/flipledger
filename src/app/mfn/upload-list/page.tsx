'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Tags, AlertTriangle } from 'lucide-react';

import { buildInventoryLoaderCsv, type MfnUploadListRow } from '@/lib/mfn-upload-list';

type PreviewResponse = {
  source?: { baseId: string; tableId: string; view: string; fetchedRows: number };
  ready?: MfnUploadListRow[];
  blocked?: MfnUploadListRow[];
  summary?: {
    totalRows: number;
    readyRows: number;
    blockedRows: number;
    totalReadyQty: number;
    totalReadyCostCents: number;
    totalReadyRevenueCents: number;
  };
  error?: string;
};

function money(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openAsinLabels(rows: MfnUploadListRow[]) {
  const specs = rows.flatMap(row => Array.from({ length: Math.max(row.quantity, 1) }, () => ({
    labelMode: 'asin' as const,
    size: '2x1' as const,
    asin: row.asin,
    title: row.title,
    condition: row.conditionCode === '11' ? 'New' : `Condition ${row.conditionCode}`,
    sku: row.sku,
    showBin: false,
  })));
  if (specs.length === 0) return;
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(specs))));
  window.open(`/api/labels/print?d=${encodeURIComponent(encoded)}`, '_blank');
}

export default function MfnUploadListPage() {
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPreview = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/mfn/upload-list/preview', { cache: 'no-store' });
      const json = await res.json();
      setData(json);
    } catch (err) {
      setData({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPreview(); }, [fetchPreview]);

  const ready = useMemo(() => data?.ready ?? [], [data?.ready]);
  const blocked = useMemo(() => data?.blocked ?? [], [data?.blocked]);
  const csv = useMemo(() => buildInventoryLoaderCsv(ready), [ready]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">MFN Upload List</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Read-only Airtable preview → Inventory Loader CSV + ASIN label batch. No Airtable writes yet.
          </p>
        </div>
        <button
          onClick={fetchPreview}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md bg-bg-surface border border-border-subtle px-3 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-60"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {data?.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {data.error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-text-tertiary">Source view</div>
          <div className="text-sm mt-1 text-text-primary">{data?.source?.view ?? 'IL FBM Upload Today'}</div>
        </div>
        <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-text-tertiary">Ready rows</div>
          <div className="text-2xl font-semibold mt-1">{data?.summary?.readyRows ?? 0}</div>
        </div>
        <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-text-tertiary">Ready units</div>
          <div className="text-2xl font-semibold mt-1">{data?.summary?.totalReadyQty ?? 0}</div>
        </div>
        <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-text-tertiary">Ready revenue</div>
          <div className="text-2xl font-semibold mt-1">{money(data?.summary?.totalReadyRevenueCents)}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          disabled={ready.length === 0}
          onClick={() => downloadText(`mfn-upload-list-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8')}
          className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          <Download size={16} />
          Download CSV
        </button>
        <button
          disabled={ready.length === 0}
          onClick={() => openAsinLabels(ready)}
          className="inline-flex items-center gap-2 rounded-md bg-bg-surface border border-border-subtle px-3 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-40"
        >
          <Tags size={16} />
          Print ASIN labels
        </button>
      </div>

      <section className="rounded-lg border border-border-subtle bg-bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <h2 className="font-medium">Ready for CSV</h2>
          <span className="text-xs text-text-tertiary">{ready.length} rows</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-text-tertiary bg-bg-root/40">
              <tr>
                <th className="text-left p-3">SKU</th>
                <th className="text-left p-3">ASIN</th>
                <th className="text-left p-3">Product</th>
                <th className="text-right p-3">Qty</th>
                <th className="text-right p-3">Price</th>
                <th className="text-right p-3">Cost</th>
              </tr>
            </thead>
            <tbody>
              {ready.map(row => (
                <tr key={row.airtableRecordId} className="border-t border-border-subtle">
                  <td className="p-3 font-mono text-xs">{row.sku}</td>
                  <td className="p-3 font-mono text-xs">{row.asin}</td>
                  <td className="p-3 max-w-md truncate">{row.title || '—'}</td>
                  <td className="p-3 text-right">{row.quantity}</td>
                  <td className="p-3 text-right">{money(row.priceCents)}</td>
                  <td className="p-3 text-right">{money(row.costCents)}</td>
                </tr>
              ))}
              {!loading && ready.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-text-tertiary">No upload-ready rows in the Airtable view.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {blocked.length > 0 && (
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 overflow-hidden">
          <div className="px-4 py-3 border-b border-amber-500/20 flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-300" />
            <h2 className="font-medium">Blocked rows</h2>
            <span className="text-xs text-text-tertiary">missing required fields or not safe to upload</span>
          </div>
          <div className="divide-y divide-amber-500/10">
            {blocked.map(row => (
              <div key={row.airtableRecordId} className="p-4 text-sm">
                <div className="font-medium">{row.title || row.sku || row.asin || row.airtableRecordId}</div>
                <div className="text-xs text-amber-200 mt-1">{row.blockingReasons.join(' · ')}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
