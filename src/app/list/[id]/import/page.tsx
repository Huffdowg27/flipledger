'use client';

// Buy-list CSV import wizard, scoped to a single batch.
//
// Flow: upload CSV → map columns (auto-detected, editable) → review the
// server-validated preview with per-row "already in inventory" flags → resolve
// replenish-vs-new (FBA only) and skip unwanted rows → commit. The preview and
// commit both re-parse server-side; the client is never the source of truth.

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileUp, AlertCircle, AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { formatCurrency } from '@/lib/formatters';
import { FIELD_KEYS, FIELD_LABELS, type FieldKey, type ColumnMapping } from '@/lib/imports/airtable-buylist';

interface PreviewRow {
  rowIndex: number;
  asin: string;
  msku: string;
  productName: string;
  quantity: number;
  costCents: number;
  listPriceCents: number;
  supplier: string | null;
  purchaseDate: string | null;
  condition: string;
  shippingTemplate: string | null;
  warnings: string[];
  errors: string[];
  existsBySku: boolean;
  existsByAsin: boolean;
  duplicateInCsv: boolean;
  suggestedMode: 'CREATE_NEW' | 'REPLENISH_EXISTING';
}

interface PreviewResponse {
  batch: { id: number; name: string; channel: string; status: string };
  headers: string[];
  columnMapping: ColumnMapping;
  totals: {
    rowCount: number; validRowCount: number; totalUnits: number;
    totalCostCents: number; totalListValueCents: number;
  };
  globalErrors: string[];
  rows: PreviewRow[];
}

type RowDecision = { mode?: 'CREATE_NEW' | 'REPLENISH_EXISTING'; skip?: boolean };

