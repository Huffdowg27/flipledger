import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  parseTransactionReportDate,
  parseAmountToCents,
  parseTransactionReportCsv,
  parseCsvLine,
  extractGradeAndResellFees,
  GRADE_AND_RESELL_DESCRIPTION,
  GRADE_AND_RESELL_TYPE,
  type TransactionReportRow,
} from '../src/lib/imports/transaction-report';

// ── Fixture + independently-specified control numbers ──────────────────────
// Sanitized synthetic report (no real customer/order/settlement data). The
// control totals below are computed by hand from the fixture, independently of
// the parser:
//   15 Grade rows × -180¢  = -2700¢
//    7 Grade rows × -150¢  = -1050¢
//   22 rows total          = -3750¢
// Decoys that MUST NOT match: a product title ("Premium Grade Fishing Reel"),
// a superstring ("Grade and Resell Charge Adjustment"), a lowercase variant
// ("grade and resell charge"), plus storage/subscription fees.
const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'transaction-report-grade-resell.csv'),
  'utf-8',
);
const EXPECTED_ROW_COUNT = 22;
const EXPECTED_TOTAL_CENTS = -3750;

// ── 1. Timezone-independent date parsing (proven UTC values) ───────────────
test('parseTransactionReportDate: PDT and PST resolve to exact UTC, host-TZ-independent', () => {
  assert.equal(parseTransactionReportDate('Oct 2, 2025 5:48:32 AM PDT'), '2025-10-02T12:48:32.000Z');
  assert.equal(parseTransactionReportDate('Jan 15, 2026 3:22:11 PM PST'), '2026-01-15T23:22:11.000Z');
  // 12-hour boundary conversions.
  assert.equal(parseTransactionReportDate('Jan 1, 2026 12:00:00 AM PST'), '2026-01-01T08:00:00.000Z');
  assert.equal(parseTransactionReportDate('Jan 1, 2026 12:00:00 PM PST'), '2026-01-01T20:00:00.000Z');
  // Offset that rolls the date forward across midnight UTC.
  assert.equal(parseTransactionReportDate('Jan 15, 2026 6:00:00 PM PST'), '2026-01-16T02:00:00.000Z');
});

test('parseTransactionReportDate: fails closed on malformed input', () => {
  assert.throws(() => parseTransactionReportDate(''));
  assert.throws(() => parseTransactionReportDate('2026-01-15 15:22:11'));
  assert.throws(() => parseTransactionReportDate('Jan 15, 2026 3:22:11 PM EST'));
  assert.throws(() => parseTransactionReportDate('Foo 15, 2026 3:22:11 PM PST'));
});

// ── 2. Amount parsing (integer cents, no float, fail-closed) ───────────────
test('parseAmountToCents: exact cents without float drift', () => {
  assert.equal(parseAmountToCents('-1.80'), -180);
  assert.equal(parseAmountToCents('-1.50'), -150);
  assert.equal(parseAmountToCents('0.10'), 10); // 0.1 float trap
  assert.equal(parseAmountToCents('1,234.56'), 123456);
  assert.equal(parseAmountToCents('"-39.99"'), -3999);
  assert.equal(parseAmountToCents('5'), 500);
});

test('parseAmountToCents: fails closed on empty/malformed', () => {
  assert.throws(() => parseAmountToCents(''));
  assert.throws(() => parseAmountToCents('abc'));
  assert.throws(() => parseAmountToCents('1.234'));
  assert.throws(() => parseAmountToCents('--1.00'));
});

// ── 3. Fixture extraction: exact count + total ─────────────────────────────
test('extractGradeAndResellFees: fixture yields 22 rows / -3750¢', () => {
  const rows = parseTransactionReportCsv(FIXTURE);
  const fees = extractGradeAndResellFees(rows);
  assert.equal(fees.length, EXPECTED_ROW_COUNT);
  const total = fees.reduce((sum, f) => sum + f.amountCents, 0);
  assert.equal(total, EXPECTED_TOTAL_CENTS);

  const count180 = fees.filter((f) => f.amountCents === -180).length;
  const count150 = fees.filter((f) => f.amountCents === -150).length;
  assert.equal(count180, 15);
  assert.equal(count150, 7);
});

