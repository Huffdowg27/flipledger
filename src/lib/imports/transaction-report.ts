/**
 * Pure, side-effect-free parser for Amazon's Unified / Date-Range financial
 * transaction report (report type GET_DATE_RANGE_FINANCIAL_TRANSACTION_DATA).
 *
 * Phase 1 scope: parsing + canonical identity ONLY. This module does not touch
 * the database, SP-API, or the filesystem. It exists so that dated, canonical
 * "Grade and Resell Charge" fees can eventually replace the undated, duplicating
 * ServiceFeeEvent feed — but persistence is deliberately NOT designed here.
 *
 * Money is integer cents throughout (CLAUDE.md rule 1); no float math.
 */

/** Exact Amazon description for the ReCommerce grade-and-resell fee. */
export const GRADE_AND_RESELL_DESCRIPTION = 'Grade and Resell Charge';

/** Exact Amazon transaction-report `type` value these fees post under. */
export const GRADE_AND_RESELL_TYPE = 'Others';

export interface TransactionReportRow {
  dateTime: string;
  settlementId: string;
  type: string;
  orderId: string;
  sku: string;
  description: string;
  /** Raw, unparsed value of the "total" column (parsed strictly at extraction). */
  totalRaw: string;
}

export interface GradeAndResellFee {
  /** Exact UTC timestamp, ISO-8601 (e.g. "2026-01-03T09:00:00.000Z"). */
  timestampUtc: string;
  /** Settlement id when present, else null. */
  settlementId: string | null;
  description: string;
  amountCents: number;
  /**
   * Deterministic, reorder-independent content identity for the row. Two rows
   * with identical content produce the same sourceIdentity (multiplicity is
   * carried by occurrenceSeq, not by mangling this key).
   */
  sourceIdentity: string;
  /** 1-based sequence disambiguating genuinely identical rows. */
  occurrenceSeq: number;
  /** Full stable identity = `${sourceIdentity}#${occurrenceSeq}`. */
  identity: string;
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// Pacific offsets: hours to ADD to local wall-clock time to reach UTC.
const TZ_OFFSET_HOURS: Record<string, number> = {
  PDT: 7, // UTC-7
  PST: 8, // UTC-8
  UTC: 0,
};

const DATE_RE =
  /^([A-Za-z]{3}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM) (PDT|PST|UTC)$/;

/**
 * Parse an Amazon transaction-report timestamp into an exact UTC ISO string.
 *
 * TIMEZONE-INDEPENDENT: unlike `new Date("Oct 2, 2025 5:48:32 AM")` (which the
 * legacy importer used, and which resolves in the *host* timezone), this builds
 * the instant from parsed components via `Date.UTC`, so it yields the same
 * result on a PST laptop and a UTC server.
 *
 * Fails closed: throws on any unrecognized shape.
 *
 * Proven values:
 *   "Oct 2, 2025 5:48:32 AM PDT" -> "2025-10-02T12:48:32.000Z"  (05:48:32 -07:00)
 *   "Jan 15, 2026 3:22:11 PM PST" -> "2026-01-15T23:22:11.000Z" (15:22:11 -08:00)
 */
export function parseTransactionReportDate(raw: string): string {
  const s = (raw ?? '').trim();
  const m = DATE_RE.exec(s);
  if (!m) throw new Error(`Unparseable transaction-report date: ${JSON.stringify(raw)}`);

  const [, mon, dayStr, yearStr, hourStr, minStr, secStr, ampm, tz] = m;
  const month = MONTHS[mon];
  if (month === undefined) throw new Error(`Unknown month in date: ${JSON.stringify(raw)}`);

  const day = Number(dayStr);
  const year = Number(yearStr);
  let hour = Number(hourStr);
  const minute = Number(minStr);
  const second = Number(secStr);

  if (hour < 1 || hour > 12) throw new Error(`Bad 12-hour value in date: ${JSON.stringify(raw)}`);
  if (minute > 59 || second > 59) throw new Error(`Bad minute/second in date: ${JSON.stringify(raw)}`);

  // 12-hour -> 24-hour.
  if (ampm === 'AM') {
    if (hour === 12) hour = 0;
  } else {
    if (hour !== 12) hour += 12;
  }

  const offsetHours = TZ_OFFSET_HOURS[tz];
  // Treat wall-clock components as UTC, then shift by the zone offset to the
  // true instant.
  const asIfUtcMs = Date.UTC(year, month, day, hour, minute, second);

  // Strict calendar validation: Date.UTC silently normalizes overflow
  // (e.g. Feb 31 -> Mar 3). Reject any date whose wall-clock components do not
  // round-trip exactly. Validate on the PRE-offset instant so the check sees
  // the original wall-clock day/month/year, not the UTC-shifted one.
  const check = new Date(asIfUtcMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    throw new Error(`Invalid calendar date: ${JSON.stringify(raw)}`);
  }

  const utcMs = asIfUtcMs + offsetHours * 3_600_000;
  return new Date(utcMs).toISOString();
}

/**
 * Parse a money string to integer cents WITHOUT float math.
 *
 * Strict grammar: optional leading sign, optional `$`, then EITHER
 * comma-grouped thousands (`1,234`) OR plain digits (`1234`), then optional
 * `.dd` (1-2 decimals). Internal spaces or a mid-string `$` are rejected, so
 * `"1 2.34"` and `"1$2.34"` fail closed (they used to silently parse to 1234).
 * Result is validated as a safe integer.
 *
 * Fails closed: throws on empty or malformed input.
 */
export function parseAmountToCents(raw: string): number {
  let s = (raw ?? '').trim();
  // Strip a single layer of surrounding double-quotes only (never internal chars).
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  if (s === '') throw new Error('Empty amount');

  const m = /^(-?)\$?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Malformed amount: ${JSON.stringify(raw)}`);
  const [, sign, whole, frac = ''] = m;
  const digits = whole.replace(/,/g, '');
  const fracCents = Number((frac + '00').slice(0, 2));
  const cents = Number(digits) * 100 + fracCents;
  if (!Number.isSafeInteger(cents)) throw new Error(`Amount out of safe integer range: ${JSON.stringify(raw)}`);
  return sign === '-' ? -cents : cents;
}

/**
 * Strict RFC-4180 single-line splitter. Fail-closed on illegally positioned
 * quotes:
 *   - a `"` may only OPEN a field (at a field boundary), never appear mid-field
 *     (`abc"def"`, `12"3"` are rejected);
 *   - after a field's closing quote only a delimiter, line end, or whitespace
 *     may follow (`"abc"junk` is rejected);
 *   - `""` inside a quoted field is an escaped double-quote;
 *   - an unterminated quoted field is rejected.
 * Unquoted fields are trimmed; quoted content is preserved literally.
 */
export function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let current = '';
  type State = 'START' | 'UNQUOTED' | 'QUOTED' | 'AFTER_QUOTE';
  let state: State = 'START';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    switch (state) {
      case 'START':
        if (ch === '"') state = 'QUOTED';
        else if (ch === ',') cols.push('');
        else if (ch === ' ' || ch === '\t') { /* skip leading whitespace */ }
        else { current += ch; state = 'UNQUOTED'; }
        break;
      case 'UNQUOTED':
        if (ch === '"') throw new Error(`Illegal quote inside unquoted field in CSV line: ${JSON.stringify(line)}`);
        else if (ch === ',') { cols.push(current.trimEnd()); current = ''; state = 'START'; }
        else current += ch;
        break;
      case 'QUOTED':
        if (ch === '"') {
          if (line[i + 1] === '"') { current += '"'; i++; } // escaped quote
          else state = 'AFTER_QUOTE';
        } else current += ch;
        break;
      case 'AFTER_QUOTE':
        if (ch === ',') { cols.push(current); current = ''; state = 'START'; }
        else if (ch === ' ' || ch === '\t') { /* allowed trailing whitespace */ }
        else throw new Error(`Illegal characters after quoted field in CSV line: ${JSON.stringify(line)}`);
        break;
    }
  }

