'use client';

import { useMemo, useState } from 'react';
import { formatCurrency } from '@/lib/formatters';
import { X, Check, Send, Loader2, AlertTriangle } from 'lucide-react';

// ---------------------------------------------------------------------------
// Shared activation types — used by both /mfn/batch and /analyze/merchant-inventory
// to drive the activation preview/push modal.
// ---------------------------------------------------------------------------

export interface ActivationPreviewRow {
  sku: string;
  asin: string | null;
  product_name: string | null;
  current_qty: number | null;
  current_price_cents: number | null;
  current_status: string | null;
  proposed_qty: number;
  qty_source: 'received' | 'remaining' | 'none';
  proposed_price_cents: number | null;
  proposed_shipping_template: string;
  il_id: number | null;
  warnings: string[];
  can_push: boolean;
}

export interface PushResult {
  sku: string;
  asin: string | null;
  product_name: string | null;
  proposed_qty: number;
  proposed_price_cents: number | null;
  proposed_shipping_template: string;
  il_id: number | null;
  eligible: boolean;
  skipped_reason: string | null;
  sp_status: 'ACCEPTED' | 'INVALID' | 'VALID' | 'ERROR' | 'SKIPPED' | 'DRY_RUN';
  sp_submission_id: string | null;
  sp_issues: Array<{ code: string; message: string; severity: string }>;
  error_message: string | null;
  log_id: number | null;
}

interface ShippingTemplateOption {
  key: string;
  name: string;
}

type PushPhase = 'preview' | 'confirm' | 'testing' | 'test_done' | 'pushing' | 'done';

export interface PreviewModalProps {
  rows: ActivationPreviewRow[];
  shippingTemplate: string;
  shippingTemplates?: ShippingTemplateOption[];
  onClose: () => void;
  onPushComplete?: () => void;
  /**
   * Fires once a push run finishes with EVERY eligible row returning
   * ACCEPTED/VALID. Used by the batch flow to auto-close the batch → History.
   * Does not fire on partial pushes (skips/errors leave the batch open).
   */
  onAllEligibleAccepted?: (results: PushResult[]) => void;
}

