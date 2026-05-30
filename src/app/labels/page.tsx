'use client';

import { useMemo, useState } from 'react';
import { Printer, Trash2, Plus, AlertTriangle } from 'lucide-react';

// Standalone label print workspace. Bulk paste, validate, print.
// Reuses /api/labels/print — no shared state with /list/[id] or
// /analyze/merchant-inventory. This page never reads from or writes to DB.

type LabelMode = 'asin' | 'fnsku' | 'warehouse' | 'custom';
type LabelSize = '2x1' | '4x6';

interface LabelSpec {
  labelMode: LabelMode;
  size: LabelSize;
  title?: string;
  asin?: string;
  fnsku?: string;
  sku?: string;
  bin?: string;
  condition?: string;
  priceCents?: number;
  showPrice?: boolean;
  showBin?: boolean;
  subtitle?: string;
  notes?: string;
}

interface ParsedRow {
  raw: string;
  spec: Omit<LabelSpec, 'labelMode' | 'size'> | null;
  copies: number;
  error: string | null;
}

interface CustomRow {
  title: string;
  subtitle: string;
  notes: string;
  bin: string;
  copies: number;
}

const ASIN_RE = /^B[0-9A-Z]{9}$/i;
const FNSKU_RE = /^X00[0-9A-Z]+$/i;

const HELP: Record<LabelMode, { columns: string; example: string; note?: string }> = {
  asin: {
    columns: 'ASIN | title | condition | bin | copies',
    example: 'B07ABCD123 | OXO Good Grips Spatula | Used - Like New | A-12 | 2',
    note: 'Customer-safe. Barcode is the ASIN. MSKU and cost never render.',
  },
  fnsku: {
    columns: 'FNSKU | title | condition | copies',
    example: 'X001ABCDEF | OXO Good Grips Spatula | New | 1',
    note: 'FNSKU must start with X00. ASIN is never used as a fallback.',
  },
  warehouse: {
    columns: 'ASIN | MSKU | title | condition | bin | price | copies',
    example: 'B07ABCD123 | LV_01FA_021126_19.95_24_3_P_113 | OXO Spatula | UsedLikeNew | A-12 | 14.99 | 1',
    note: 'Internal only. Renders MSKU + bin + price. Do not give to customers.',
  },
  custom: {
    columns: '(use the row form below)',
    example: '',
    note: 'Free-text. No barcode. Useful for shelf tags, supplier markers, removal notes.',
  },
};

function splitRowFields(row: string): string[] {
  // Accept pipe, tab, or comma. Pipe wins — clearest visual delimiter.
  const trimmed = row.trim();
  if (!trimmed) return [];
  if (trimmed.includes('|')) return trimmed.split('|').map(s => s.trim());
  if (trimmed.includes('\t')) return trimmed.split('\t').map(s => s.trim());
  return trimmed.split(',').map(s => s.trim());
}

function parseInt1(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  if (n > 1000) return 1000; // cap copies per row
  return n;
}

function parseCents(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[$,]/g, '').trim();
  const f = parseFloat(cleaned);
  if (!Number.isFinite(f)) return undefined;
  return Math.round(f * 100);
}

