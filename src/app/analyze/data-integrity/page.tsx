'use client';

import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { formatCurrency, formatNumber } from '@/lib/formatters';

type Severity = 'ok' | 'warn' | 'error';

interface Check {
  id: string;
  label: string;
  description: string;
  severity: Severity;
  count: number;
  units?: number;
  amountCents?: number;
  sample: Record<string, any>[];
  fix?: string;
}

interface IntegrityData {
  generatedAt: string;
  overall: Severity;
  summary: {
    cogsCoveragePct: number;
    totalUnits: number;
    coveredUnits: number;
    zeroCogsUnits: number;
    zeroCogsRevenueCents: number;
  };
  checks: Check[];
}

const SEV = {
  ok: { color: 'text-positive', bg: 'border-l-positive', label: 'OK', Icon: ShieldCheck },
  warn: { color: 'text-warning', bg: 'border-l-warning', label: 'Attention', Icon: ShieldAlert },
  error: { color: 'text-negative', bg: 'border-l-negative', label: 'Error', Icon: ShieldX },
} as const;

export default function DataIntegrityPage() {
  const [data, setData] = useState<IntegrityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/data/data-integrity');
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const overall = data ? SEV[data.overall] : SEV.ok;
  const OverallIcon = overall.Icon;

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Data Integrity</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Standing health check on the numbers — the silent failure modes to fix before FlipLedger is the only source of truth.
          </p>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-2 px-3 h-9 text-sm border border-border-default rounded-md bg-bg-elevated text-text-secondary hover:bg-bg-hover transition-colors"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Re-check
        </button>
      </div>

      {!data ? (
        <div className="text-text-tertiary text-sm">{loading ? 'Running checks…' : 'No data.'}</div>
      ) : (
        <>
          {/* Headline */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
            <div className={`bg-bg-surface border border-border-subtle rounded-lg p-5 border-l-4 ${overall.bg}`}>
              <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">Overall</div>
              <div className={`flex items-center gap-2 text-2xl font-bold ${overall.color}`}>
                <OverallIcon size={24} /> {overall.label}
              </div>
            </div>
            <div className="bg-bg-surface border border-border-subtle rounded-lg p-5 border-t-2 border-t-accent">
              <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">COGS Coverage</div>
              <div className="text-2xl font-bold font-mono text-text-primary">{data.summary.cogsCoveragePct.toFixed(2)}%</div>
              <div className="text-xs text-text-tertiary mt-1 font-mono">
                {formatNumber(data.summary.coveredUnits)} / {formatNumber(data.summary.totalUnits)} units costed
              </div>
            </div>
            <div className="bg-bg-surface border border-border-subtle rounded-lg p-5 border-t-2 border-t-negative">
              <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">Revenue Missing Cost</div>
              <div className="text-2xl font-bold font-mono text-text-primary">{formatCurrency(data.summary.zeroCogsRevenueCents)}</div>
              <div className="text-xs text-text-tertiary mt-1 font-mono">
                revenue on {formatNumber(data.summary.zeroCogsUnits)} units currently costed at $0
              </div>
            </div>
          </div>

          {/* Checks */}
          <div className="space-y-3">
            {data.checks.map((c) => {
              const sev = SEV[c.severity];
              const Icon = sev.Icon;
              const hasSample = c.sample && c.sample.length > 0;
              const isOpen = !!expanded[c.id];
              return (
                <div key={c.id} className={`bg-bg-surface border border-border-subtle rounded-lg border-l-4 ${sev.bg}`}>
                  <div
                    className={`flex items-start gap-3 p-4 ${hasSample ? 'cursor-pointer' : ''}`}
                    onClick={() => hasSample && setExpanded((e) => ({ ...e, [c.id]: !e[c.id] }))}
                  >
                    <Icon size={18} className={`${sev.color} mt-0.5 shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary">{c.label}</span>
                        <span className={`text-xs font-mono font-semibold ${c.count > 0 ? sev.color : 'text-text-tertiary'}`}>
                          {formatNumber(c.count)}
                          {c.units != null && c.units !== c.count ? ` · ${formatNumber(c.units)} units` : ''}
                          {c.amountCents != null && c.amountCents !== 0 ? ` · ${formatCurrency(c.amountCents)}` : ''}
                        </span>
                      </div>
                      <p className="text-xs text-text-tertiary mt-1">{c.description}</p>
                      {c.count > 0 && c.fix && (
                        <p className="text-xs text-text-secondary mt-1.5"><span className="text-text-tertiary">Fix:</span> {c.fix}</p>
                      )}
                    </div>
                    {hasSample && (
                      <span className="text-text-tertiary mt-0.5">{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                    )}
                  </div>

                  {hasSample && isOpen && (
                    c.id === 'zero_cogs_sales'
                      ? <ZeroCogsWorklist rows={c.sample} onSaved={fetchData} />
                      : (
                    <div className="border-t border-border-subtle overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-[11px] uppercase tracking-wider text-text-tertiary">
                            {Object.keys(c.sample[0]).map((k) => (
                              <th key={k} className="text-left font-medium px-4 py-2">{prettyKey(k)}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {c.sample.map((row, i) => (
                            <tr key={i} className="border-t border-border-subtle/50">
                              {Object.entries(row).map(([k, v]) => (
                                <td key={k} className="px-4 py-2 text-text-secondary font-mono text-xs whitespace-nowrap">
                                  {renderCell(k, v)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                      )
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-[11px] text-text-tertiary mt-4 font-mono">
            Checked {new Date(data.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Inline COGS-entry worklist for the zero-COGS check (audit F2).
 *
 * Each row is one ASIN sold with no cost recorded. Entering a buy price (and
 * optionally qty/date) creates a purchase lot via POST /api/data/inventory-lots,
 * which re-runs FIFO so the past sales pick up COGS immediately. The lot date
 * defaults to the earliest sale so FIFO covers every unit on that ASIN.
 */
function ZeroCogsWorklist({ rows, onSaved }: { rows: Record<string, any>[]; onSaved: () => void }) {
  return (
    <div className="border-t border-border-subtle overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-text-tertiary">
            <th className="text-left font-medium px-4 py-2">ASIN</th>
            <th className="text-left font-medium px-4 py-2">Product</th>
            <th className="text-right font-medium px-4 py-2">Units</th>
            <th className="text-right font-medium px-4 py-2">Revenue</th>
            <th className="text-left font-medium px-4 py-2">Buy $/unit</th>
            <th className="text-left font-medium px-4 py-2">Qty</th>
            <th className="text-left font-medium px-4 py-2">Purchased</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <ZeroCogsRow key={(row.asin as string) || i} row={row} onSaved={onSaved} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ZeroCogsRow({ row, onSaved }: { row: Record<string, any>; onSaved: () => void }) {
  const units = Number(row.units) || 1;
  const defaultDate = ((row.firstSold as string) || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const [buyPrice, setBuyPrice] = useState('');
  const [qty, setQty] = useState(String(units));
  const [date, setDate] = useState(defaultDate);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [err, setErr] = useState('');

  const save = async () => {
    const bp = Number(buyPrice);
    if (!Number.isFinite(bp) || bp < 0 || buyPrice.trim() === '') {
      setStatus('error'); setErr('Enter a buy price'); return;
    }
    setStatus('saving'); setErr('');
    try {
      const res = await fetch('/api/data/inventory-lots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asin: row.asin,
          sku: row.sku || undefined,
          quantity: Number(qty) || units,
          buyPrice: bp,
          datePurchased: date,
          notes: 'manual COGS entry (data-integrity)',
        }),
      });
      const j = await res.json();
      if (!res.ok || j.error) { setStatus('error'); setErr(j.error || 'Save failed'); return; }
      setStatus('saved');
      onSaved();
    } catch (e) {
      setStatus('error'); setErr(String(e));
    }
  };

  return (
    <tr className="border-t border-border-subtle/50">
      <td className="px-4 py-2 font-mono text-xs">
        {typeof row.asin === 'string' && row.asin.startsWith('B0')
          ? <a href={`https://www.amazon.com/dp/${row.asin}`} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{row.asin}</a>
          : (row.asin || '—')}
      </td>
      <td className="px-4 py-2 text-text-secondary text-xs max-w-[220px] truncate" title={String(row.productName || '')}>{row.productName || '—'}</td>
      <td className="px-4 py-2 text-right font-mono text-xs text-text-secondary">{formatNumber(units)}</td>
      <td className="px-4 py-2 text-right font-mono text-xs text-text-secondary">{formatCurrency(Number(row.revenueCents) || 0)}</td>
      <td className="px-4 py-2">
        <input
          type="number" step="0.01" min="0" inputMode="decimal" placeholder="0.00"
          value={buyPrice} onChange={(e) => { setBuyPrice(e.target.value); if (status !== 'idle') setStatus('idle'); }}
          className="w-20 px-2 h-8 text-xs font-mono border border-border-default rounded bg-bg-elevated text-text-primary"
        />
      </td>
      <td className="px-4 py-2">
        <input
          type="number" step="1" min="1"
          value={qty} onChange={(e) => setQty(e.target.value)}
          className="w-16 px-2 h-8 text-xs font-mono border border-border-default rounded bg-bg-elevated text-text-primary"
        />
      </td>
      <td className="px-4 py-2">
        <input
          type="date"
          value={date} onChange={(e) => setDate(e.target.value)}
          className="px-2 h-8 text-xs font-mono border border-border-default rounded bg-bg-elevated text-text-primary"
        />
      </td>
      <td className="px-4 py-2 whitespace-nowrap">
        {status === 'saved' ? (
          <span className="inline-flex items-center gap-1 text-xs text-positive"><ShieldCheck size={14} /> Saved</span>
        ) : (
          <button
            onClick={save} disabled={status === 'saving'}
            className="px-3 h-8 text-xs rounded bg-accent text-white hover:opacity-90 disabled:opacity-50"
          >
            {status === 'saving' ? 'Saving…' : 'Save lot'}
          </button>
        )}
        {status === 'error' && <span className="ml-2 text-xs text-negative">{err}</span>}
      </td>
    </tr>
  );
}

function prettyKey(k: string): string {
  if (k === 'revenueCents') return 'Revenue';
  return k.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

function renderCell(key: string, value: any): React.ReactNode {
  if (value == null) return '—';
  if (key.toLowerCase().endsWith('cents')) return formatCurrency(value as number);
  if (key === 'asin' && typeof value === 'string' && value.startsWith('B0')) {
    return <a href={`https://www.amazon.com/dp/${value}`} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{value}</a>;
  }
  if (typeof value === 'number') return formatNumber(value);
  return String(value);
}
