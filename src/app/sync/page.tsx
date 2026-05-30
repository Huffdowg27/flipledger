'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Play, AlertTriangle, CheckCircle2, Clock, Loader2 } from 'lucide-react';

// Sync status surface. Read-only view of every tracked sync job: last success,
// last attempt, next eligible run, in-flight state. "Run now" buttons hit the
// existing per-job routes (they keep their own in-flight protection so this
// can't re-introduce overlap).

type Staleness = 'fresh' | 'due' | 'overdue' | 'never';

interface JobStatusRow {
  key: string;
  label: string;
  description: string;
  family: string;
  intervalHours: number;
  runRoute: string;
  method: string;
  body?: Record<string, unknown>;
  note?: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  nextEligibleAt: string | null;
  staleness: Staleness;
  inFlight: boolean;
}

interface LiveSyncStage {
  syncType: string;
  recordsFetched: number;
  errors: string[];
  duration: number;
}

interface LiveSyncStatus {
  running: boolean;
  results: LiveSyncStage[];
  totalErrors: string[];
  startedAt: string;
  completedAt?: string;
}

interface StatusResponse {
  asOf: string;
  jobs: JobStatusRow[];
  live: {
    amazon: LiveSyncStatus | null;
    walmart: LiveSyncStatus | null;
    ebay: LiveSyncStatus | null;
  };
  inFlightKeys: string[];
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) {
    const futureSec = Math.abs(ms) / 1000;
    if (futureSec < 60) return `in ${Math.round(futureSec)}s`;
    if (futureSec < 3600) return `in ${Math.round(futureSec / 60)}m`;
    if (futureSec < 86400) return `in ${Math.round(futureSec / 3600)}h`;
    return `in ${Math.round(futureSec / 86400)}d`;
  }
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function staleColor(s: Staleness): string {
  switch (s) {
    case 'fresh': return 'text-green-500';
    case 'due': return 'text-amber-500';
    case 'overdue': return 'text-red-500';
    case 'never': return 'text-text-tertiary';
  }
}

function staleLabel(s: Staleness): string {
  switch (s) {
    case 'fresh': return 'Fresh';
    case 'due': return 'Due';
    case 'overdue': return 'Overdue';
    case 'never': return 'Never run';
  }
}

function familyBadge(f: string): string {
  switch (f) {
    case 'amazon': return 'bg-orange-500/15 text-orange-500';
    case 'walmart': return 'bg-blue-500/15 text-blue-500';
    case 'ebay': return 'bg-red-500/15 text-red-500';
    default: return 'bg-text-tertiary/15 text-text-tertiary';
  }
}