function parseRow(mode: LabelMode, raw: string): ParsedRow {
  const fields = splitRowFields(raw);
  if (fields.length === 0) {
    return { raw, spec: null, copies: 0, error: null };
  }

  if (mode === 'asin') {
    const [asin, title, condition, bin, copiesStr] = fields;
    if (!asin || !ASIN_RE.test(asin)) {
      return { raw, spec: null, copies: 0, error: 'ASIN must match B + 9 alphanumerics' };
    }
    return {
      raw,
      spec: {
        asin: asin.toUpperCase(),
        title: title || undefined,
        condition: condition || undefined,
        bin: bin || undefined,
        showBin: !!bin,
      },
      copies: parseInt1(copiesStr, 1),
      error: null,
    };
  }

  if (mode === 'fnsku') {
    const [fnsku, title, condition, copiesStr] = fields;
    if (!fnsku || !FNSKU_RE.test(fnsku)) {
      return { raw, spec: null, copies: 0, error: 'FNSKU must start with X00' };
    }
    return {
      raw,
      spec: {
        fnsku: fnsku.toUpperCase(),
        title: title || undefined,
        condition: condition || undefined,
      },
      copies: parseInt1(copiesStr, 1),
      error: null,
    };
  }

  if (mode === 'warehouse') {
    const [asin, sku, title, condition, bin, price, copiesStr] = fields;
    if (!asin || !ASIN_RE.test(asin)) {
      return { raw, spec: null, copies: 0, error: 'ASIN must match B + 9 alphanumerics' };
    }
    const priceCents = parseCents(price);
    return {
      raw,
      spec: {
        asin: asin.toUpperCase(),
        sku: sku || undefined,
        title: title || undefined,
        condition: condition || undefined,
        bin: bin || undefined,
        priceCents,
        showPrice: priceCents !== undefined,
      },
      copies: parseInt1(copiesStr, 1),
      error: null,
    };
  }

  return { raw, spec: null, copies: 0, error: 'Unsupported mode' };
}

function buildSpecs(
  mode: LabelMode,
  size: LabelSize,
  parsed: ParsedRow[],
  customRows: CustomRow[],
): LabelSpec[] {
  if (mode === 'custom') {
    const out: LabelSpec[] = [];
    for (const r of customRows) {
      const hasContent = r.title.trim() || r.subtitle.trim() || r.notes.trim() || r.bin.trim();
      if (!hasContent) continue;
      const copies = Math.max(1, Math.min(1000, r.copies || 1));
      for (let i = 0; i < copies; i++) {
        out.push({
          labelMode: 'custom',
          size,
          title: r.title.trim() || undefined,
          subtitle: r.subtitle.trim() || undefined,
          notes: r.notes.trim() || undefined,
          bin: r.bin.trim() || undefined,
        });
      }
    }
    return out;
  }

  const out: LabelSpec[] = [];
  for (const row of parsed) {
    if (!row.spec || row.copies < 1) continue;
    for (let i = 0; i < row.copies; i++) {
      out.push({ labelMode: mode, size, ...row.spec });
    }
  }
  return out;
}

function encodeSpecs(specs: LabelSpec[]): string {
  const json = JSON.stringify(specs);
  if (typeof window === 'undefined') return '';
  // btoa requires latin-1 — escape unicode first.
  const utf8 = unescape(encodeURIComponent(json));
  return window.btoa(utf8);
}

