export interface SettlementReportListItem {
  reportId: string;
  reportDocumentId?: string;
  dataStartTime?: string;
  dataEndTime?: string;
  createdTime?: string;
  processingStatus?: string;
}

export interface SettlementPeriodForResolution {
  settlementId: string;
  startDate: string;
  endDate: string;
}

export interface SettlementReportCandidate {
  reportId: string;
  reportDocumentId?: string;
  dataStartTime?: string;
  dataEndTime?: string;
  createdTime?: string;
  scoreMs: number;
}

export type SettlementReportResolution =
  | {
      ok: true;
      report: SettlementReportListItem;
      expectedSettlementId: string | null;
    }
  | {
      ok: false;
      error: string;
      candidates: SettlementReportCandidate[];
    };

const EXACT_MATCH_TOLERANCE_MS = 60 * 1000;

function parseDateMs(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(' UTC', 'Z').replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function toCandidate(report: SettlementReportListItem, period: SettlementPeriodForResolution): SettlementReportCandidate | null {
  if (!report.reportDocumentId) return null;
  const reportStartMs = parseDateMs(report.dataStartTime);
  const reportEndMs = parseDateMs(report.dataEndTime);
  const periodStartMs = parseDateMs(period.startDate);
  const periodEndMs = parseDateMs(period.endDate);
  if (reportStartMs === null || reportEndMs === null || periodStartMs === null || periodEndMs === null) {
    return null;
  }

  const scoreMs = Math.abs(reportStartMs - periodStartMs) + Math.abs(reportEndMs - periodEndMs);
  if (scoreMs > EXACT_MATCH_TOLERANCE_MS) return null;

  return {
    reportId: report.reportId,
    reportDocumentId: report.reportDocumentId,
    dataStartTime: report.dataStartTime,
    dataEndTime: report.dataEndTime,
    createdTime: report.createdTime,
    scoreMs,
  };
}

export function findSettlementReportCandidates(
  period: SettlementPeriodForResolution,
  reports: SettlementReportListItem[],
): SettlementReportCandidate[] {
  return reports
    .map((report) => toCandidate(report, period))
    .filter((candidate): candidate is SettlementReportCandidate => candidate !== null)
    .sort((a, b) => a.scoreMs - b.scoreMs || a.reportId.localeCompare(b.reportId));
}

export function resolveSettlementReportIdentifier(opts: {
  reportId?: string;
  settlementId?: string;
  period?: SettlementPeriodForResolution | null;
  reports: SettlementReportListItem[];
}): SettlementReportResolution {
  const reportId = opts.reportId?.trim();
  if (reportId) {
    const listed = opts.reports.find((report) => report.reportId === reportId);
    return {
      ok: true,
      report: listed || { reportId },
      expectedSettlementId: null,
    };
  }

  const settlementId = opts.settlementId?.trim();
  if (!settlementId) {
    return { ok: false, error: 'Either reportId or settlementId is required.', candidates: [] };
  }
  if (!opts.period) {
    return {
      ok: false,
      error: `No local settlement_periods row found for settlementId ${settlementId}. Pass reportId directly.`,
      candidates: [],
    };
  }

  const candidates = findSettlementReportCandidates(opts.period, opts.reports);
  if (candidates.length === 1) {
    return {
      ok: true,
      report: candidates[0],
      expectedSettlementId: settlementId,
    };
  }

  const label = candidates.length === 0 ? 'No matching' : 'Ambiguous';
  return {
    ok: false,
    error: `${label} settlement report candidate for settlementId ${settlementId}. Pass reportId directly or widen createdSince.`,
    candidates,
  };
}

/** Reports API rejects createdSince older than ~90 days — clamp inside the window. */
function clampToReportWindow(iso: string, now: Date): string {
  const floor = now.getTime() - 89 * 86400000;
  const requested = Date.parse(iso);
  return Number.isFinite(requested) && requested < floor ? new Date(floor).toISOString() : iso;
}

export function createdSinceForSettlementPeriod(period: SettlementPeriodForResolution | null, now: Date = new Date()): string {
  if (!period) {
    return clampToReportWindow(new Date(now.getTime() - 180 * 86400000).toISOString(), now);
  }
  const startMs = parseDateMs(period.startDate);
  if (startMs === null) return clampToReportWindow(new Date(now.getTime() - 180 * 86400000).toISOString(), now);
  return clampToReportWindow(new Date(startMs - 7 * 86400000).toISOString(), now);
}