// ── 4. Exact-description filtering ─────────────────────────────────────────
test('extractGradeAndResellFees: matches ONLY the exact description', () => {
  const rows = parseTransactionReportCsv(FIXTURE);
  const fees = extractGradeAndResellFees(rows);
  // Every match is exactly the canonical string.
  for (const f of fees) assert.equal(f.description, GRADE_AND_RESELL_DESCRIPTION);
  // Decoys present in the fixture that must be excluded:
  const descriptions = rows.map((r) => r.description);
  assert.ok(descriptions.includes('Premium Grade Fishing Reel'));       // product title
  assert.ok(descriptions.includes('Grade and Resell Charge Adjustment')); // superstring
  assert.ok(descriptions.includes('grade and resell charge'));            // wrong case
  // None of the decoy amounts (-0.50, -9.99, 17.04) leak into the total.
  assert.ok(!fees.some((f) => f.amountCents === -50 || f.amountCents === -999 || f.amountCents === 1704));
});

// ── 5 & 6. Replay + reordered-replay identity stability ────────────────────
function identityMultiset(fees: { identity: string }[]): string[] {
  return fees.map((f) => f.identity).sort();
}

test('parsing the same report twice produces identical identity multisets', () => {
  const a = extractGradeAndResellFees(parseTransactionReportCsv(FIXTURE));
  const b = extractGradeAndResellFees(parseTransactionReportCsv(FIXTURE));
  assert.deepEqual(identityMultiset(a), identityMultiset(b));
});

test('reordering the report rows does not change identities', () => {
  const rows = parseTransactionReportCsv(FIXTURE);
  const forward = extractGradeAndResellFees(rows);

  // Reverse order.
  const reversed = extractGradeAndResellFees([...rows].reverse());
  assert.deepEqual(identityMultiset(forward), identityMultiset(reversed));

  // Deterministic non-trivial shuffle (index-based, no RNG).
  const shuffled: TransactionReportRow[] = rows
    .map((r, i) => ({ r, k: (i * 7 + 3) % rows.length }))
    .sort((x, y) => x.k - y.k)
    .map((x) => x.r);
  const shuffledFees = extractGradeAndResellFees(shuffled);
  assert.deepEqual(identityMultiset(forward), identityMultiset(shuffledFees));
});

// ── 7. Legitimate multiplicity preserved ───────────────────────────────────
test('two genuinely identical rows are preserved as two distinct occurrences', () => {
  const fees = extractGradeAndResellFees(parseTransactionReportCsv(FIXTURE));
  // The fixture's S100 pair is byte-identical (same date, settlement, amount).
  const s100 = fees.filter((f) => f.settlementId === 'S100');
  assert.equal(s100.length, 2);
  assert.deepEqual(s100.map((f) => f.occurrenceSeq).sort(), [1, 2]);
  assert.equal(s100[0].sourceIdentity, s100[1].sourceIdentity); // same content key
  assert.notEqual(s100[0].identity, s100[1].identity);          // distinct full identity
  // All full identities are unique across the whole extraction.
  const identities = fees.map((f) => f.identity);
  assert.equal(new Set(identities).size, identities.length);
});

// ── 8. Malformed headers / amounts / truncated rows fail closed ────────────
test('parseTransactionReportCsv: missing header fails closed', () => {
  assert.throws(() => parseTransactionReportCsv('just,some,columns\n1,2,3'));
});

test('parseTransactionReportCsv: missing required column fails closed', () => {
  const noTotal =
    '"date/time","settlement id","type","description"\n' +
    '"Jan 3, 2026 1:00:00 AM PST","S1","Others","Grade and Resell Charge"';
  assert.throws(() => parseTransactionReportCsv(noTotal), /missing required column "total"/);
});

