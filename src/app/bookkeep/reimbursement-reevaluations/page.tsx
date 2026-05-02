'use client';

import { useEffect, useState, useCallback } from 'react';
import { formatCurrency, formatDate, formatNumber } from '@/lib/formatters';
import { ExternalLink, RefreshCw, Loader2, CheckCircle2, XCircle, Inbox, Copy, Check, X as XClose, AlertTriangle } from 'lucide-react';
import CopyableText from '@/components/ui/CopyableText';

interface Candidate {
  id: number;
  reimbursementId: string;
  reimbursementDate: string;
  asin: string | null;
  sku: string | null;
  productName: string | null;
  quantity: number;
  paidCents: number;
  expectedCents: number;
  gapCents: number;
  reason: string | null;
  status: 'pending' | 'filed' | 'received' | 'dismissed';
  filedAt: string | null;
}

interface Totals {
  pendingCount: number;
  pendingGapCents: number;
  filedCount: number;
  filedGapCents: number;
  recoveredGapCents: number;
}

const TABS: Array<{ key: 'pending' | 'filed' | 'received' | 'dismissed' | 'all'; label: string }> = [
  { key: 'pending', label: 'To Re-Evaluate' },
  { key: 'filed', label: 'Filed' },
  { key: 'received', label: 'Received' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'all', label: 'All' },
];

const filingUrl = 'https://sellercentral.amazon.com/cu/contact-us';

export default function ReimbursementReevaluationsPage() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<'pending' | 'filed' | 'received' | 'dismissed' | 'all'>('pending');
  const [openCandidate, setOpenCandidate] = useState<Candidate | null>(null);
  const [editedBody, setEditedBody] = useState('');
  const [copied, setCopied] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/amazon-reevaluations?status=${tab}`);
    const data = await res.json();
    setCandidates(data.candidates || []);
    setTotals(data.totals || null);
    setLastSync(data.lastSync || null);
    setLoading(false);
  }, [tab]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function runSync() {
    setSyncing(true);
    try {
      const res = await fetch('/api/sync/amazon-reevaluations', { method: 'POST' });
      const data = await res.json();
      if (data.error) alert(`Sync failed: ${data.error}`);
      else await fetchData();
    } catch (err) { alert(String(err)); }
    setSyncing(false);
  }

  async function patchCandidate(id: number, action: 'file' | 'dismiss' | 'received' | 'reopen') {
    const res = await fetch('/api/data/amazon-reevaluations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    const data = await res.json();
    if (data.error) alert(`Update failed: ${data.error}`);
    else await fetchData();
  }

  function buildClaimMessage(c: Candidate): string {
    return `Hi Amazon FBA team,

I'm requesting re-evaluation of reimbursement ${c.reimbursementId} (${formatDate(c.reimbursementDate)}, item: ${c.productName || c.asin || 'item'}, ASIN: ${c.asin || '—'}).

Reimbursement details:
  Reimbursement ID: ${c.reimbursementId}
  Quantity: ${c.quantity}
  Amount paid: ${formatCurrency(c.paidCents)}
  Expected (based on my 18-month average sale price): ${formatCurrency(c.expectedCents)}
  Gap: ${formatCurrency(c.gapCents)}

Per Amazon's FBA Inventory Reimbursement Policy, reimbursement should be at the lower of (a) my average net retail sales price over the past 18 months, or (b) Amazon's market evaluation. The amount paid is significantly below my historical sale price for this item.

Please re-evaluate this reimbursement and adjust the amount accordingly.