export default function LabelsPage() {
  const [mode, setMode] = useState<LabelMode>('asin');
  const [size, setSize] = useState<LabelSize>('2x1');
  const [pasteText, setPasteText] = useState('');
  const [customRows, setCustomRows] = useState<CustomRow[]>([
    { title: '', subtitle: '', notes: '', bin: '', copies: 1 },
  ]);

  const parsedRows = useMemo<ParsedRow[]>(() => {
    if (mode === 'custom') return [];
    return pasteText
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => parseRow(mode, line));
  }, [mode, pasteText]);

  const specs = useMemo(
    () => buildSpecs(mode, size, parsedRows, customRows),
    [mode, size, parsedRows, customRows],
  );

  const errorCount = mode === 'custom' ? 0 : parsedRows.filter(r => r.error).length;
  const validRowCount = mode === 'custom'
    ? customRows.filter(r => r.title || r.subtitle || r.notes || r.bin).length
    : parsedRows.filter(r => r.spec).length;

  const help = HELP[mode];

  function handlePrint() {
    if (specs.length === 0) return;
    const encoded = encodeSpecs(specs);
    window.open(`/api/labels/print?d=${encoded}`, '_blank', 'noopener');
  }

  function handleClear() {
    setPasteText('');
    setCustomRows([{ title: '', subtitle: '', notes: '', bin: '', copies: 1 }]);
  }

  function updateCustom(idx: number, patch: Partial<CustomRow>) {
    setCustomRows(rows => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function addCustomRow() {
    setCustomRows(rows => [...rows, { title: '', subtitle: '', notes: '', bin: '', copies: 1 }]);
  }

  function removeCustomRow(idx: number) {
    setCustomRows(rows => (rows.length === 1 ? rows : rows.filter((_, i) => i !== idx)));
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Labels</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Bulk-print barcode and custom labels. Reuses the same renderer as batch and merchant
            inventory labels — formats render identically.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleClear}
            className="px-3 py-1.5 text-sm rounded border border-border-subtle text-text-secondary hover:bg-bg-surface"
            disabled={!pasteText && customRows.every(r => !r.title && !r.subtitle && !r.notes && !r.bin)}
          >
            Clear
          </button>
          <button
            onClick={handlePrint}
            disabled={specs.length === 0}
            className="px-4 py-1.5 text-sm rounded bg-accent text-white font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Printer size={16} />
            Print {specs.length > 0 ? `${specs.length} label${specs.length !== 1 ? 's' : ''}` : ''}
          </button>
        </div>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1 border-b border-border-subtle mb-4">
        {(['asin', 'fnsku', 'warehouse', 'custom'] as LabelMode[]).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              mode === m
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {m === 'asin' && 'ASIN (customer-safe)'}
            {m === 'fnsku' && 'FNSKU'}
            {m === 'warehouse' && 'Warehouse (internal)'}
            {m === 'custom' && 'Custom'}
          </button>
        ))}
      </div>

      {/* Size + help row */}
      <div className="flex items-start gap-4 mb-4">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-text-tertiary font-medium">Size</span>
          <div className="flex rounded border border-border-subtle overflow-hidden">
            {(['2x1', '4x6'] as LabelSize[]).map(s => (
              <button
                key={s}
                onClick={() => setSize(s)}
                className={`px-3 py-1 text-sm ${
                  size === s ? 'bg-accent text-white' : 'bg-bg-surface text-text-secondary hover:bg-bg-elevated'
                }`}
              >
                {s === '2x1' ? '2" × 1" thermal' : '4" × 6" thermal'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 text-xs text-text-tertiary border border-border-subtle rounded p-2 bg-bg-surface">
          <div className="font-mono mb-1">
            <span className="text-text-secondary">Columns:</span> {help.columns}
          </div>
          {help.example && (
            <div className="font-mono">
              <span className="text-text-secondary">Example:</span> {help.example}
            </div>
          )}
          {help.note && <div className="mt-1 italic">{help.note}</div>}
        </div>
      </div>

      {/* Body — paste area (most modes) or custom row form */}
      {mode === 'custom' ? (
        <div className="space-y-2">
          {customRows.map((row, idx) => (
            <div
              key={idx}
              className="grid grid-cols-12 gap-2 items-start p-2 border border-border-subtle rounded bg-bg-surface"
            >
              <input
                type="text"
                placeholder="Title (large)"
                value={row.title}
                onChange={e => updateCustom(idx, { title: e.target.value })}
                className="col-span-3 px-2 py-1 text-sm border border-border-subtle rounded bg-bg-base"
              />
              <input
                type="text"
                placeholder="Subtitle"
                value={row.subtitle}
                onChange={e => updateCustom(idx, { subtitle: e.target.value })}
                className="col-span-3 px-2 py-1 text-sm border border-border-subtle rounded bg-bg-base"
              />
              <input
                type="text"
                placeholder="Notes"
                value={row.notes}
                onChange={e => updateCustom(idx, { notes: e.target.value })}
                className="col-span-3 px-2 py-1 text-sm border border-border-subtle rounded bg-bg-base"
              />
              <input
                type="text"
                placeholder="Bin (4x6 only)"
                value={row.bin}
                onChange={e => updateCustom(idx, { bin: e.target.value })}
                className="col-span-2 px-2 py-1 text-sm border border-border-subtle rounded bg-bg-base"
              />
              <div className="col-span-1 flex items-center gap-1">
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={row.copies}
                  onChange={e => updateCustom(idx, { copies: parseInt1(e.target.value, 1) })}
                  className="w-12 px-1 py-1 text-sm border border-border-subtle rounded bg-bg-base"
                  title="Copies"
                />
                <button
                  onClick={() => removeCustomRow(idx)}
                  disabled={customRows.length === 1}
                  className="p-1 text-text-tertiary hover:text-red-500 disabled:opacity-30"
                  title="Remove row"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          <button
            onClick={addCustomRow}
            className="flex items-center gap-1 text-sm px-2 py-1 border border-border-subtle rounded text-text-secondary hover:bg-bg-surface"
          >
            <Plus size={14} /> Add row
          </button>
        </div>
      ) : (
        <textarea
          value={pasteText}
          onChange={e => setPasteText(e.target.value)}
          placeholder={`One row per label. Use | as the separator.\n\n${help.example}`}
          className="w-full h-64 p-3 text-sm font-mono border border-border-subtle rounded bg-bg-surface focus:outline-none focus:border-accent"
          spellCheck={false}
        />
      )}

      {/* Parsed preview */}
      {mode !== 'custom' && pasteText.trim() && (
        <div className="mt-4 border border-border-subtle rounded">
          <div className="px-3 py-2 border-b border-border-subtle bg-bg-surface text-xs uppercase tracking-wide text-text-tertiary flex items-center justify-between">
            <span>Preview ({parsedRows.length} row{parsedRows.length !== 1 ? 's' : ''})</span>
            <span>
              <span className="text-green-500">{validRowCount} valid</span>
              {errorCount > 0 && (
                <span className="ml-3 text-red-500">{errorCount} error{errorCount !== 1 ? 's' : ''}</span>
              )}
              <span className="ml-3 text-text-secondary">→ {specs.length} label{specs.length !== 1 ? 's' : ''}</span>
            </span>
          </div>
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-bg-surface sticky top-0">
                <tr className="text-left text-text-tertiary">
                  <th className="px-2 py-1 font-medium">#</th>
                  <th className="px-2 py-1 font-medium">Identifier</th>
                  <th className="px-2 py-1 font-medium">Title</th>
                  <th className="px-2 py-1 font-medium">Detail</th>
                  <th className="px-2 py-1 font-medium text-right">Copies</th>
                </tr>
              </thead>
              <tbody>
                {parsedRows.map((row, i) => (
                  <tr key={i} className={`border-t border-border-subtle ${row.error ? 'bg-red-500/5' : ''}`}>
                    <td className="px-2 py-1 text-text-tertiary">{i + 1}</td>
                    <td className="px-2 py-1 font-mono">
                      {row.spec?.asin || row.spec?.fnsku || (
                        <span className="text-text-tertiary">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1 truncate max-w-xs" title={row.spec?.title || ''}>
                      {row.spec?.title || <span className="text-text-tertiary">—</span>}
                    </td>
                    <td className="px-2 py-1 text-text-secondary">
                      {row.error ? (
                        <span className="text-red-500 inline-flex items-center gap-1">
                          <AlertTriangle size={12} />
                          {row.error}
                        </span>
                      ) : (
                        [
                          row.spec?.condition,
                          row.spec?.sku,
                          row.spec?.bin && `Bin ${row.spec.bin}`,
                          row.spec?.priceCents !== undefined && `$${(row.spec.priceCents / 100).toFixed(2)}`,
                        ]
                          .filter(Boolean)
                          .join(' · ') || <span className="text-text-tertiary">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{row.error ? '—' : row.copies}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mode === 'fnsku' && validRowCount > 0 && (
        <div className="mt-3 text-xs text-text-tertiary flex items-start gap-2 p-2 border border-border-subtle rounded bg-bg-surface">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-amber-500" />
          <div>
            FNSKU labels never fall back to ASIN. If any row lists an ASIN-format value instead of
            an X00-prefixed FNSKU, it will show as an error above and be skipped.
          </div>
        </div>
      )}
      {mode === 'warehouse' && validRowCount > 0 && (
        <div className="mt-3 text-xs text-text-tertiary flex items-start gap-2 p-2 border border-border-subtle rounded bg-bg-surface">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-amber-500" />
          <div>
            Warehouse labels render MSKU, bin, and price. Do not give these to customers — use ASIN
            mode for customer-facing labels.
          </div>
        </div>
      )}
    </div>
  );
}
