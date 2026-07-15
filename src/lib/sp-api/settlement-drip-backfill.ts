import type Database from 'better-sqlite3';
import { getAmazonCredentials, getSetting, upsertSetting } from '../settings';
import { getFlaggedSettlementCoveragePeriods, type SettlementCoveragePeriod } from '../settlement-coverage';
import { openFlipLedgerDb } from '../sqlite';
import type { SPAPICredentials } from './types';
import { getSettlementReports, syncSettlementReportByReportId as syncReportByReportId } from './reports';
import {
  createdSinceForSettlementPeriod,
  resolveSettlementReportIdentifier,
  type SettlementReportListItem,
} from './settlement-report-resolution';

export const SETTLEMENT_DRIP_DELAY_MIN_MS = 150_000;
export const SETTLEMENT_DRIP_DELAY_MAX_MS = 180_000;
export const COOLDOWN_MS_AFTER_429 = 60 * 60_000;
export const MAX_DOWNLOADS_PER_RUN = 40;

const COOLDOWN_UNTIL_KEY = 'settlement_drip_cooldown_until';
const LAST_ERROR_KEY = 'settlement_drip_last_error';
const LAST_RUN_STARTED_KEY = 'settlement_drip_last_run_started_at';
const LAST_RUN_FINISHED_KEY = 'settlement_drip_last_run_finished_at';

export interface SettlementDripIngestInput {
  report: SettlementReportListItem;
  expectedSettlementId: string;
}

export interface SettlementDripIngestResult {
  settlementId: string;
  reportId: string;
  reportDocumentId: string;
  rowsPersisted: number;
  shippingCostsUpdated: number;
}

export interface SettlementDripDependencies {
  listReports: (createdSince: string) => Promise<SettlementReportListItem[]>;
  ingestReport: (input: SettlementDripIngestInput) => Promise<SettlementDripIngestResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  randomDelayMs: () => number;
  log: (message: string) => void;
}

export type SettlementDripTickResult =
  | { status: 'processed'; settlementId: string; reportId: string; downloadAttempted: true }
  | { status: 'failed'; settlementId: string; error: string; downloadAttempted: boolean }
  | { status: 'cooldown'; settlementId?: string; error?: string; cooldownUntil: string; downloadAttempted: boolean }
  | { status: 'no_work'; downloadAttempted: false };

export interface SettlementDripStatus {
  pending: number;
  done: number;
  failed: number;
  totalFlagged: number;
  lastError: string | null;
  cooldownUntil: string | null;
  inCooldown: boolean;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  samplePending: SettlementCoveragePeriod[];
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table);
}

function ensureSettlementDripTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS settlement_drip_backfill (
      settlement_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      report_id TEXT,
      report_document_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      rows_persisted INTEGER,
      last_attempt_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settlement_drip_backfill_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_id TEXT NOT NULL,
      report_id TEXT,
      report_document_id TEXT,
      attempted_at TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      rows_persisted INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_settlement_drip_status
      ON settlement_drip_backfill(status, updated_at);
  `);
}

function isRateLimitError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return /\b429\b|rate limit|rate-limited|throttl/i.test(message);
}

function iso(date: Date): string {
  return date.toISOString();
}

function getCooldownUntil(db: Database.Database): string | null {
  if (!tableExists(db, 'settings')) return null;
  const value = getSetting(db, COOLDOWN_UNTIL_KEY);
  return value || null;
}

function isCoolingDown(db: Database.Database, now: Date): string | null {
  const cooldownUntil = getCooldownUntil(db);
  if (!cooldownUntil) return null;
  const cooldownMs = Date.parse(cooldownUntil);
  if (Number.isFinite(cooldownMs) && cooldownMs > now.getTime()) return cooldownUntil;
  return null;
}

function markRunSetting(db: Database.Database, key: string, now: Date): void {
  upsertSetting(db, key, iso(now));
}

function recordPendingRows(db: Database.Database, flagged: SettlementCoveragePeriod[]): void {
  const insert = db.prepare(`
    INSERT INTO settlement_drip_backfill (settlement_id, status)
    VALUES (?, 'pending')
    ON CONFLICT(settlement_id) DO NOTHING
  `);
  const tx = db.transaction((rows: SettlementCoveragePeriod[]) => {
    for (const row of rows) insert.run(row.settlementId);
  });
  tx(flagged);
}

function getStateBySettlement(db: Database.Database): Map<string, { status: string; lastError: string | null }> {
  if (!tableExists(db, 'settlement_drip_backfill')) return new Map();
  const rows = db.prepare(`
    SELECT settlement_id AS settlementId, status, last_error AS lastError
    FROM settlement_drip_backfill
  `).all() as { settlementId: string; status: string; lastError: string | null }[];
  return new Map(rows.map((row) => [row.settlementId, { status: row.status, lastError: row.lastError }]));
}

function chooseNextPeriod(
  db: Database.Database,
  flagged: SettlementCoveragePeriod[],
  now: Date,
): SettlementCoveragePeriod | null {
  const cooldown = isCoolingDown(db, now);
  const state = getStateBySettlement(db);
  for (const period of flagged) {
    const existing = state.get(period.settlementId);
    if (!existing) return period;
    if (existing.status === 'done') continue;
    if (existing.status === 'failed') {
      if (!cooldown && existing.lastError && isRateLimitError(existing.lastError)) return period;
      continue;
    }
    return period;
  }
  return null;
}

function recordAttempt(
  db: Database.Database,
  input: {
    settlementId: string;
    reportId?: string;
    reportDocumentId?: string;
    attemptedAt: string;
    status: 'done' | 'failed';
    error?: string;
    rowsPersisted?: number;
  },
): void {
  db.prepare(`
    INSERT INTO settlement_drip_backfill_attempts
      (settlement_id, report_id, report_document_id, attempted_at, status, error, rows_persisted)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.settlementId,
    input.reportId || null,
    input.reportDocumentId || null,
    input.attemptedAt,
    input.status,
    input.error || null,
    input.rowsPersisted ?? null,
  );
}