Thank you,`;
  }

  function openTemplate(c: Candidate) {
    setOpenCandidate(c);
    setEditedBody(buildClaimMessage(c));
    setCopied(false);
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(editedBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) { alert(`Copy failed: ${err}`); }
  }

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reimbursement Re-Evaluations</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Reimbursements where Amazon paid less than your 18-month average sale price. File via Help → Get Support → "Submit a reimbursement claim dispute".
            {lastSync && (
              <span className="ml-2 text-text-tertiary">· Last synced {formatDate(lastSync)}</span>
            )}
          </p>
        </div>
        <button
          onClick={runSync}
          disabled={syncing}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {syncing ? 'Syncing…' : 'Refresh'}
        </button>
      </div>

      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-5 border-t-2 border-t-accent">
            <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">To Re-Evaluate</div>
            <div className="text-2xl font-bold font-mono text-text-primary tracking-tight">{formatNumber(totals.pendingCount)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">{formatCurrency(totals.pendingGapCents)} potential additional recovery</div>
          </div>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-5 border-t-2 border-t-border-default">
            <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">Filed</div>
            <div className="text-2xl font-bold font-mono text-text-primary tracking-tight">{formatNumber(totals.filedCount)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">{formatCurrency(totals.filedGapCents)} pending Amazon</div>
          </div>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-5 border-t-2 border-t-positive">
            <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">Recovered</div>
            <div className="text-2xl font-bold font-mono text-text-primary tracking-tight">{formatCurrency(totals.recoveredGapCents)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">From won re-evaluations</div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 mb-4 border-b border-border-subtle">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 h-9 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-text-tertiary py-12 text-center">Loading…</div>
      ) : candidates.length === 0 ? (
        <div className="text-text-tertiary py-12 text-center flex flex-col items-center gap-2">
          <Inbox size={32} className="text-text-tertiary/50" />
          <span>{tab === 'pending' ? 'No re-evaluations pending. Click Refresh to scan.' : 'Nothing here.'}</span>
        </div>
      ) : (
        <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-[11px] uppercase tracking-wider text-text-tertiary">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Date</th>
                <th className="text-left px-4 py-2 font-medium">Reimbursement ID</th>
                <th className="text-left px-4 py-2 font-medium">Product</th>
                <th className="text-right px-4 py-2 font-medium">Qty</th>
                <th className="text-right px-4 py-2 font-medium">Paid</th>
                <th className="text-right px-4 py-2 font-medium">Expected</th>
                <th className="text-right px-4 py-2 font-medium">Gap</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr
                  key={c.id}
                  className={`border-t border-border-subtle hover:bg-bg-elevated/50 ${c.status === 'pending' ? 'cursor-pointer' : ''}`}
                  onClick={() => { if (c.status === 'pending') openTemplate(c); }}
                >
                  <td className="px-4 py-3 text-text-secondary font-mono text-xs">{formatDate(c.reimbursementDate)}</td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <CopyableText text={c.reimbursementId} variant="chip" title="Click to copy" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-text-primary truncate max-w-[300px]" title={c.productName || ''}>
                      {c.productName || c.asin || c.sku}
                    </div>
                    <div className="text-[11px] text-text-tertiary font-mono">
                      {c.asin && c.asin} {c.reason && `· ${c.reason}`}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-text-primary">{c.quantity}</td>
                  <td className="px-4 py-3 text-right font-mono text-text-secondary">{formatCurrency(c.paidCents)}</td>
                  <td className="px-4 py-3 text-right font-mono text-text-secondary">{formatCurrency(c.expectedCents)}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-positive">+{formatCurrency(c.gapCents)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {c.status === 'pending' && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); openTemplate(c); }}
                            className="inline-flex items-center gap-1 px-2 h-7 text-[11px] bg-accent/10 border border-accent/30 rounded text-accent hover:bg-accent/20 transition-colors"
                          >
                            View
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); patchCandidate(c.id, 'file'); }}
                            className="px-2 h-7 text-[11px] bg-bg-elevated border border-border-default rounded text-text-secondary hover:text-text-primary transition-colors"
                            title="Mark as filed"
                          >
                            <CheckCircle2 size={11} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); patchCandidate(c.id, 'dismiss'); }}
                            className="px-2 h-7 text-[11px] bg-bg-elevated border border-border-default rounded text-text-tertiary hover:text-negative transition-colors"
                            title="Dismiss"
                          >
                            <XCircle size={11} />
                          </button>
                        </>
                      )}
                      {c.status === 'filed' && (
                        <>
                          <span className="text-[10px] text-accent">Filed {c.filedAt ? formatDate(c.filedAt) : ''}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); patchCandidate(c.id, 'received'); }}
                            className="px-2 h-7 text-[11px] bg-positive/10 border border-positive/30 rounded text-positive hover:bg-positive/20 transition-colors"
                          >
                            Won
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); patchCandidate(c.id, 'reopen'); }}
                            className="px-2 h-7 text-[11px] bg-bg-elevated border border-border-default rounded text-text-tertiary hover:text-text-primary transition-colors"
                          >
                            Reopen
                          </button>
                        </>
                      )}
                      {c.status === 'received' && <span className="text-[10px] text-positive flex items-center gap-1"><CheckCircle2 size={11} /> Won</span>}
                      {c.status === 'dismissed' && <span className="text-[10px] text-text-tertiary">Dismissed</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {openCandidate && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setOpenCandidate(null)}
        >
          <div
            className="bg-bg-surface border border-border-subtle rounded-lg max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-border-subtle flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Reimbursement Re-Evaluation Request</h2>
                <p className="text-xs text-text-tertiary mt-0.5 flex items-center gap-1.5 max-w-[500px]">
                  <span>Reimbursement</span>
                  <CopyableText text={openCandidate.reimbursementId} variant="chip" title="Click to copy" />
                  <span className="truncate">· {openCandidate.productName || openCandidate.asin}</span>
                </p>
              </div>
              <button
                onClick={() => setOpenCandidate(null)}
                className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-elevated rounded transition-colors"
              >
                <XClose size={16} />
              </button>
            </div>

            <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
              {/* Gap callout */}
              <div className="bg-positive/5 border border-positive/20 rounded p-3 flex items-start gap-3">
                <AlertTriangle size={16} className="text-positive mt-0.5 flex-shrink-0" />
                <div className="flex-1 text-sm">
                  <div className="font-medium text-text-primary mb-1">
                    Amazon underpaid by {formatCurrency(openCandidate.gapCents)}
                  </div>
                  <div className="text-text-secondary text-xs">
                    Paid {formatCurrency(openCandidate.paidCents)} for {openCandidate.quantity} unit{openCandidate.quantity === 1 ? '' : 's'}.
                    Expected {formatCurrency(openCandidate.expectedCents)} based on your 18-month average sale price.
                  </div>
                </div>
              </div>

              <div>
                <label className="text-[11px] uppercase tracking-widest text-text-tertiary font-medium block mb-2">
                  Re-evaluation request (paste into the case description)
                </label>
                <textarea
                  value={editedBody}
                  onChange={(e) => setEditedBody(e.target.value)}
                  className="w-full h-72 px-3 py-2 bg-bg-elevated border border-border-default rounded text-sm font-mono text-text-primary focus:outline-none focus:border-accent resize-y"
                />
              </div>

              <div className="bg-accent/5 border border-accent/20 rounded p-3 text-xs text-text-secondary">
                <div className="font-medium text-text-primary mb-1.5">How to file</div>
                <ol className="space-y-1">
                  <li className="flex gap-2"><span className="text-accent font-mono">1.</span><span>Click <strong>"Open Get Support & mark filed"</strong> below.</span></li>
                  <li className="flex gap-2"><span className="text-accent font-mono">2.</span><span>Choose <strong>Selling on Amazon</strong> → <strong>Fulfillment by Amazon</strong>.</span></li>
                  <li className="flex gap-2"><span className="text-accent font-mono">3.</span><span>Click <strong>"Submit a reimbursement claim dispute"</strong>.</span></li>
                  <li className="flex gap-2"><span className="text-accent font-mono">4.</span><span>Enter the Reimbursement ID: <code className="font-mono bg-bg-elevated px-1 rounded">{openCandidate.reimbursementId}</code></span></li>
                  <li className="flex gap-2"><span className="text-accent font-mono">5.</span><span>Upload an invoice (optional but helps — supplier receipt or sourcing email).</span></li>
                  <li className="flex gap-2"><span className="text-accent font-mono">6.</span><span>Paste the request above as the case description. Submit.</span></li>
                </ol>
              </div>
            </div>

            <div className="px-5 py-3 border-t border-border-subtle flex items-center justify-between bg-bg-elevated/30">
              <button
                onClick={() => {
                  if (openCandidate) {
                    patchCandidate(openCandidate.id, 'dismiss');
                    setOpenCandidate(null);
                  }
                }}
                className="px-3 h-8 text-xs text-text-tertiary hover:text-negative transition-colors"
              >
                Dismiss
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={copyToClipboard}
                  className={`flex items-center gap-1.5 px-3 h-8 text-xs rounded border transition-colors ${
                    copied ? 'bg-positive/10 border-positive/30 text-positive' : 'bg-bg-elevated border-border-default text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? 'Copied' : 'Copy text'}
                </button>
                <a
                  href={filingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => { if (openCandidate) patchCandidate(openCandidate.id, 'file'); }}
                  className="inline-flex items-center gap-1.5 px-3 h-8 text-xs bg-accent text-white rounded font-medium hover:bg-accent/90 transition-colors"
                >
                  <ExternalLink size={12} /> Open Get Support & mark filed
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