test('parseTransactionReportCsv: truncated row fails closed', () => {
  const header =
    '"date/time","settlement id","type","order id","sku","description","quantity","product sales","selling fees","fba fees","other transaction fees","other","total"';
  const truncated = header + '\n"Jan 3, 2026 1:00:00 AM PST","S1","Others","Grade and Resell Charge"';
  assert.throws(() => parseTransactionReportCsv(truncated), /has 4 columns, expected 13/);
});

test('extractGradeAndResellFees: malformed amount on a matched row fails closed', () => {
  const rows: TransactionReportRow[] = [
    {
      dateTime: 'Jan 3, 2026 1:00:00 AM PST',
      settlementId: 'S1',
      type: 'Others',
      orderId: '',
      sku: '',
      description: GRADE_AND_RESELL_DESCRIPTION,
      totalRaw: '', // empty amount on a matched grade row
    },
  ];
  assert.throws(() => extractGradeAndResellFees(rows), /Empty amount/);
});

// ── Regression: four defects reproduced by review (Codex) ──────────────────
// R1: Date.UTC silently normalized invalid calendar dates (Feb 31 -> Mar 3).
test('R1 regression: invalid calendar dates fail closed (no silent normalization)', () => {
  assert.throws(() => parseTransactionReportDate('Feb 31, 2026 1:00:00 AM PST'), /Invalid calendar date/);
  assert.throws(() => parseTransactionReportDate('Apr 31, 2026 1:00:00 AM PST'), /Invalid calendar date/);
  assert.throws(() => parseTransactionReportDate('Feb 29, 2026 1:00:00 AM PST'), /Invalid calendar date/); // 2026 not a leap year
  assert.throws(() => parseTransactionReportDate('Jan 0, 2026 1:00:00 AM PST'), /Invalid calendar date/);
  // Genuine leap day still parses.
  assert.equal(parseTransactionReportDate('Feb 29, 2024 1:00:00 AM PST'), '2024-02-29T09:00:00.000Z');
});

// R2: internal spaces / mid-string `$` were stripped, silently accepting garbage.
test('R2 regression: malformed amounts fail closed', () => {
  assert.throws(() => parseAmountToCents('1 2.34'), /Malformed amount/);
  assert.throws(() => parseAmountToCents('1$2.34'), /Malformed amount/);
  assert.throws(() => parseAmountToCents('1 2'), /Malformed amount/);
  assert.throws(() => parseAmountToCents('1.2.3'), /Malformed amount/);
  // Safe-integer guard.
  assert.throws(() => parseAmountToCents('999999999999999999'), /safe integer/);
});

// R3: unterminated CSV quotes were accepted.
test('R3 regression: unterminated CSV quote fails closed', () => {
  assert.throws(() => parseCsvLine('"abc,def'), /Unterminated quote/);
  const header =
    '"date/time","settlement id","type","order id","sku","description","quantity","product sales","selling fees","fba fees","other transaction fees","other","total"';
  const badRow = header + '\n"a field that opens a quote but never closes it';
  assert.throws(() => parseTransactionReportCsv(badRow), /Unterminated quote/);
});

// R4: an Order-typed row carrying the exact fee description was wrongly extracted.
test('R4 regression: Order-typed row with the exact fee description is excluded', () => {
  const rows = parseTransactionReportCsv(FIXTURE);
  // The fixture contains an Order-typed decoy with description exactly equal to
  // the fee string; it must NOT be extracted, and the total stays -3750¢.
  assert.ok(
    rows.some(
      (r) => r.type === 'Order' && r.description === GRADE_AND_RESELL_DESCRIPTION,
    ),
    'fixture must contain the Order-typed decoy',
  );
  const fees = extractGradeAndResellFees(rows);
  assert.equal(fees.length, EXPECTED_ROW_COUNT);
  assert.equal(fees.reduce((s, f) => s + f.amountCents, 0), EXPECTED_TOTAL_CENTS);
  assert.ok(!fees.some((f) => f.amountCents === -777)); // the Order decoy's amount
  for (const f of fees) assert.equal(f.description, GRADE_AND_RESELL_DESCRIPTION);
});

