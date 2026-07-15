import type Database from 'better-sqlite3';

export interface SettlementPeriodMetadata {
  settlementId: string;
  marketplace: string;
  startDate: string;
  endDate: string;
  depositDate: string | null;
}

function formatUtcParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string | null {
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    instant.getUTCFullYear() !== year
    || instant.getUTCMonth() !== month - 1
    || instant.getUTCDate() !== day
    || instant.getUTCHours() !== hour
    || instant.getUTCMinutes() !== minute
    || instant.getUTCSeconds() !== second
  ) {
    return null;
  }
  return instant.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

export function normalizeSettlementDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const canonical = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: UTC)?$/.exec(value);
  if (canonical) {
    return formatUtcParts(
      Number(canonical[1]),
      Number(canonical[2]),
      Number(canonical[3]),
      Number(canonical[4]),
      Number(canonical[5]),
      Number(canonical[6]),
    );
  }

  const european = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})(?: UTC)?$/.exec(value);
  if (european) {
    return formatUtcParts(
      Number(european[3]),
      Number(european[2]),
      Number(european[1]),
      Number(european[4]),
      Number(european[5]),
      Number(european[6]),
    );
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const instant = new Date(value);
    if (!Number.isNaN(instant.getTime())) {
      return instant.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
    }
  }
  return null;
}

function normalizeMarketplace(raw: string | undefined): string {
  const value = (raw || '').trim().toLowerCase();
  if (!value || value.startsWith('amazon.')) return 'amazon';
  return value;
}

export function parseSettlementPeriodMetadata(
  content: string,
): SettlementPeriodMetadata | null {
  const lines = content.split(/\r?\n/);
  if (lines.length < 2) return null;

  const headers = lines[0].split('\t').map((value) => value.trim().replace(/"/g, ''));
  const index = (name: string) => headers.indexOf(name);
  const settlementIdIndex = index('settlement-id');
  const startIndex = index('settlement-start-date');
  const endIndex = index('settlement-end-date');
  const depositIndex = index('deposit-date');
  const marketplaceIndex = index('marketplace-name');
  if (settlementIdIndex < 0 || startIndex < 0 || endIndex < 0) return null;

  const requiredMax = Math.max(settlementIdIndex, startIndex, endIndex);
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    const columns = lines[lineIndex].split('\t').map((value) => value.trim().replace(/"/g, ''));
    if (columns.length <= requiredMax) continue;

    const settlementId = columns[settlementIdIndex] || '';
    const startDate = normalizeSettlementDate(columns[startIndex] || '');
    const endDate = normalizeSettlementDate(columns[endIndex] || '');
    if (!settlementId || !startDate || !endDate) continue;

    const rawDeposit = depositIndex >= 0 ? columns[depositIndex] || '' : '';
    const depositDate = rawDeposit ? normalizeSettlementDate(rawDeposit) : null;
    if (rawDeposit && !depositDate) continue;

    return {
      settlementId,
      marketplace: normalizeMarketplace(
        marketplaceIndex >= 0 ? columns[marketplaceIndex] : undefined,
      ),
      startDate,
      endDate,
      depositDate,
    };
  }
  return null;
}

export function upsertSettlementPeriod(
  db: Database.Database,
  metadata: SettlementPeriodMetadata,
): void {
  db.prepare(`
    INSERT INTO settlement_periods (
      settlement_id, marketplace, start_date, end_date, deposit_date,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(settlement_id) DO UPDATE SET
      marketplace = excluded.marketplace,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      deposit_date = excluded.deposit_date,
      updated_at = datetime('now')
  `).run(
    metadata.settlementId,
    metadata.marketplace,
    metadata.startDate,
    metadata.endDate,
    metadata.depositDate,
  );
}