export default function SyncStatusPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [runMessage, setRunMessage] = useState<{ key: string; text: string; ok: boolean } | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/sync/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: StatusResponse = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatus]);

  async function handleRunNow(job: JobStatusRow) {
    setRunning(prev => new Set(prev).add(job.key));
    setRunMessage(null);
    try {
      const res = await fetch(job.runRoute, {
        method: job.method,
        headers: { 'Content-Type': 'application/json' },
        body: job.body ? JSON.stringify(job.body) : JSON.stringify({}),
      });
      const ok = res.ok;
      let text = `${res.status}`;
      try {
        const body = await res.json();
        text = body.error || body.message || body.status || JSON.stringify(body).slice(0, 200);
      } catch {}
      setRunMessage({ key: job.key, text, ok });
      // Refresh status soon to pick up the new attempted_at write.
      fetchStatus();
      setTimeout(fetchStatus, 2000);
    } catch (e) {
      setRunMessage({ key: job.key, text: String(e), ok: false });
    } finally {
      setRunning(prev => {
        const next = new Set(prev);
        next.delete(job.key);
        return next;
      });
    }
  }

  const overdueCount = useMemo(
    () => data?.jobs.filter(j => j.staleness === 'overdue').length || 0,
    [data],
  );
  const inFlightCount = data?.inFlightKeys.length || 0;
  const liveAmazon = data?.live.amazon;
  const liveWalmart = data?.live.walmart;
  const liveEbay = data?.live.ebay;
  const anyLive = !!(liveAmazon?.running || liveWalmart?.running || liveEbay?.running);

  return (
    <div className="max-w-6xl">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sync</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Every background sync job, when it last ran, when it&apos;s next eligible, and whether
            anything is in flight right now. Polls every 5s.
          </p>
        </div>
        <button
          onClick={fetchStatus}
          className="px-3 py-1.5 text-sm rounded border border-border-subtle text-text-secondary hover:bg-bg-surface flex items-center gap-2"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 border border-red-500/30 rounded bg-red-500/5 text-sm text-red-500 flex items-center gap-2">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {/* Summary tiles */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="p-3 border border-border-subtle rounded bg-bg-surface">
          <div className="text-xs uppercase tracking-wide text-text-tertiary">Jobs tracked</div>
          <div className="text-2xl font-semibold mt-1">{data?.jobs.length ?? '—'}</div>
        </div>
        <div className="p-3 border border-border-subtle rounded bg-bg-surface">
          <div className="text-xs uppercase tracking-wide text-text-tertiary">Overdue</div>
          <div className={`text-2xl font-semibold mt-1 ${overdueCount > 0 ? 'text-red-500' : 'text-green-500'}`}>
            {overdueCount}
          </div>
        </div>
        <div className="p-3 border border-border-subtle rounded bg-bg-surface">
          <div className="text-xs uppercase tracking-wide text-text-tertiary">In flight</div>
          <div className={`text-2xl font-semibold mt-1 flex items-center gap-2 ${(inFlightCount > 0 || anyLive) ? 'text-amber-500' : ''}`}>
            {inFlightCount + (anyLive ? 1 : 0)}
            {(anyLive || inFlightCount > 0) && <Loader2 size={18} className="animate-spin" />}
          </div>
        </div>
      </div>

      {/* Live full-sync stages, if running */}
      {anyLive && (
        <div className="mb-4 border border-amber-500/30 rounded bg-amber-500/5">
          <div className="px-3 py-2 border-b border-amber-500/20 text-xs uppercase tracking-wide text-amber-500 font-medium">
            Active full sync
          </div>
          <div className="p-3 space-y-2 text-sm">
            {liveAmazon?.running && (
              <LiveStageList family="Amazon" status={liveAmazon} />
            )}
            {liveWalmart?.running && (
              <LiveStageList family="Walmart" status={liveWalmart} />
            )}
            {liveEbay?.running && (
              <LiveStageList family="eBay" status={liveEbay} />
            )}
          </div>
        </div>
      )}

      {/* Run-now feedback */}
      {runMessage && (
        <div
          className={`mb-3 p-2 text-sm rounded border ${
            runMessage.ok
              ? 'border-green-500/30 bg-green-500/5 text-green-500'
              : 'border-red-500/30 bg-red-500/5 text-red-500'
          }`}
        >
          {runMessage.ok ? <CheckCircle2 size={14} className="inline mr-1" /> : <AlertTriangle size={14} className="inline mr-1" />}
          <span className="font-mono text-xs">{runMessage.key}</span>: {runMessage.text}
        </div>
      )}

      {/* Job table */}
      <div className="border border-border-subtle rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-surface">
            <tr className="text-left text-text-tertiary text-xs uppercase tracking-wide">
              <th className="px-3 py-2 font-medium">Job</th>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">Cadence</th>
              <th className="px-3 py-2 font-medium">Last success</th>
              <th className="px-3 py-2 font-medium">Last attempt</th>
              <th className="px-3 py-2 font-medium">Next eligible</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {data?.jobs.map(job => (
              <tr key={job.key} className="border-t border-border-subtle align-top">
                <td className="px-3 py-2">
                  <div className="font-medium">{job.label}</div>
                  <div className="text-xs text-text-tertiary mt-0.5">{job.description}</div>
                  <div className="text-xs text-text-tertiary mt-0.5 font-mono">{job.key}</div>
                  {job.note && (
                    <div className="text-xs text-text-tertiary mt-0.5 italic">{job.note}</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${familyBadge(job.family)}`}>
                    {job.family}
                  </span>
                </td>
                <td className="px-3 py-2 text-text-secondary">
                  every {job.intervalHours < 24 ? `${job.intervalHours}h` : job.intervalHours === 24 ? 'day' : `${job.intervalHours / 24}d`}
                </td>
                <td className="px-3 py-2 text-text-secondary" title={job.lastSuccessAt || ''}>
                  {formatRelative(job.lastSuccessAt)}
                </td>
                <td className="px-3 py-2 text-text-secondary" title={job.lastAttemptAt || ''}>
                  {formatRelative(job.lastAttemptAt)}
                </td>
                <td className="px-3 py-2 text-text-secondary" title={job.nextEligibleAt || ''}>
                  {formatRelative(job.nextEligibleAt)}
                </td>
                <td className="px-3 py-2">
                  <span className={`text-xs font-medium ${staleColor(job.staleness)} inline-flex items-center gap-1`}>
                    {job.inFlight && <Loader2 size={12} className="animate-spin text-amber-500" />}
                    {job.inFlight ? 'In flight' : staleLabel(job.staleness)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => handleRunNow(job)}
                    disabled={job.inFlight || running.has(job.key)}
                    className="px-2 py-1 text-xs rounded border border-border-subtle hover:bg-bg-surface disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
                  >
                    {running.has(job.key) ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Play size={12} />
                    )}
                    Run now
                  </button>
                </td>
              </tr>
            ))}
            {!data && !error && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-text-tertiary">
                  <Clock size={16} className="inline animate-spin mr-2" />
                  Loading status...
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data?.asOf && (
        <div className="mt-3 text-xs text-text-tertiary text-right">
          Snapshot as of {formatRelative(data.asOf)} · auto-refresh every 5s
        </div>
      )}
    </div>
  );
}

function LiveStageList({ family, status }: { family: string; status: LiveSyncStatus }) {
  return (
    <div>
      <div className="font-medium mb-1">
        {family} — started {formatRelative(status.startedAt)}
        {status.totalErrors.length > 0 && (
          <span className="ml-2 text-red-500 text-xs">({status.totalErrors.length} errors)</span>
        )}
      </div>
      <div className="text-xs text-text-secondary space-y-0.5">
        {status.results.map((r, i) => (
          <div key={i} className="flex items-center gap-2 font-mono">
            <span className="text-text-tertiary">{(r.duration / 1000).toFixed(1)}s</span>
            <span>{r.syncType}</span>
            <span className="text-text-tertiary">·</span>
            <span>{r.recordsFetched.toLocaleString()} records</span>
            {r.errors.length > 0 && <span className="text-red-500">· {r.errors.length} errors</span>}
          </div>
        ))}
        {status.results.length === 0 && <div className="italic text-text-tertiary">Starting…</div>}
      </div>
    </div>
  );
}