function spStatusBadge(status: PushResult['sp_status']) {
  const map: Record<string, string> = {
    ACCEPTED: 'bg-green-500/10 text-green-400 border-green-500/30',
    VALID:    'bg-green-500/10 text-green-400 border-green-500/30',
    INVALID:  'bg-red-500/10 text-red-400 border-red-500/30',
    ERROR:    'bg-red-500/10 text-red-400 border-red-500/30',
    SKIPPED:  'bg-bg-elevated text-text-tertiary border-border-subtle',
    DRY_RUN:  'bg-bg-elevated text-text-tertiary border-border-subtle',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${map[status] ?? map.SKIPPED}`}>
      {status}
    </span>
  );
}

export function PreviewModal({ rows, shippingTemplate, shippingTemplates = [], onClose, onPushComplete, onAllEligibleAccepted }: PreviewModalProps) {
  const [pushPhase, setPushPhase]     = useState<PushPhase>('preview');
  const [testResult, setTestResult]   = useState<PushResult | null>(null);
  const [bulkResults, setBulkResults] = useState<PushResult[]>([]);
  const [pushError, setPushError]     = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState(
    shippingTemplate || rows.find((row) => row.proposed_shipping_template)?.proposed_shipping_template || ''
  );

  const pushableRows  = rows.filter(r => r.can_push);
  const pushableCount = pushableRows.length;
  const warningCount  = rows.filter(r => r.warnings.length > 0).length;

  const resultBySku = useMemo(() => {
    const m = new Map<string, PushResult>();
    if (testResult) m.set(testResult.sku, testResult);
    for (const r of bulkResults) m.set(r.sku, r);
    return m;
  }, [testResult, bulkResults]);

  async function runPush(skus: string[]): Promise<PushResult[]> {
    const res = await fetch('/api/data/merchant-inventory/activation-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skus, dryRun: false, shippingTemplate: selectedTemplate }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Push failed');
    return data.results as PushResult[];
  }

  // True when every push-eligible row came back ACCEPTED/VALID. Drives the
  // batch auto-close: partial pushes (any skip/error) deliberately return false
  // so the batch stays open with just the stragglers.
  function allEligibleAccepted(results: PushResult[]): boolean {
    if (pushableRows.length === 0) return false;
    const bySku = new Map(results.map(r => [r.sku, r]));
    return pushableRows.every(r => {
      const res = bySku.get(r.sku);
      return !!res && (res.sp_status === 'ACCEPTED' || res.sp_status === 'VALID');
    });
  }

  // Single completion point: fire onPushComplete, and onAllEligibleAccepted when
  // the whole eligible set was accepted.
  function finishPush(allResults: PushResult[]) {
    onPushComplete?.();
    if (allEligibleAccepted(allResults)) onAllEligibleAccepted?.(allResults);
  }

  async function handleTestPush() {
    const testSku = pushableRows[0];
    if (!testSku) return;
    setPushPhase('testing');
    setPushError(null);
    try {
      const results = await runPush([testSku.sku]);
      setTestResult(results[0] ?? null);
      setPushPhase('test_done');
    } catch (e) {
      setPushError(String(e));
      setPushPhase('preview');
    }
  }

  async function handleBulkPush() {
    const remaining = pushableRows.slice(testResult ? 1 : 0).map(r => r.sku);
    if (remaining.length === 0) {
      finishPush([testResult].filter(Boolean) as PushResult[]);
      setPushPhase('done');
      return;
    }
    setPushPhase('pushing');
    setPushError(null);
    try {
      const results = await runPush(remaining);
      setBulkResults(results);
      finishPush([testResult, ...results].filter(Boolean) as PushResult[]);
      setPushPhase('done');
    } catch (e) {
      setPushError(String(e));
      setPushPhase('test_done');
    }
  }

  const remainingCount = pushableRows.slice(testResult ? 1 : 0).length;
  const isBusy = pushPhase === 'testing' || pushPhase === 'pushing';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={isBusy ? undefined : onClose}>
      <div
        className="bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-[960px] max-h-[88vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              {pushPhase === 'done' ? 'Push Complete' : 'Activation Preview'}
            </h2>
            <p className="text-[11px] text-text-tertiary mt-0.5">
              {pushPhase === 'preview' || pushPhase === 'confirm'
                ? <>Dry run — no Amazon writes made. <span className="text-green-400 font-medium">{pushableCount}</span> of {rows.length} rows ready to push.</>
                : pushPhase === 'testing'
                  ? 'Sending test SKU to Amazon…'
                  : pushPhase === 'test_done'
                    ? `Test result: ${testResult?.sp_status ?? '—'}. ${remainingCount > 0 ? `${remainingCount} remaining.` : 'All SKUs tested.'}`
                    : pushPhase === 'pushing'
                      ? `Pushing ${remainingCount} SKUs to Amazon…`
                      : `Pushed ${[testResult, ...bulkResults].filter(Boolean).length} SKUs.`
              }
            </p>
          </div>
          <button onClick={isBusy ? undefined : onClose} disabled={isBusy} className="p-1 rounded hover:bg-bg-hover text-text-tertiary disabled:opacity-40">
            <X size={16} />
          </button>
        </div>

        {/* Summary bar */}
        <div className="px-5 py-2 bg-bg-elevated border-b border-border-subtle shrink-0 flex items-center gap-4 text-xs">
          <span className="text-green-400 font-medium">{pushableCount} push eligible</span>
          <span className="text-text-tertiary">{rows.length - pushableCount} not eligible</span>
          {warningCount > 0 && <span className="text-amber-400">{warningCount} with warnings</span>}
          <label className="ml-auto flex items-center gap-2 text-text-tertiary">
            <span>Template</span>
            {shippingTemplates.length > 0 ? (
              <select
                value={shippingTemplates.find((template) => template.name === selectedTemplate || template.key === selectedTemplate)?.name ?? selectedTemplate}
                onChange={(event) => setSelectedTemplate(event.target.value)}
                disabled={isBusy}
                className="h-7 max-w-[260px] rounded-md border border-border-subtle bg-bg-surface px-2 text-[11px] text-text-primary disabled:opacity-50"
              >
                {selectedTemplate && !shippingTemplates.some((template) => template.name === selectedTemplate || template.key === selectedTemplate) && (
                  <option value={selectedTemplate}>{selectedTemplate} (not synced)</option>
                )}
                {shippingTemplates.map((template) => (
                  <option key={template.key} value={template.name}>{template.name}</option>
                ))}
              </select>
            ) : (
              <span className="font-mono truncate max-w-[300px]">{selectedTemplate || '(none synced)'}</span>
            )}
          </label>
        </div>

        {/* Shipping-template scope banner — appears in preview phase only */}
        {(pushPhase === 'preview' || pushPhase === 'confirm') && (
          <div className="px-5 py-2 bg-green-500/5 border-b border-green-500/20 shrink-0 flex items-start gap-2 text-[11px] text-green-400/90">
            <Check size={12} className="shrink-0 mt-0.5" />
            <span>
              <span className="font-medium">Shipping template will be included.</span>{' '}
              Eligible SKUs will push quantity, price, and merchant_shipping_group.
            </span>
          </div>
        )}

        {/* Confirm overlay */}
        {pushPhase === 'confirm' && (
          <div className="px-5 py-4 bg-amber-500/5 border-b border-amber-500/20 shrink-0">
            <div className="flex items-start gap-3">
              <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary">This will write to Amazon Seller Central</p>
                <p className="text-[11px] text-text-tertiary mt-1">
                  A test push will update quantity and price for{' '}
                  <span className="font-medium text-text-secondary">{pushableRows[0]?.product_name || pushableRows[0]?.sku}</span>{' '}
                  on one live listing. If the test passes, you can push the remaining {pushableCount - 1} SKUs.
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => setPushPhase('preview')}
                  className="h-8 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover"
                >
                  Cancel
                </button>
                <button
                  onClick={handleTestPush}
                  className="h-8 px-3 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90"
                >
                  Test 1 SKU
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error banner */}
        {pushError && (
          <div className="px-5 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-400 shrink-0">
            {pushError}
          </div>
        )}

        {/* Preview table */}
        <div className="overflow-auto flex-1">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-bg-elevated z-10">
              <tr className="border-b border-border-subtle">
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary">Product / SKU</th>
                <th className="px-4 py-2.5 text-center text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Amz Status</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-16">Cur. Qty</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-16">Prop. Qty</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Cur. Price</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-24">Prop. Price</th>
                <th className="px-4 py-2.5 text-center text-[11px] font-medium tracking-widest uppercase text-text-tertiary w-28">
                  {pushPhase === 'preview' || pushPhase === 'confirm' ? 'Eligible' : 'Push Status'}
                </th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary">
                  {pushPhase === 'preview' || pushPhase === 'confirm' ? 'Notes' : 'Details'}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const pushed = resultBySku.get(row.sku);
                const visibleWarnings = row.warnings.filter((warning) =>
                  !warning.startsWith('Will push Amazon shipping template:')
                );
                const templateToPush = selectedTemplate || row.proposed_shipping_template;
                return (
                  <tr
                    key={row.sku}
                    className={`border-b border-border-subtle/50 transition-colors ${
                      pushed?.sp_status === 'ACCEPTED' || pushed?.sp_status === 'VALID'
                        ? 'bg-green-500/5'
                        : pushed?.sp_status === 'INVALID' || pushed?.sp_status === 'ERROR'
                          ? 'bg-red-500/5'
                          : row.can_push ? 'hover:bg-bg-hover' : 'opacity-60'
                    }`}
                  >
                    <td className="px-4 py-2.5 max-w-[200px]">
                      <div className="text-text-primary font-medium truncate" title={row.product_name || row.sku}>
                        {row.product_name || row.asin || row.sku}
                      </div>
                      <div className="font-mono text-text-tertiary text-[10px] truncate mt-0.5">{row.sku}</div>
                      {row.asin && <div className="font-mono text-text-tertiary/60 text-[10px]">{row.asin}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {row.current_status ? (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                          row.current_status === 'Active'
                            ? 'bg-green-500/10 text-green-400 border-green-500/30'
                            : 'bg-red-500/10 text-red-400 border-red-500/30'
                        }`}>{row.current_status}</span>
                      ) : (
                        <span className="text-text-tertiary text-[10px]">Not listed</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {row.current_qty != null ? row.current_qty : <span className="text-text-tertiary">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      <span className={row.proposed_qty > 0 ? 'text-text-primary font-medium' : 'text-amber-400'}>
                        {row.proposed_qty}
                      </span>
                      {row.qty_source === 'remaining' && <span className="block text-[9px] text-amber-400/70 mt-0.5">ledger fallback</span>}
                      {row.qty_source === 'received'  && <span className="block text-[9px] text-green-400/60 mt-0.5">received</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {row.current_price_cents != null ? formatCurrency(row.current_price_cents) : <span className="text-text-tertiary">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {row.proposed_price_cents != null
                        ? <span className="text-text-primary font-medium">{formatCurrency(row.proposed_price_cents)}</span>
                        : <span className="text-amber-400">No price</span>}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {pushed
                        ? spStatusBadge(pushed.sp_status)
                        : row.can_push
                          ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-green-500/10 text-green-400 border-green-500/30"><Check size={9} />Eligible</span>
                          : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-bg-elevated text-text-tertiary border-border-subtle"><X size={9} />Not eligible</span>
                      }
                    </td>
                    <td className="px-4 py-2.5">
                      {pushed
                        ? pushed.error_message
                          ? <span className="text-red-400 text-[10px]">{pushed.error_message}</span>
                          : pushed.sp_issues.length > 0
                            ? <div className="space-y-0.5">{pushed.sp_issues.slice(0, 2).map((iss, i) => <div key={i} className="text-amber-400 text-[10px]">{iss.code}: {iss.message}</div>)}</div>
                            : pushed.sp_submission_id
                              ? <span className="text-green-400/70 text-[10px] font-mono">ID: {pushed.sp_submission_id.slice(0, 12)}…</span>
                              : <span className="text-green-400 text-[10px]">Submitted</span>
                        : (
                          <div className="space-y-0.5">
                            {row.can_push && templateToPush && (
                              <div className="text-green-400 text-[10px] leading-tight">Will push template: {templateToPush}</div>
                            )}
                            {visibleWarnings.map((w, i) => (
                              <div key={i} className="text-amber-400 text-[10px] leading-tight">{w}</div>
                            ))}
                            {visibleWarnings.length === 0 && (!row.can_push || !templateToPush) && (
                              <span className="text-green-400 text-[10px]">All checks pass</span>
                            )}
                          </div>
                        )
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border-subtle shrink-0 flex items-center justify-between gap-3">
          <p className="text-[11px] text-text-tertiary">
            {pushPhase === 'preview'
              ? 'Review the rows above, then push eligible SKUs to Amazon.'
              : pushPhase === 'done'
                ? 'Push complete. Sync merchant listings to see updated quantities and prices on Amazon.'
                : null}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            {(pushPhase === 'preview' || pushPhase === 'confirm') && (
              <button onClick={onClose} className="h-8 px-4 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover">
                Close
              </button>
            )}

            {pushPhase === 'preview' && pushableCount > 0 && (
              <button
                onClick={() => setPushPhase('confirm')}
                className="flex items-center gap-1.5 h-8 px-4 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90"
              >
                <Send size={12} />
                Push {pushableCount} to Amazon
              </button>
            )}

            {(pushPhase === 'testing' || pushPhase === 'pushing') && (
              <div className="flex items-center gap-2 text-xs text-text-tertiary">
                <Loader2 size={13} className="animate-spin" />
                {pushPhase === 'testing' ? 'Testing…' : 'Pushing…'}
              </div>
            )}

            {pushPhase === 'test_done' && (
              <>
                <button onClick={onClose} className="h-8 px-4 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover">
                  Stop here
                </button>
                {remainingCount > 0 && (
                  <button
                    onClick={handleBulkPush}
                    className="flex items-center gap-1.5 h-8 px-4 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90"
                  >
                    <Send size={12} />
                    Push remaining {remainingCount}
                  </button>
                )}
                {remainingCount === 0 && (
                  <button onClick={() => { finishPush([testResult].filter(Boolean) as PushResult[]); onClose(); }} className="h-8 px-4 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90">
                    Done
                  </button>
                )}
              </>
            )}

            {pushPhase === 'done' && (
              <button
                onClick={() => { onPushComplete?.(); onClose(); }}
                className="h-8 px-4 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90"
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
