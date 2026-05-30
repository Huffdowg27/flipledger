'use client';

// InventoryLab FBM CSV importer. Wizard mounts the shared parser for the
// preview, then POSTs the raw CSV to /api/mfn/import-inventorylab which
// re-parses server-side and creates the batch + inventory_ledger lots inside
// a single transaction. Client-side preview is never trusted as the source
// of truth.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileUp, AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { formatCurrency } from '@/lib/formatters';
import {
  parseFbmCsv,
  type ParseResult,
  type FieldKey,
  type ColumnMapping,
} from '@/lib/imports/inventorylab-fbm';

// Display order + labels for the column-mapping panel. Keeps the wizard
// looking like InventoryLab's matcher: target field on the left, CSV header
// it mapped to on the right.
const MAPPING_FIELDS: Array<{ key: FieldKey; label: string; hint?: string }> = [
  { key: 'asin',                label: 'ASIN' },
  { key: 'product',             label: 'Title' },
  { key: 'cost',                label: 'Cost / Unit' },
  { key: 'salesPrice',          label: 'List Price' },
  { key: 'sellerSku',           label: 'MSKU (Seller Sku)' },
  { key: 'dateOrdered',         label: 'Purchase Date', hint: 'falls back to SKU date' },
  { key: 'supplier',            label: 'Supplier' },
  { key: 'fulfillmentType',     label: 'Fulfillment Type' },
  { key: 'upc',                 label: 'UPC' },
  { key: 'fbmShippingEstimate', label: 'FBM Shipping Estimate' },
  { key: 'shippingTemplate',    label: 'MFN Shipping Template' },
];

