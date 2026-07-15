import type Database from 'better-sqlite3';

export interface SettlementCoveragePeriod {
  settlementId: string;
  startDate: string;
  endDate: string;
  durationDays: number;
  transactionCount: number;
  reason: 'zero_rows' | 'sparse';
}

export const SETTLEMENT_COVERAGE_PREDICATE = `
  (
    transactionCount = 0
    OR (durationDays >= 3 AND transactionCount < durationDays)
  )
  -- Amazon's Reports API only lists settlement reports ~90 days back; older
  -- holes are permanently unfixable and must not alarm forever.
  AND endDate >= ?
`;

export function reportWindowFloor(now: Date = new Date()): string {
  return new Date(now.getTime() - 89 * 86400000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function hasDripTable(db: Database.Database): boolean {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settlement_drip_backfill'",
  ).get();
}

/**
 * Periods whose settlement report was successfully fetched and ingested are
 * verified — a low row count is then ground truth (quiet long-cycle
 * settlement groups exist), not missing data.
 */
function verifiedExclusion(db: Database.Database): string {
  return hasDripTable(db)
    ? "AND settlementId NOT IN (SELECT settlement_id FROM settlement_drip_backfill WHERE status = 'done')"
    : '';
}

export function getFlaggedSettlementCoveragePeriods(
  db: Database.Database,
  opts: { limit?: number; includeDoneSettlementIds?: readonly string[]; now?: Date; excludeVerified?: boolean } = {},
): SettlementCoveragePeriod[] {
  const limit = opts.limit ?? 100;
  const floor = reportWindowFloor(opts.now);
  const exclusion = opts.excludeVerified ? verifiedExclusion(db) : '';
  const rows = db.prepare(`
    WITH periodCounts AS (
      SELECT
        sp.settlement_id AS settlementId,
        sp.start_date AS startDate,
        sp.end_date AS endDate,
        ROUND(MAX(0.0, julianday(substr(sp.end_date, 1, 19)) - julianday(substr(sp.start_date, 1, 19))), 2) AS durationDays,
        COUNT(t.id) AS transactionCount
      FROM settlement_periods sp
      LEFT JOIN settlement_transactions t ON t.settlement_id = sp.settlement_id
      GROUP BY sp.settlement_id
    )
    SELECT settlementId, startDate, endDate, durationDays, transactionCount,
      CASE WHEN transactionCount = 0 THEN 'zero_rows' ELSE 'sparse' END AS reason
    FROM periodCounts
    WHERE ${SETTLEMENT_COVERAGE_PREDICATE}
    ${exclusion}
    ORDER BY startDate DESC, settlementId DESC
    LIMIT ?
  `).all(floor, limit) as SettlementCoveragePeriod[];

  return rows;
}

export function countFlaggedSettlementCoveragePeriods(
  db: Database.Database,
  opts: { now?: Date; excludeVerified?: boolean } = {},
): number {
  const floor = reportWindowFloor(opts.now);
  const exclusion = opts.excludeVerified ? verifiedExclusion(db) : '';
  const row = db.prepare(`
    WITH periodCounts AS (
      SELECT
        sp.settlement_id AS settlementId,
        sp.end_date AS endDate,
        MAX(0.0, julianday(substr(sp.end_date, 1, 19)) - julianday(substr(sp.start_date, 1, 19))) AS durationDays,
        COUNT(t.id) AS transactionCount
      FROM settlement_periods sp
      LEFT JOIN settlement_transactions t ON t.settlement_id = sp.settlement_id
      GROUP BY sp.settlement_id
    )
    SELECT COUNT(*) AS periods
    FROM periodCounts
    WHERE ${SETTLEMENT_COVERAGE_PREDICATE}
    ${exclusion}
  `).get(floor) as { periods: number };
  return row.periods;
}