test('extractGradeAndResellFees: requires type === "Others"', () => {
  const base = {
    dateTime: 'Jan 3, 2026 1:00:00 AM PST',
    settlementId: 'S1',
    orderId: '',
    sku: '',
    description: GRADE_AND_RESELL_DESCRIPTION,
    totalRaw: '-1.80',
  };
  assert.equal(GRADE_AND_RESELL_TYPE, 'Others');
  assert.equal(extractGradeAndResellFees([{ ...base, type: 'Others' }]).length, 1);
  assert.equal(extractGradeAndResellFees([{ ...base, type: 'Order' }]).length, 0);
  assert.equal(extractGradeAndResellFees([{ ...base, type: 'Adjustment' }]).length, 0);
});

// H1: a pipe-join let a `|`-containing field masquerade as a boundary, so
// (orderId="a", sku="b|c") collided with (orderId="a|b", sku="c").
test('H1 regression: delimiter-containing fields cannot collide (structured identity)', () => {
  const mk = (orderId: string, sku: string): TransactionReportRow => ({
    dateTime: 'Jan 3, 2026 1:00:00 AM PST',
    settlementId: 'S1',
    type: 'Others',
    orderId,
    sku,
    description: GRADE_AND_RESELL_DESCRIPTION,
    totalRaw: '-1.80',
  });
  const a = extractGradeAndResellFees([mk('a', 'b|c')])[0];
  const b = extractGradeAndResellFees([mk('a|b', 'c')])[0];
  assert.notEqual(a.sourceIdentity, b.sourceIdentity);
  // Combined they must be two distinct rows, not a collapsed duplicate pair.
  const both = extractGradeAndResellFees([mk('a', 'b|c'), mk('a|b', 'c')]);
  assert.equal(new Set(both.map((f) => f.identity)).size, 2);
});

// H2: quotes must be legally positioned; illegal placements fail closed.
test('H2 regression: strict CSV quoting rejects illegally positioned quotes', () => {
  assert.throws(() => parseCsvLine('abc"def"'), /Illegal quote inside unquoted field/);
  assert.throws(() => parseCsvLine('12"3"'), /Illegal quote inside unquoted field/);
  assert.throws(() => parseCsvLine('"abc"junk'), /Illegal characters after quoted field/);
  // Legal cases still work:
  assert.deepEqual(parseCsvLine('"abc","def"'), ['abc', 'def']);
  assert.deepEqual(parseCsvLine('"a""b","c"'), ['a"b', 'c']); // escaped double-quote
  assert.deepEqual(parseCsvLine('plain,fields,here'), ['plain', 'fields', 'here']);
  assert.deepEqual(parseCsvLine('"abc" ,"d"'), ['abc', 'd']); // trailing ws after close
  assert.deepEqual(parseCsvLine('a,,c'), ['a', '', 'c']); // empty middle field
});

// Identity now carries all source discriminators: two rows equal on
// timestamp/settlement/amount but differing on sku are NOT collapsed.
test('identity distinguishes rows differing only by a source discriminator (sku)', () => {
  const common = {
    dateTime: 'Jan 3, 2026 1:00:00 AM PST',
    settlementId: 'S1',
    type: 'Others',
    orderId: '',
    description: GRADE_AND_RESELL_DESCRIPTION,
    totalRaw: '-1.80',
  };
  const fees = extractGradeAndResellFees([
    { ...common, sku: 'SKU-A' },
    { ...common, sku: 'SKU-B' },
  ]);
  assert.equal(fees.length, 2);
  assert.notEqual(fees[0].sourceIdentity, fees[1].sourceIdentity); // not treated as duplicates
  assert.equal(fees[0].occurrenceSeq, 1);
  assert.equal(fees[1].occurrenceSeq, 1);
});
