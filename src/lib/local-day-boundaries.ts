export const MARKETPLACE_TIME_ZONE =
  process.env.FLIPLEDGER_MARKETPLACE_TIME_ZONE || 'America/Los_Angeles';

const ISO_CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

const zonedDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const zonedDateFormatters = new Map<string, Intl.DateTimeFormat>();

function parseCalendarDate(value: string): CalendarDate {
  const match = ISO_CALENDAR_DATE.exec(value);
  if (!match) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return { year, month, day };
}

function zonedDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zonedDateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zonedDateTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function zonedParts(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(
    zonedDateTimeFormatter(timeZone)
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function offsetAt(instantMs: number, timeZone: string): number {
  const parts = zonedParts(new Date(instantMs), timeZone);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return representedAsUtc - instantMs;
}

function localMidnightToUtc(date: string, timeZone: string): string {
  const target = parseCalendarDate(date);
  const localAsUtc = Date.UTC(target.year, target.month - 1, target.day);
  let instantMs = localAsUtc;

  // Re-evaluate the offset at the candidate instant so boundaries on either
  // side of a DST change use the offset that applies to that local midnight.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const adjusted = localAsUtc - offsetAt(instantMs, timeZone);
    if (adjusted === instantMs) break;
    instantMs = adjusted;
  }

  const resolved = zonedParts(new Date(instantMs), timeZone);
  if (
    resolved.year !== target.year
    || resolved.month !== target.month
    || resolved.day !== target.day
    || resolved.hour !== 0
    || resolved.minute !== 0
    || resolved.second !== 0
  ) {
    throw new Error(`Could not resolve local midnight ${date} in ${timeZone}`);
  }
  // Keep the millisecond component. SQLite compares these ISO timestamps as
  // TEXT; a bound ending in `00Z` sorts after a stored `00.001Z`, which would
  // incorrectly exclude the first fractional-second event of the local day.
  return new Date(instantMs).toISOString();
}

export function localDayRangeToUtcBounds(
  startDate: string,
  endDateExclusive: string,
  timeZone: string = MARKETPLACE_TIME_ZONE,
): { startUtc: string; endUtc: string } {
  return {
    startUtc: localMidnightToUtc(startDate, timeZone),
    endUtc: localMidnightToUtc(endDateExclusive, timeZone),
  };
}

export function formatCalendarDateInTimeZone(
  instant: Date,
  timeZone: string = MARKETPLACE_TIME_ZONE,
): string {
  let formatter = zonedDateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    zonedDateFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addCalendarDays(date: string, days: number): string {
  const parsed = parseCalendarDate(date);
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return shifted.toISOString().slice(0, 10);
}

export function calendarDaysBetween(startDate: string, endDate: string): number {
  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(endDate);
  return Math.round(
    (
      Date.UTC(end.year, end.month - 1, end.day)
      - Date.UTC(start.year, start.month - 1, start.day)
    ) / 86_400_000,
  );
}