  if (state === 'QUOTED') throw new Error(`Unterminated quote in CSV line: ${JSON.stringify(line)}`);
  cols.push(state === 'UNQUOTED' ? current.trimEnd() : current);
  return cols;
}

const REQUIRED_COLUMNS = ['date/time', 'settlement id', 'type', 'description', 'total'] as const;

/**
 * Parse a full transaction-report CSV into typed rows.
 *
 * Fails closed on:
 *  - missing/unrecognized header (no "date/time" row, or a required column absent)
 *  - truncated / ragged data rows (column count != header column count)
 *
 * Blank lines are skipped. Money is left raw here (see parseAmountToCents).
 */
export function parseTransactionReportCsv(content: string): TransactionReportRow[] {
  const stripped = content.replace(/^﻿/, '');
  const lines = stripped.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < Math.min(50, lines.length); i++) {
    let first: string | undefined;
    try {
      first = parseCsvLine(lines[i])[0]?.toLowerCase();
    } catch {
      continue; // tolerate malformed preamble lines; data rows are still strict
    }
    if (first === 'date/time') {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error('Malformed transaction report: no header row starting with "date/time"');
  }

  const headers = parseCsvLine(lines[headerIdx]).map((h) => h.toLowerCase());
  const col = (name: string) => headers.findIndex((h) => h === name);

  for (const required of REQUIRED_COLUMNS) {
    if (col(required) === -1) {
      throw new Error(`Malformed transaction report: missing required column "${required}"`);
    }
  }

  const dateIdx = col('date/time');
  const settlementIdx = col('settlement id');
  const typeIdx = col('type');
  const orderIdx = col('order id'); // optional
  const skuIdx = col('sku'); // optional
  const descIdx = col('description');
  const totalIdx = col('total');

  const rows: TransactionReportRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue; // skip blank lines
    const cols = parseCsvLine(lines[i]);
    if (cols.length !== headers.length) {
      throw new Error(
        `Malformed transaction report: row ${i + 1} has ${cols.length} columns, expected ${headers.length}`,
      );
    }
    rows.push({
      dateTime: cols[dateIdx] || '',
      settlementId: cols[settlementIdx] || '',
      type: cols[typeIdx] || '',
      orderId: orderIdx === -1 ? '' : cols[orderIdx] || '',
      sku: skuIdx === -1 ? '' : cols[skuIdx] || '',
      description: cols[descIdx] || '',
      totalRaw: cols[totalIdx] || '',
    });
  }
  return rows;
}

