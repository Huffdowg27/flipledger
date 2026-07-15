import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { SYNC_JOB_REGISTRY, getInFlightJobs } from '@/lib/sp-api/auto-sync';
import { getSyncStatus } from '@/lib/sp-api/sync';
import { getWalmartSyncStatus } from '@/lib/walmart-api/sync';
import { getEbaySyncStatus } from '@/lib/ebay-api/sync';

// Read-only snapshot of every tracked sync job: last success, last attempt,
// next eligible run, in-flight status. Powers the /sync dashboard.
// No state is mutated here; safe to call as often as the UI wants.

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
  staleness: 'fresh' | 'due' | 'overdue' | 'never';
  inFlight: boolean;
}

function readAllSettings(): Record<string, string> {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma('busy_timeout = 15000');
    db.pragma('journal_mode = WAL');
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } finally {
    db.close();
  }
}

function classify(lastSuccessMs: number, intervalMs: number): JobStatusRow['staleness'] {
  if (lastSuccessMs === 0) return 'never';
  const dueAt = lastSuccessMs + intervalMs;
  const now = Date.now();
  if (now < dueAt) return 'fresh';
  if (now < dueAt + intervalMs) return 'due';
  return 'overdue';
}

export async function GET() {
  let settings: Record<string, string>;
  try {
    settings = readAllSettings();
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  const inFlight = new Set(getInFlightJobs());
  const now = new Date().toISOString();

  const jobs: JobStatusRow[] = SYNC_JOB_REGISTRY.map(entry => {
    const lastSuccess = settings[entry.key] || null;
    const lastAttempt = settings[`${entry.key}_attempted_at`] || null;
    const lastSuccessMs = lastSuccess ? new Date(lastSuccess).getTime() : 0;
    const lastAttemptMs = lastAttempt ? new Date(lastAttempt).getTime() : 0;
    const intervalMs = entry.intervalHours * 3600000;

    // Next eligible is gated by max(success, attempt) per autoSyncTick.
    const lastTouchMs = Math.max(lastSuccessMs, lastAttemptMs);
    const nextEligibleMs = lastTouchMs > 0 ? lastTouchMs + intervalMs : Date.now();

    return {
      key: entry.key,
      label: entry.label,
      description: entry.description,
      family: entry.family,
      intervalHours: entry.intervalHours,
      runRoute: entry.runRoute,
      method: entry.method,
      body: 'body' in entry ? (entry.body as Record<string, unknown>) : undefined,
      note: 'note' in entry ? (entry.note as string) : undefined,
      lastSuccessAt: lastSuccess,
      lastAttemptAt: lastAttempt,
      nextEligibleAt: new Date(nextEligibleMs).toISOString(),
      staleness: classify(lastSuccessMs, intervalMs),
      inFlight: inFlight.has(entry.key),
    };
  });

  // In-process status of the three full-sync runners. Reports per-stage progress
  // when one of them is alive so the UI can show "syncing X / Y stages".
  const live = {
    amazon: getSyncStatus(),
    walmart: getWalmartSyncStatus(),
    ebay: getEbaySyncStatus(),
  };

  return NextResponse.json({
    asOf: now,
    jobs,
    live,
    inFlightKeys: Array.from(inFlight),
  });
}