export default function MfnImportPage() {
  const router = useRouter();
  const [filename, setFilename] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [duplicateSkus, setDuplicateSkus] = useState<string[]>([]);

  const parsed = useMemo<{ result: ParseResult | null; error: string | null }>(() => {
    if (!csvText) return { result: null, error: null };
    try {
      return { result: parseFbmCsv(csvText), error: null };
    } catch (err) {
      return { result: null, error: String(err) };
    }
  }, [csvText]);
  const result = parsed.result;
  const effectiveError = parseError ?? parsed.error;

  async function handleFile(file: File) {
    setParseError(null);
    setFilename(file.name);
    try {
      const text = await file.text();
      setCsvText(text);
    } catch (err) {
      setParseError(`Failed to read file: ${err}`);
      setCsvText('');
    }
  }

  // Row-level error / row-count summary used to enable the confirm action.
  const previewRowErrors = result ? result.rows.filter(r => r.errors.length > 0).length : 0;
  const canConfirm =
    !!result
    && !importing
    && result.globalErrors.length === 0
    && previewRowErrors === 0
    && result.rows.length > 0;

  async function handleConfirmImport() {
    if (!csvText || !canConfirm) return;
    setImporting(true);
    setImportError(null);
    setDuplicateSkus([]);
    try {
      const res = await fetch('/api/mfn/import-inventorylab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        if (Array.isArray(data?.duplicateSkus)) setDuplicateSkus(data.duplicateSkus);
        setImportError(data?.error || `Import failed (HTTP ${res.status})`);
        return;
      }
      router.push(`/list/${data.batchId}`);
    } catch (err) {
      setImportError(String(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-text-tertiary mb-1">
            <Link href="/mfn/batch" className="hover:text-text-secondary inline-flex items-center gap-1">
              <ArrowLeft className="w-3.5 h-3.5" />
              MFN
            </Link>
            <span>/</span>
            <span>Import</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">InventoryLab FBM Import</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Upload an InventoryLab FBM buy-list CSV. Preview, then create a draft MFN batch.
          </p>
        </div>
      </div>

      <FileDropper filename={filename} onFile={handleFile} />

      {effectiveError && (
        <div className="mt-4 rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{effectiveError}</span>
        </div>
      )}

      {result && (
        <>
          {result.globalErrors.length > 0 && (
            <div className="mt-4 rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold mb-1">CSV problems</div>
                  <ul className="list-disc list-inside space-y-0.5">
                    {result.globalErrors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              </div>
            </div>
          )}

          <div className="mt-5 grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
            <MappingPanel mapping={result.columnMapping} />
            <div className="space-y-5">
              <SummaryCards result={result} />
              <PreviewTable result={result} />

              {importError && (
                <div className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <div className="font-semibold mb-1">Import blocked</div>
                      <div className="text-negative/90">{importError}</div>
                      {duplicateSkus.length > 0 && (
                        <div className="mt-2 text-xs">
                          <div className="font-medium mb-1">SKUs already in inventory:</div>
                          <ul className="font-mono space-y-0.5">
                            {duplicateSkus.map(s => <li key={s} className="break-all">{s}</li>)}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-3 flex items-center justify-between gap-4">
                <div className="text-xs text-text-tertiary">
                  {previewRowErrors > 0
                    ? `Fix ${previewRowErrors} row error${previewRowErrors === 1 ? '' : 's'} before importing.`
                    : `Will create ${result.rows.length} lot${result.rows.length === 1 ? '' : 's'} totalling ${result.totals.totalUnits} unit${result.totals.totalUnits === 1 ? '' : 's'}.`}
                </div>
                <button
                  type="button"
                  disabled={!canConfirm}
                  onClick={handleConfirmImport}
                  className={
                    'inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ' +
                    (canConfirm
                      ? 'bg-accent text-white hover:bg-accent-hover'
                      : 'bg-bg-elevated text-text-tertiary cursor-not-allowed')
                  }
                >
                  {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {importing ? 'Creating batch…' : 'Create MFN Batch'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FileDropper({
  filename, onFile,
}: { filename: string | null; onFile: (f: File) => void }) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <label
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={
        'block rounded-lg border border-dashed px-5 py-6 cursor-pointer transition-colors ' +
        (dragOver
          ? 'border-accent bg-accent/5'
          : 'border-border-default bg-bg-surface hover:bg-bg-hover')
      }
    >
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-md bg-bg-elevated border border-border-subtle flex items-center justify-center">
          <FileUp className="w-4 h-4 text-text-secondary" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium text-text-primary">
            {filename ? filename : 'Choose an InventoryLab FBM CSV'}
          </div>
          <div className="text-xs text-text-tertiary mt-0.5">
            {filename ? 'Click or drop to replace' : 'Click to browse or drop here'}
          </div>
        </div>
      </div>
      <input
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
    </label>
  );
}

function MappingPanel({ mapping }: { mapping: ColumnMapping }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface">
      <div className="px-4 py-3 border-b border-border-subtle">
        <div className="text-xs uppercase tracking-wide text-text-tertiary font-medium">
          Column mapping
        </div>
      </div>
      <ul className="px-2 py-2 text-sm">
        {MAPPING_FIELDS.map(f => {
          const mapped = mapping[f.key];
          return (
            <li key={f.key} className="px-2 py-1.5 flex items-baseline justify-between gap-3">
              <div className="text-text-secondary">
                {f.label}
                {f.hint && (
                  <div className="text-[10px] text-text-tertiary leading-tight">{f.hint}</div>
                )}
              </div>
              <div className={
                'font-mono text-xs tabular-nums ' +
                (mapped ? 'text-text-primary' : 'text-text-tertiary')
              }>
                {mapped ?? '—'}
              </div>
            </li>
          );
        })}
        {/* Quantity is special: not a column, derived from the MSKU */}
        <li className="px-2 py-1.5 flex items-baseline justify-between gap-3 border-t border-border-subtle mt-1 pt-2">
          <div className="text-text-secondary">
            Quantity
            <div className="text-[10px] text-text-tertiary leading-tight">extracted from Seller Sku</div>
          </div>
          <div className="font-mono text-xs text-accent">SKU-derived</div>
        </li>
      </ul>
    </div>
  );
}

function SummaryCards({ result }: { result: ParseResult }) {
  const { totals, rows } = result;
  const errorCount = rows.filter(r => r.errors.length > 0).length;
  const warningCount = rows.filter(r => r.warnings.length > 0).length;
  const cells: Array<{ label: string; value: string; tone?: 'positive' | 'warning' | 'negative' }> = [
    { label: 'Rows',         value: String(totals.rowCount) },
    { label: 'Total units',  value: String(totals.totalUnits) },
    { label: 'Total cost',   value: formatCurrency(totals.totalCostCents) },
    { label: 'Total list',   value: formatCurrency(totals.totalListValueCents) },
    { label: 'Total ship',   value: formatCurrency(totals.totalEstimatedShippingCents) },
    { label: 'Errors',       value: String(errorCount),  tone: errorCount   ? 'negative' : undefined },
    { label: 'Warnings',     value: String(warningCount), tone: warningCount ? 'warning'  : undefined },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
      {cells.map((c, i) => (
        <div key={i} className="rounded-lg border border-border-subtle bg-bg-surface px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wide font-medium text-text-tertiary">
            {c.label}
          </div>
          <div className={
            'font-mono font-semibold tabular-nums text-lg mt-0.5 ' +
            (c.tone === 'negative' ? 'text-negative'
             : c.tone === 'warning' ? 'text-warning'
             : 'text-text-primary')
          }>
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function PreviewTable({ result }: { result: ParseResult }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-text-tertiary font-medium">
          Preview
        </div>
        <div className="text-xs text-text-tertiary">{result.rows.length} row{result.rows.length === 1 ? '' : 's'}</div>
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
              <th className="text-right px-3 py-2 font-medium">Cost/unit</th>
              <th className="text-right px-3 py-2 font-medium">List</th>
              <th className="text-left px-3 py-2 font-medium">Purchased</th>
              <th className="text-left px-3 py-2 font-medium">Supplier</th>
              <th className="text-right px-3 py-2 font-medium">Ship est</th>
              <th className="text-left px-3 py-2 font-medium">Template</th>
              <th className="text-left px-3 py-2 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map(row => {
              const hasErr = row.errors.length > 0;
              const hasWarn = row.warnings.length > 0;
              const rowTint =
                hasErr ? 'bg-negative/[0.05]'
                : hasWarn ? 'bg-warning/[0.05]'
                : '';
              return (
                <tr
                  key={row.rowIndex}
                  className={`border-t border-border-subtle hover:bg-bg-hover ${rowTint}`}
                >
                  <td className="px-3 py-2 align-top">
                    {hasErr ? (
                      <span className="inline-flex items-center gap-1 text-negative text-xs">
                        <AlertCircle className="w-3.5 h-3.5" /> Error
                      </span>
                    ) : hasWarn ? (
                      <span className="inline-flex items-center gap-1 text-warning text-xs">
                        <AlertTriangle className="w-3.5 h-3.5" /> Warn
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-positive text-xs">
                        <CheckCircle2 className="w-3.5 h-3.5" /> OK
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-primary break-all">
                    {row.rawSku || <span className="text-text-tertiary">—</span>}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-primary">
                    {row.asin || <span className="text-text-tertiary">—</span>}
                  </td>
                  <td className="px-3 py-2 align-top text-text-secondary max-w-[260px]">
                    <div className="truncate" title={row.productName}>
                      {row.productName || <span className="text-text-tertiary">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top text-right font-mono tabular-nums text-text-primary">
                    {row.quantity || <span className="text-text-tertiary">—</span>}
                  </td>
                  <td className="px-3 py-2 align-top text-right font-mono tabular-nums text-text-primary">
                    {row.costCents ? formatCurrency(row.costCents) : <span className="text-text-tertiary">—</span>}
                  </td>
                  <td className="px-3 py-2 align-top text-right font-mono tabular-nums text-text-primary">
                    {row.listPriceCents ? formatCurrency(row.listPriceCents) : <span className="text-text-tertiary">—</span>}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-secondary">
                    {row.purchaseDate || <span className="text-text-tertiary">—</span>}
                  </td>
                  <td className="px-3 py-2 align-top text-text-secondary">
                    {row.supplier || <span className="text-text-tertiary">—</span>}
                  </td>
                  <td className="px-3 py-2 align-top text-right font-mono tabular-nums text-text-secondary">
                    {row.estimatedShipCents ? formatCurrency(row.estimatedShipCents) : <span className="text-text-tertiary">—</span>}
                  </td>
                  <td className="px-3 py-2 align-top text-text-secondary text-xs">
                    {row.shippingTemplate || <span className="text-text-tertiary">—</span>}
                  </td>
                  <td className="px-3 py-2 align-top text-xs max-w-[260px]">
                    {row.errors.map((e, i) => (
                      <div key={`e${i}`} className="text-negative">{e}</div>
                    ))}
                    {row.warnings.map((w, i) => (
                      <div key={`w${i}`} className="text-warning">{w}</div>
                    ))}
                    {!hasErr && !hasWarn && (
                      <span className="text-text-tertiary">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {result.rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-text-tertiary text-sm">
                  No parseable rows in this CSV.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="bg-bg-elevated border-t-2 border-border-strong">
              <td colSpan={4} className="px-3 py-2 text-xs uppercase tracking-wide text-text-tertiary font-medium">Totals</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-text-primary">
                {result.totals.totalUnits}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-text-primary">
                {formatCurrency(result.totals.totalCostCents)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-text-primary">
                {formatCurrency(result.totals.totalListValueCents)}
              </td>
              <td colSpan={2}></td>
              <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-text-primary">
                {formatCurrency(result.totals.totalEstimatedShippingCents)}
              </td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
