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
              <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">Profit Overstated By ≥</div>
              <div className="text-2xl font-bold font-mono text-text-primary">{formatCurrency(data.summary.zeroCogsRevenueCents)}</div>
              <div className="text-xs text-text-tertiary mt-1 font-mono">
                revenue on {formatNumber(data.summary.zeroCogsUnits)} units with $0 cost
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