/**
 * Extract canonical, dated Grade-and-Resell fees from parsed rows.
 *
 * - Matches ONLY rows whose type is exactly `GRADE_AND_RESELL_TYPE` ("Others")
 *   AND whose description is exactly `GRADE_AND_RESELL_DESCRIPTION`. This rejects
 *   a product title containing "grade", a superstring like "Grade and Resell
 *   Charge Adjustment", and an `Order`-typed row that happens to carry the exact
 *   fee description.
 * - Assigns a deterministic, reorder-independent identity per row, built from
 *   ALL available source discriminators. Genuinely identical rows are preserved
 *   as distinct occurrences (occurrenceSeq 1..N).
 * - Fails closed on a malformed/empty amount or unparseable date on a matched row.
 */
export function extractGradeAndResellFees(rows: TransactionReportRow[]): GradeAndResellFee[] {
  const matched = rows.filter(
    (r) => r.type === GRADE_AND_RESELL_TYPE && r.description === GRADE_AND_RESELL_DESCRIPTION,
  );

  const partial = matched.map((r) => {
    const timestampUtc = parseTransactionReportDate(r.dateTime);
    const amountCents = parseAmountToCents(r.totalRaw);
    const settlementId = r.settlementId.trim() === '' ? null : r.settlementId.trim();
    // Identity carries every source discriminator so distinct rows never collide
    // and multiplicity is only ever attributed to genuinely identical rows.
    // Use a structured (JSON) encoding, NOT a delimiter join: a `|`-join lets a
    // field containing `|` masquerade as a field boundary, so e.g.
    // (orderId="a", sku="b|c") and (orderId="a|b", sku="c") would collide.
    const sourceIdentity = JSON.stringify([
      timestampUtc,
      settlementId,
      r.type,
      r.orderId,
      r.sku,
      r.description,
      amountCents,
    ]);
    return { timestampUtc, settlementId, description: r.description, amountCents, sourceIdentity };
  });

  // Sort by content key so occurrence numbering is independent of input order.
  // Identical rows share a key; numbering them 1..N yields a stable multiset.
  partial.sort((a, b) => (a.sourceIdentity < b.sourceIdentity ? -1 : a.sourceIdentity > b.sourceIdentity ? 1 : 0));

  const seen = new Map<string, number>();
  return partial.map((p) => {
    const seq = (seen.get(p.sourceIdentity) ?? 0) + 1;
    seen.set(p.sourceIdentity, seq);
    return { ...p, occurrenceSeq: seq, identity: `${p.sourceIdentity}#${seq}` };
  });
}
