'use client';

import { useEffect, useState, useCallback } from 'react';
import { formatCurrency, formatDate, formatNumber } from '@/lib/formatters';
import { ExternalLink, RefreshCw, AlertCircle, Loader2, CheckCircle2, XCircle, Inbox, FileText, Copy, Check, X as XClose } from 'lucide-react';
import { buildClaimMessage, classifyClaim, FILING_INSTRUCTIONS } from '@/lib/amazon-claims/templates';
import CopyableText from '@/components/ui/CopyableText';

interface Candidate {
  id: number;
  adjustmentDate: string;
  asin: string | null;
  sku: string | null;
  fnsku: string | null;
  productName: string | null;
  fcId: string | null;
  reason: string;
  disposition: string | null;
  quantity: number;
  estimatedValueCents: number | null;
  eligibleUntil: string | null;
  status: 'pending' | 'matched' | 'filed' | 'received' | 'expired' | 'dismissed';
  matchedReimbursementId: number | null;
  filedAt: string | null;
  claimNotes: string | null;
}

interface Totals {
  pendingCount: number;
  pendingValueCents: number;
  urgentCount: number;
  filedCount: number;
  matchedCount: number;
  expiredCount: number;
}

const STATUS_TABS: Array<{ key: 'pending' | 'filed' | 'matched' | 'expired' | 'all'; label: string }> = [
  { key: 'pending', label: 'To File' },
  { key: 'filed', label: 'Filed' },
  { key: 'matched', label: 'Already Reimbursed' },
  { key: 'expired', label: 'Expired' },
  { key: 'all', label: 'All' },
];