function markDone(
  db: Database.Database,
  settlementId: string,
  result: SettlementDripIngestResult,
  nowIso: string,
): void {
  db.prepare(`
    INSERT INTO settlement_drip_backfill (
      settlement_id, status, report_id, report_document_id, attempts, rows_persisted,
      last_attempt_at, completed_at, last_error, updated_at
    ) VALUES (?, 'done', ?, ?, 1, ?, ?, ?, NULL, ?)
    ON CONFLICT(settlement_id) DO UPDATE SET
      status = 'done',
      report_id = excluded.report_id,
      report_document_id = excluded.report_document_id,
      attempts = settlement_drip_backfill.attempts + 1,
      rows_persisted = excluded.rows_persisted,
      last_attempt_at = excluded.last_attempt_at,
      completed_at = excluded.completed_at,
      last_error = NULL,
      updated_at = excluded.updated_at
  `).run(
    settlementId,
    result.reportId,
    result.reportDocumentId,
    result.rowsPersisted,
    nowIso,
    nowIso,
    nowIso,
  );
}

function markFailed(
  db: Database.Database,
  settlementId: string,
  error: string,
  nowIso: string,
  report?: SettlementReportListItem,
): void {
  db.prepare(`
    INSERT INTO settlement_drip_backfill (
      settlement_id, status, report_id, report_document_id, attempts,
      last_attempt_at, last_error, updated_at
    ) VALUES (?, 'failed', ?, ?, 1, ?, ?, ?)
    ON CONFLICT(settlement_id) DO UPDATE SET
      status = 'failed',
      report_id = COALESCE(excluded.report_id, settlement_drip_backfill.report_id),
      report_document_id = COALESCE(excluded.report_document_id, settlement_drip_backfill.report_document_id),
      attempts = settlement_drip_backfill.attempts + 1,
      last_attempt_at = excluded.last_attempt_at,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(
    settlementId,
    report?.reportId || null,
    report?.reportDocumentId || null,
    nowIso,
    error,
    nowIso,
  );
  upsertSetting(db, LAST_ERROR_KEY, error);
}

export function getSettlementDripStatus(db: Database.Database, now: Date = new Date()): SettlementDripStatus {
  const flagged = tableExists(db, 'settlement_periods') && tableExists(db, 'settlement_transactions')
    ? getFlaggedSettlementCoveragePeriods(db, { limit: 1000, now })
    : [];
  const flaggedIds = new Set(flagged.map((row) => row.settlementId));
  const state = getStateBySettlement(db);
  let done = 0;
  let failed = 0;
  let pending = 0;
  const samplePending: SettlementCoveragePeriod[] = [];

  for (const period of flagged) {
    const status = state.get(period.settlementId)?.status || 'pending';
    if (status === 'done') done++;
    else if (status === 'failed') failed++;
    else {
      pending++;
      if (samplePending.length < 20) samplePending.push(period);
    }
  }

  for (const [settlementId, row] of state) {
    if (!flaggedIds.has(settlementId) && row.status === 'failed') failed++;
  }

  const cooldownUntil = getCooldownUntil(db);
  const cooldownMs = cooldownUntil ? Date.parse(cooldownUntil) : NaN;
  return {
    pending,
    done,
    failed,
    totalFlagged: flagged.length,
    lastError: tableExists(db, 'settings') ? getSetting(db, LAST_ERROR_KEY) : null,
    cooldownUntil,
    inCooldown: Number.isFinite(cooldownMs) && cooldownMs > now.getTime(),
    lastRunStartedAt: tableExists(db, 'settings') ? getSetting(db, LAST_RUN_STARTED_KEY) : null,
    lastRunFinishedAt: tableExists(db, 'settings') ? getSetting(db, LAST_RUN_FINISHED_KEY) : null,
    samplePending,
  };
}

export function createSettlementDripBackfillDependencies(
  credentials: SPAPICredentials,
): SettlementDripDependencies {
  return {
    listReports: (createdSince) => getSettlementReports(credentials, createdSince),
    ingestReport: async function syncSettlementReportByReportId({ report, expectedSettlementId }) {
      return syncReportByReportId(credentials, {
        reportId: report.reportId,
        reportDocumentId: report.reportDocumentId,
        expectedSettlementId,
      });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    randomDelayMs: () => SETTLEMENT_DRIP_DELAY_MIN_MS
      + Math.floor(Math.random() * (SETTLEMENT_DRIP_DELAY_MAX_MS - SETTLEMENT_DRIP_DELAY_MIN_MS + 1)),
    log: (message) => console.log(message),
  };
}

export async function runSettlementDripTick(
  db: Database.Database,
  deps: SettlementDripDependencies,
): Promise<SettlementDripTickResult> {
  ensureSettlementDripTables(db);
  const now = deps.now();
  const nowIso = iso(now);
  const cooldownUntil = isCoolingDown(db, now);
  if (cooldownUntil) {
    return { status: 'cooldown', cooldownUntil, downloadAttempted: false };
  }

  const flagged = getFlaggedSettlementCoveragePeriods(db, { limit: 1000, now });
  recordPendingRows(db, flagged);
  const period = chooseNextPeriod(db, flagged, now);
  if (!period) return { status: 'no_work', downloadAttempted: false };

  const createdSince = createdSinceForSettlementPeriod({
    settlementId: period.settlementId,
    startDate: period.startDate,
    endDate: period.endDate,
  }, now);
  let reports: SettlementReportListItem[];
  try {
    reports = await deps.listReports(createdSince);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    markFailed(db, period.settlementId, message, nowIso);
    recordAttempt(db, {
      settlementId: period.settlementId,
      attemptedAt: nowIso,
      status: 'failed',
      error: message,
    });
    if (isRateLimitError(error)) {
      const cooldown = iso(new Date(now.getTime() + COOLDOWN_MS_AFTER_429));
      upsertSetting(db, COOLDOWN_UNTIL_KEY, cooldown);
      deps.log(`[SettlementDrip] ${period.settlementId}: report listing rate-limited; cooling down until ${cooldown}`);
      return {
        status: 'cooldown',
        settlementId: period.settlementId,
        error: message,
        cooldownUntil: cooldown,
        downloadAttempted: false,
      };
    }
    deps.log(`[SettlementDrip] ${period.settlementId}: report listing failed: ${message}`);
    return { status: 'failed', settlementId: period.settlementId, error: message, downloadAttempted: false };
  }
  const resolution = resolveSettlementReportIdentifier({
    settlementId: period.settlementId,
    period: {
      settlementId: period.settlementId,
      startDate: period.startDate,
      endDate: period.endDate,
    },
    reports,
  });

  if (!resolution.ok) {
    const error = `${resolution.error} Candidates: ${JSON.stringify(resolution.candidates)}`;
    markFailed(db, period.settlementId, error, nowIso);
    recordAttempt(db, {
      settlementId: period.settlementId,
      attemptedAt: nowIso,
      status: 'failed',
      error,
    });
    deps.log(`[SettlementDrip] ${period.settlementId}: ${error}`);
    return { status: 'failed', settlementId: period.settlementId, error, downloadAttempted: false };
  }

  deps.log(`[SettlementDrip] ${period.settlementId}: ingesting report ${resolution.report.reportId}`);
  try {
    const result = await deps.ingestReport({
      report: resolution.report,
      expectedSettlementId: period.settlementId,
    });
    markDone(db, period.settlementId, result, nowIso);
    recordAttempt(db, {
      settlementId: period.settlementId,
      reportId: result.reportId,
      reportDocumentId: result.reportDocumentId,
      attemptedAt: nowIso,
      status: 'done',
      rowsPersisted: result.rowsPersisted,
    });
    return {
      status: 'processed',
      settlementId: period.settlementId,
      reportId: result.reportId,
      downloadAttempted: true,
    };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    markFailed(db, period.settlementId, message, nowIso, resolution.report);
    recordAttempt(db, {
      settlementId: period.settlementId,
      reportId: resolution.report.reportId,
      reportDocumentId: resolution.report.reportDocumentId,
      attemptedAt: nowIso,
      status: 'failed',
      error: message,
    });

    if (isRateLimitError(error)) {
      const cooldown = iso(new Date(now.getTime() + COOLDOWN_MS_AFTER_429));
      upsertSetting(db, COOLDOWN_UNTIL_KEY, cooldown);
      deps.log(`[SettlementDrip] ${period.settlementId}: 429/rate limit; cooling down until ${cooldown}`);
      return {
        status: 'cooldown',
        settlementId: period.settlementId,
        error: message,
        cooldownUntil: cooldown,
        downloadAttempted: true,
      };
    }

    deps.log(`[SettlementDrip] ${period.settlementId}: failed: ${message}`);
    return { status: 'failed', settlementId: period.settlementId, error: message, downloadAttempted: true };
  }
}

export async function runSettlementDripBackfill(
  db: Database.Database,
  deps: SettlementDripDependencies,
  opts: { maxDownloads?: number } = {},
): Promise<{ downloadsAttempted: number; stoppedReason: SettlementDripTickResult['status'] | 'max_downloads' }> {
  ensureSettlementDripTables(db);
  markRunSetting(db, LAST_RUN_STARTED_KEY, deps.now());
  const maxDownloads = opts.maxDownloads ?? MAX_DOWNLOADS_PER_RUN;
  let downloadsAttempted = 0;
  let stoppedReason: SettlementDripTickResult['status'] | 'max_downloads' = 'no_work';

  try {
    while (downloadsAttempted < maxDownloads) {
      const result = await runSettlementDripTick(db, deps);
      stoppedReason = result.status;
      if (result.downloadAttempted) downloadsAttempted++;

      if (result.status === 'failed') {
        // Non-throttle failure (e.g. Amazon's ~90-day report listing window
        // has expired for an old period): it's recorded and will be skipped
        // by chooseNextPeriod — move on to the next period instead of
        // aborting the whole run. 429s surface as 'cooldown', not 'failed'.
        const statusAfterFailure = getSettlementDripStatus(db, deps.now());
        if (statusAfterFailure.pending <= 0) break;
        if (downloadsAttempted >= maxDownloads) { stoppedReason = 'max_downloads'; break; }
        await deps.sleep(deps.randomDelayMs());
        continue;
      }
      if (result.status !== 'processed') break;
      if (downloadsAttempted >= maxDownloads) {
        stoppedReason = 'max_downloads';
        break;
      }

      const status = getSettlementDripStatus(db, deps.now());
      if (status.pending <= 0) break;
      await deps.sleep(deps.randomDelayMs());
    }
    return { downloadsAttempted, stoppedReason };
  } finally {
    markRunSetting(db, LAST_RUN_FINISHED_KEY, deps.now());
  }
}

export async function runSettlementDripBackfillFromProdDb(
  opts: { maxDownloads?: number } = {},
): Promise<{ downloadsAttempted: number; stoppedReason: SettlementDripTickResult['status'] | 'max_downloads'; status: SettlementDripStatus }> {
  const db = openFlipLedgerDb();
  // Background job: it can afford to out-wait long sync write transactions
  // instead of dying SQLITE_BUSY (the shared opener's 15s default was
  // outlasted by an hourly sync on 2026-07-07).
  db.pragma('busy_timeout = 180000');
  try {
    const credentials = getAmazonCredentials(db);
    if (!credentials) throw new Error('Missing SP-API credentials.');
    const deps = createSettlementDripBackfillDependencies(credentials);
    const result = await runSettlementDripBackfill(db, deps, opts);
    return { ...result, status: getSettlementDripStatus(db) };
  } finally {
    db.close();
  }
}