export default function BatchImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [filename, setFilename] = useState<string | null>(null);
  const [csvText, setCsvText] = useState('');
  const [mapping, setMapping] = useState<Partial<ColumnMapping>>({});
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({});
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [duplicateSkus, setDuplicateSkus] = useState<string[]>([]);

  const reqToken = useRef(0);

  const loadPreview = useCallback(async (csv: string, map: Partial<ColumnMapping>) => {
    if (!csv.trim()) { setPreview(null); return; }
    const token = ++reqToken.current;
    setLoadingPreview(true);
    setPreviewError(null);
    try {
      const res = await fetch(`/api/list/batches/${id}/import/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, mapping: map }),
      });
      const data = await res.json();
      if (token !== reqToken.current) return; // a newer request superseded this one
      if (!res.ok) { setPreviewError(data?.error || `Preview failed (HTTP ${res.status})`); setPreview(null); return; }
      setPreview(data);
    } catch (err) {
      if (token === reqToken.current) { setPreviewError(String(err)); setPreview(null); }
    } finally {
      if (token === reqToken.current) setLoadingPreview(false);
    }
  }, [id]);

  useEffect(() => { loadPreview(csvText, mapping); }, [csvText, mapping, loadPreview]);

  async function handleFile(file: File) {
    setFilename(file.name);
    setDecisions({});
    setMapping({});
    setImportError(null);
    setDuplicateSkus([]);
    try {
      setCsvText(await file.text());
    } catch (err) {
      setPreviewError(`Failed to read file: ${err}`);
      setCsvText('');
    }
  }

  const isMfn = preview?.batch.channel === 'MFN';

  // Rows that will actually be imported (not skipped).
  const activeRows = useMemo(
    () => (preview?.rows ?? []).filter(r => !decisions[String(r.rowIndex)]?.skip),
    [preview, decisions],
  );
  const activeErrors = activeRows.filter(r => r.errors.length > 0).length;
  const activeDupes = activeRows.filter(r => r.duplicateInCsv).length;

  const totals = useMemo(() => {
    let units = 0, cost = 0, list = 0;
    for (const r of activeRows) {
      if (r.errors.length) continue;
      units += r.quantity; cost += r.costCents * r.quantity; list += r.listPriceCents * r.quantity;
    }
    return { units, cost, list };
  }, [activeRows]);

  const canImport =
    !!preview && !importing && !loadingPreview &&
    preview.globalErrors.length === 0 &&
    activeRows.length > 0 && activeErrors === 0 && activeDupes === 0;

  function setMode(rowIndex: number, mode: 'CREATE_NEW' | 'REPLENISH_EXISTING') {
    setDecisions(d => ({ ...d, [rowIndex]: { ...d[rowIndex], mode } }));
  }
  function toggleSkip(rowIndex: number) {
    setDecisions(d => ({ ...d, [rowIndex]: { ...d[rowIndex], skip: !d[rowIndex]?.skip } }));
  }

  async function handleImport() {
    if (!canImport) return;
    setImporting(true);
    setImportError(null);
    setDuplicateSkus([]);
    try {
      const res = await fetch(`/api/list/batches/${id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText, mapping, decisions }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        if (Array.isArray(data?.duplicateSkus)) setDuplicateSkus(data.duplicateSkus);
        setImportError(data?.error || `Import failed (HTTP ${res.status})`);
        return;
      }
      router.push(`/list/${id}`);
    } catch (err) {
      setImportError(String(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <div className="mb-4">
        <div className="flex items-center gap-2 text-xs text-text-tertiary mb-1">
          <Link href={`/list/${id}`} className="hover:text-text-secondary inline-flex items-center gap-1">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to batch
          </Link>
          <span>/</span>
          <span>Import buy list</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Import Buy List</h1>
        <p className="text-sm text-text-tertiary mt-0.5">
          {preview
            ? <>Upload a CSV to add items into <span className="text-text-secondary font-medium">{preview.batch.name}</span> ({preview.batch.channel}).</>
            : 'Upload a CSV (e.g. an Airtable export) to add items into this batch in one go.'}
        </p>
      </div>

      <FileDropper filename={filename} onFile={handleFile} />

      {previewError && (
        <div className="mt-4 rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{previewError}</span>
        </div>
      )}

      {preview && (
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
          <MappingPanel headers={preview.headers} mapping={preview.columnMapping}
            onChange={(key, header) => setMapping(m => ({ ...m, [key]: header }))} />

          <div className="space-y-5">
            {preview.globalErrors.length > 0 && (
              <div className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
                <div className="font-semibold mb-1">Column mapping incomplete</div>
                <ul className="list-disc list-inside space-y-0.5">
                  {preview.globalErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}

            <SummaryCards
              rows={preview.rows.length} units={totals.units}
              cost={totals.cost} list={totals.list}
              errors={activeErrors} loading={loadingPreview} />

            <PreviewTable rows={preview.rows} isMfn={!!isMfn} decisions={decisions}
              onMode={setMode} onToggleSkip={toggleSkip} />

            {importError && (
              <div className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
                <div className="font-semibold mb-1">Import blocked</div>
                <div className="text-negative/90">{importError}</div>
                {duplicateSkus.length > 0 && (
                  <ul className="mt-2 font-mono text-xs space-y-0.5">
                    {duplicateSkus.map(s => <li key={s} className="break-all">{s}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-3 flex items-center justify-between gap-4">
              <div className="text-xs text-text-tertiary">
                {activeErrors > 0
                  ? `Fix or skip ${activeErrors} row error${activeErrors === 1 ? '' : 's'} before importing.`
                  : activeDupes > 0
                    ? `Resolve ${activeDupes} duplicate MSKU row${activeDupes === 1 ? '' : 's'} before importing.`
                    : `Will add ${activeRows.length} item${activeRows.length === 1 ? '' : 's'} (${totals.units} unit${totals.units === 1 ? '' : 's'}) to this batch.`}
              </div>
              <button
                type="button"
                disabled={!canImport}
                onClick={handleImport}
                className={
                  'inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ' +
                  (canImport ? 'bg-accent text-white hover:bg-accent-hover' : 'bg-bg-elevated text-text-tertiary cursor-not-allowed')
                }
              >
                {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {importing ? 'Adding to batch…' : 'Add Buy List to Batch'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FileDropper({ filename, onFile }: { filename: string | null; onFile: (f: File) => void }) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <label
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      className={
        'block rounded-lg border border-dashed px-5 py-6 cursor-pointer transition-colors ' +
        (dragOver ? 'border-accent bg-accent/5' : 'border-border-default bg-bg-surface hover:bg-bg-hover')
      }
    >
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-md bg-bg-elevated border border-border-subtle flex items-center justify-center">
          <FileUp className="w-4 h-4 text-text-secondary" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium text-text-primary">{filename ? filename : 'Choose a buy-list CSV'}</div>
          <div className="text-xs text-text-tertiary mt-0.5">{filename ? 'Click or drop to replace' : 'Click to browse or drop here'}</div>
        </div>
      </div>
      <input type="file" accept=".csv,text/csv" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
    </label>
  );
}

function MappingPanel({
  headers, mapping, onChange,
}: { headers: string[]; mapping: ColumnMapping; onChange: (key: FieldKey, header: string | null) => void }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface h-fit">
      <div className="px-4 py-3 border-b border-border-subtle">
        <div className="text-xs uppercase tracking-wide text-text-tertiary font-medium">Column mapping</div>
      </div>
      <ul className="px-2 py-2 text-sm space-y-1">
        {FIELD_KEYS.map(key => (
          <li key={key} className="px-2 py-1 flex items-center justify-between gap-2">
            <span className="text-text-secondary text-xs">{FIELD_LABELS[key]}</span>
            <select
              value={mapping[key] ?? ''}
              onChange={e => onChange(key, e.target.value || null)}
              className="max-w-[150px] text-xs font-mono bg-bg-elevated border border-border-subtle rounded px-1.5 py-1 text-text-primary"
            >
              <option value="">—</option>
              {headers.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SummaryCards({
  rows, units, cost, list, errors, loading,
}: { rows: number; units: number; cost: number; list: number; errors: number; loading: boolean }) {
  const cells: Array<{ label: string; value: string; tone?: 'negative' }> = [
    { label: 'Rows', value: String(rows) },
    { label: 'Units', value: String(units) },
    { label: 'Total cost', value: formatCurrency(cost) },
    { label: 'Total list', value: formatCurrency(list) },
    { label: 'Errors', value: String(errors), tone: errors ? 'negative' : undefined },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      {cells.map((c, i) => (
        <div key={i} className="rounded-lg border border-border-subtle bg-bg-surface px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wide font-medium text-text-tertiary flex items-center gap-1">
            {c.label}
            {loading && i === 0 && <RefreshCw className="w-3 h-3 animate-spin" />}
          </div>
          <div className={'font-mono font-semibold tabular-nums text-lg mt-0.5 ' + (c.tone === 'negative' ? 'text-negative' : 'text-text-primary')}>
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function PreviewTable({
  rows, isMfn, decisions, onMode, onToggleSkip,
}: {
  rows: PreviewRow[]; isMfn: boolean; decisions: Record<string, RowDecision>;
  onMode: (rowIndex: number, mode: 'CREATE_NEW' | 'REPLENISH_EXISTING') => void;
  onToggleSkip: (rowIndex: number) => void;
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-text-tertiary font-medium">Preview</div>
        <div className="text-xs text-text-tertiary">{rows.length} row{rows.length === 1 ? '' : 's'}</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-elevated text-[10px] uppercase tracking-wide text-text-tertiary font-medium">
              <th className="text-left px-3 py-2 font-medium">Status</th>
              <th className="text-left px-3 py-2 font-medium">MSKU</th>
              <th className="text-left px-3 py-2 font-medium">ASIN</th>
              <th className="text-left px-3 py-2 font-medium">Product</th>
              <th className="text-right px-3 py-2 font-medium">Qty</th>
              <th className="text-right px-3 py-2 font-medium">Cost</th>
              <th className="text-right px-3 py-2 font-medium">List</th>
              <th className="text-left px-3 py-2 font-medium">Existing</th>
              {!isMfn && <th className="text-left px-3 py-2 font-medium">Action</th>}
              <th className="text-left px-3 py-2 font-medium">Notes</th>
              <th className="text-center px-3 py-2 font-medium">Skip</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const skipped = !!decisions[String(row.rowIndex)]?.skip;
              const hasErr = row.errors.length > 0 || row.duplicateInCsv;
              const hasWarn = row.warnings.length > 0;
              const rowTint = skipped ? 'opacity-40' : hasErr ? 'bg-negative/[0.05]' : hasWarn ? 'bg-warning/[0.05]' : '';
              const mode = decisions[String(row.rowIndex)]?.mode || row.suggestedMode;
              return (
                <tr key={row.rowIndex} className={`border-t border-border-subtle hover:bg-bg-hover ${rowTint}`}>
                  <td className="px-3 py-2 align-top">
                    {hasErr ? (
                      <span className="inline-flex items-center gap-1 text-negative text-xs"><AlertCircle className="w-3.5 h-3.5" /> Error</span>
                    ) : hasWarn ? (
                      <span className="inline-flex items-center gap-1 text-warning text-xs"><AlertTriangle className="w-3.5 h-3.5" /> Warn</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-positive text-xs"><CheckCircle2 className="w-3.5 h-3.5" /> OK</span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-primary break-all">{row.msku || <span className="text-text-tertiary">—</span>}</td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-primary">{row.asin || <span className="text-text-tertiary">—</span>}</td>
                  <td className="px-3 py-2 align-top text-text-secondary max-w-[220px]">
                    <div className="truncate" title={row.productName}>{row.productName || <span className="text-text-tertiary">—</span>}</div>
                  </td>
                  <td className="px-3 py-2 align-top text-right font-mono tabular-nums text-text-primary">{row.quantity || <span className="text-text-tertiary">—</span>}</td>
                  <td className="px-3 py-2 align-top text-right font-mono tabular-nums text-text-primary">{row.costCents ? formatCurrency(row.costCents) : <span className="text-text-tertiary">—</span>}</td>
                  <td className="px-3 py-2 align-top text-right font-mono tabular-nums text-text-primary">{row.listPriceCents ? formatCurrency(row.listPriceCents) : <span className="text-text-tertiary">—</span>}</td>
                  <td className="px-3 py-2 align-top text-xs">
                    {row.existsBySku ? (
                      <span className="text-warning">MSKU exists</span>
                    ) : row.existsByAsin ? (
                      <span className="text-text-tertiary">ASIN known</span>
                    ) : (
                      <span className="text-positive">New</span>
                    )}
                  </td>
                  {!isMfn && (
                    <td className="px-3 py-2 align-top">
                      {row.existsBySku ? (
                        <select
                          value={mode}
                          onChange={e => onMode(row.rowIndex, e.target.value as 'CREATE_NEW' | 'REPLENISH_EXISTING')}
                          className="text-xs bg-bg-elevated border border-border-subtle rounded px-1.5 py-1 text-text-primary"
                        >
                          <option value="REPLENISH_EXISTING">Replenish existing</option>
                          <option value="CREATE_NEW">Create new MSKU</option>
                        </select>
                      ) : (
                        <span className="text-xs text-text-tertiary">Create new</span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 align-top text-xs max-w-[220px]">
                    {row.errors.map((e, i) => <div key={`e${i}`} className="text-negative">{e}</div>)}
                    {row.duplicateInCsv && <div className="text-negative">Duplicate MSKU in file</div>}
                    {row.warnings.map((w, i) => <div key={`w${i}`} className="text-warning">{w}</div>)}
                    {!hasErr && !hasWarn && <span className="text-text-tertiary">—</span>}
                  </td>
                  <td className="px-3 py-2 align-top text-center">
                    <input type="checkbox" checked={skipped} onChange={() => onToggleSkip(row.rowIndex)} />
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={isMfn ? 10 : 11} className="px-3 py-6 text-center text-text-tertiary text-sm">No parseable rows in this CSV.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