export default function ClaimsToFilePage() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<'pending' | 'filed' | 'matched' | 'expired' | 'all'>('pending');
  const [openCandidate, setOpenCandidate] = useState<Candidate | null>(null);
  const [editedBody, setEditedBody] = useState('');
  const [copied, setCopied] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/reimbursement-candidates?status=${tab}`);
    const data = await res.json();
    setCandidates(data.candidates || []);
    setTotals(data.totals || null);
    setLastSync(data.lastSync || null);
    setLoading(false);
  }, [tab]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function runSync() {
    if (!confirm('Pull the latest 90 days of FBA inventory adjustments from Amazon? Takes 1-3 minutes.')) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/sync/reimbursement-candidates', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(`Sync failed: ${data.error}`);
      } else {
        alert(`Found ${data.newCandidates} new candidate(s), ${data.alreadyReimbursed} already reimbursed.`);
        await fetchData();
      }
    } catch (err) {
      alert(String(err));
    }
    setSyncing(false);
  }

  async function patchCandidate(id: number, action: 'file' | 'dismiss' | 'received' | 'reopen') {
    const res = await fetch('/api/data/reimbursement-candidates', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    const data = await res.json();
    if (data.error) {
      alert(`Update failed: ${data.error}`);
    } else {
      await fetchData();
    }
  }

  const filingUrl = 'https://sellercentral.amazon.com/help/hub/reference/external/G201990790';

  function openTemplate(c: Candidate) {
    const body = buildClaimMessage({
      asin: c.asin || '—',
      sku: c.sku || '—',
      fnsku: c.fnsku || '—',
      fcId: c.fcId || '—',
      productName: c.productName || c.asin || c.sku || 'item',
      adjustmentDate: formatDate(c.adjustmentDate),
      quantity: Math.abs(c.quantity),
      estimatedValue: c.estimatedValueCents ? formatCurrency(c.estimatedValueCents) : '$0.00',
      reason: c.reason,
      disposition: c.disposition || '',
    });
    setOpenCandidate(c);
    setEditedBody(body);
    setCopied(false);
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(editedBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      alert(`Copy failed: ${err}`);
    }
  }

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Claims to File</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            FBA inventory losses Amazon owes you for. Cross-checked against payouts you've already received.
            {lastSync && (
              <span className="ml-2 text-text-tertiary">· Last synced {formatDate(lastSync)}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={runSync}
            disabled={syncing}
            className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {syncing ? 'Syncing…' : 'Sync from Amazon'}
          </button>
        </div>
      </div>

      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-5 border-t-2 border-t-accent">
            <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">To File</div>
            <div className="text-2xl font-bold font-mono text-text-primary tracking-tight">{formatNumber(totals.pendingCount)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">{formatCurrency(totals.pendingValueCents)} estimated</div>
          </div>
          <div className={`bg-bg-surface border border-border-subtle rounded-lg p-5 border-t-2 ${totals.urgentCount > 0 ? 'border-t-negative' : 'border-t-border-default'}`}>
            <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">Closing Soon (≤14d)</div>
            <div className={`text-2xl font-bold font-mono tracking-tight ${totals.urgentCount > 0 ? 'text-negative' : 'text-text-primary'}`}>{formatNumber(totals.urgentCount)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">File before deadline</div>
          </div>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-5 border-t-2 border-t-border-default">
            <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">Already Filed</div>
            <div className="text-2xl font-bold font-mono text-text-primary tracking-tight">{formatNumber(totals.filedCount)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">Awaiting Amazon</div>
          </div>
          <div className={`bg-bg-surface border border-border-subtle rounded-lg p-5 border-t-2 ${totals.expiredCount > 0 ? 'border-t-negative' : 'border-t-border-default'}`}>
            <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">Expired</div>
            <div className={`text-2xl font-bold font-mono tracking-tight ${totals.expiredCount > 0 ? 'text-negative' : 'text-text-primary'}`}>{formatNumber(totals.expiredCount)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">Past 60-day window</div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 mb-4 border-b border-border-subtle">
        {STATUS_TABS.map((t) => (
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
          <span>{tab === 'pending' ? 'No pending claims. Nice.' : 'Nothing here.'}</span>
        </div>
      ) : (
        <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-[11px] uppercase tracking-wider text-text-tertiary">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Date</th>
                <th className="text-left px-4 py-2 font-medium">Product</th>
                <th className="text-left px-4 py-2 font-medium">Reason</th>
                <th className="text-right px-4 py-2 font-medium">Units</th>
                <th className="text-right px-4 py-2 font-medium">Est. Value</th>
                <th className="text-left px-4 py-2 font-medium">Eligible Until</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const days = c.eligibleUntil
                  ? Math.ceil((new Date(c.eligibleUntil).getTime() - Date.now()) / 86400000)
                  : null;
                const urgent = days !== null && days <= 14 && c.status === 'pending';
                return (
                  <tr
                    key={c.id}
                    className={`border-t border-border-subtle hover:bg-bg-elevated/50 ${c.status === 'pending' ? 'cursor-pointer' : ''}`}
                    onClick={() => { if (c.status === 'pending') openTemplate(c); }}
                  >
                    <td className="px-4 py-3 text-text-secondary font-mono text-xs">
                      {formatDate(c.adjustmentDate)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-text-primary truncate max-w-[400px]" title={c.productName || ''}>
                        {c.productName || c.asin || c.sku || c.fnsku}
                      </div>
                      <div className="text-[11px] text-text-tertiary flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
                        {c.asin && <CopyableText text={c.asin} title={`Click to copy ASIN: ${c.asin}`} />}
                        {c.fnsku && <span className="flex items-center gap-1.5">· <CopyableText text={c.fnsku} title={`Click to copy FNSKU: ${c.fnsku}`} /></span>}
                        {c.fcId && <span>· {c.fcId}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs">
                      <span className="font-mono">{c.reason}</span>
                      {c.disposition && (
                        <div className="text-[10px] text-text-tertiary">{c.disposition}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-text-primary">
                      {Math.abs(c.quantity)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-text-primary">
                      {c.estimatedValueCents ? formatCurrency(c.estimatedValueCents) : '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {c.eligibleUntil ? (
                        <span className={urgent ? 'text-negative font-semibold' : 'text-text-secondary'}>
                          {formatDate(c.eligibleUntil)}
                          {urgent && <div className="text-[10px]">{days}d left</div>}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {c.status === 'pending' && (
                          <>
                            <button
                              onClick={(e) => { e.stopPropagation(); openTemplate(c); }}
                              className="inline-flex items-center gap-1 px-2 h-7 text-[11px] bg-accent/10 border border-accent/30 rounded text-accent hover:bg-accent/20 transition-colors"
                              title="View claim details + filing template"
                            >
                              <FileText size={11} /> View
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); patchCandidate(c.id, 'file'); }}
                              className="px-2 h-7 text-[11px] bg-bg-elevated border border-border-default rounded text-text-secondary hover:text-text-primary transition-colors"
                              title="Mark as filed (skip template)"
                            >
                              <CheckCircle2 size={11} />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); patchCandidate(c.id, 'dismiss'); }}
                              className="px-2 h-7 text-[11px] bg-bg-elevated border border-border-default rounded text-text-tertiary hover:text-negative transition-colors"
                              title="Dismiss — won't show as a claim"
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
                              title="Mark as reimbursed by Amazon"
                            >
                              Received
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); patchCandidate(c.id, 'reopen'); }}
                              className="px-2 h-7 text-[11px] bg-bg-elevated border border-border-default rounded text-text-tertiary hover:text-text-primary transition-colors"
                              title="Reopen — move back to pending"
                            >
                              Reopen
                            </button>
                          </>
                        )}
                        {c.status === 'matched' && (
                          <span className="text-[10px] text-positive flex items-center gap-1">
                            <CheckCircle2 size={11} /> Already Paid
                          </span>
                        )}
                        {c.status === 'received' && (
                          <span className="text-[10px] text-positive">Received</span>
                        )}
                        {c.status === 'expired' && (
                          <span className="text-[10px] text-negative flex items-center gap-1">
                            <AlertCircle size={11} /> Expired
                          </span>
                        )}
                        {c.status === 'dismissed' && (
                          <span className="text-[10px] text-text-tertiary">Dismissed</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Claim details modal */}
      {openCandidate && (() => {
        const claim = classifyClaim(openCandidate.reason, openCandidate.disposition);
        return (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setOpenCandidate(null)}
          >
            <div
              className="bg-bg-surface border border-border-subtle rounded-lg max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="px-5 py-4 border-b border-border-subtle flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">{claim.category}</h2>
                  <p className="text-xs text-text-tertiary mt-0.5 truncate max-w-[500px]">
                    {openCandidate.productName || openCandidate.asin} · {Math.abs(openCandidate.quantity)} units · {openCandidate.estimatedValueCents ? formatCurrency(openCandidate.estimatedValueCents) : '$0'}
                  </p>
                </div>
                <button
                  onClick={() => setOpenCandidate(null)}
                  className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-elevated rounded transition-colors"
                  title="Close"
                >
                  <XClose size={16} />
                </button>
              </div>

              {/* Body */}
              <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
                {/* What is this */}
                <div className="bg-accent/5 border border-accent/20 rounded p-3 text-sm text-text-secondary">
                  <div className="font-medium text-text-primary mb-1">What this is</div>
                  {claim.explanation}
                </div>

                {/* How to file */}
                <div>
                  <label className="text-[11px] uppercase tracking-widest text-text-tertiary font-medium block mb-2">
                    How to file (4-5 minutes)
                  </label>
                  <ol className="space-y-1.5">
                    {FILING_INSTRUCTIONS.map((step, i) => (
                      <li key={i} className="text-xs text-text-secondary flex items-start gap-2">
                        <span className="text-accent font-mono font-medium mt-0.5">{i + 1}.</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                {/* Claim message */}
                <div>
                  <label className="text-[11px] uppercase tracking-widest text-text-tertiary font-medium block mb-2">
                    Claim message (paste into Amazon's case form)
                  </label>
                  <textarea
                    value={editedBody}
                    onChange={(e) => setEditedBody(e.target.value)}
                    className="w-full h-72 px-3 py-2 bg-bg-elevated border border-border-default rounded text-sm font-mono text-text-primary focus:outline-none focus:border-accent resize-y"
                  />
                </div>

                {/* Detail grid */}
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="text-text-tertiary uppercase tracking-widest text-[10px]">ASIN / FNSKU</div>
                    <div>{openCandidate.asin ? <CopyableText text={openCandidate.asin} className="text-text-primary" /> : <span className="font-mono text-text-tertiary">—</span>}</div>
                    <div>{openCandidate.fnsku ? <CopyableText text={openCandidate.fnsku} className="text-text-tertiary" /> : <span className="font-mono text-text-tertiary">—</span>}</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary uppercase tracking-widest text-[10px]">FC</div>
                    <div className="font-mono text-text-primary">{openCandidate.fcId || '—'}</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary uppercase tracking-widest text-[10px]">Adjustment Date</div>
                    <div className="font-mono text-text-primary">{formatDate(openCandidate.adjustmentDate)}</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary uppercase tracking-widest text-[10px]">Eligible Until</div>
                    <div className="font-mono text-text-primary">{openCandidate.eligibleUntil ? formatDate(openCandidate.eligibleUntil) : '—'}</div>
                  </div>
                </div>
              </div>

              {/* Footer actions */}
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
                      copied
                        ? 'bg-positive/10 border-positive/30 text-positive'
                        : 'bg-bg-elevated border-border-default text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? 'Copied' : 'Copy claim text'}
                  </button>
                  <a
                    href={filingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => {
                      if (openCandidate) patchCandidate(openCandidate.id, 'file');
                    }}
                    className="inline-flex items-center gap-1.5 px-3 h-8 text-xs bg-accent text-white rounded font-medium hover:bg-accent/90 transition-colors"
                  >
                    <ExternalLink size={12} /> Open Amazon & mark filed
                  </a>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
