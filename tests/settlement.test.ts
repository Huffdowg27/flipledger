import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { openFlipLedgerDb, getFlipLedgerDbPath } from '../src/lib/sqlite';
import {
  parseSettlementLines,
  classifySettlementLine,
  reconcilePayout,
  replaceSettlementLines,
  replaceSettlementReport,
  type SettlementCategory,
  type SettlementLine,
} from '../src/lib/sp-api/settlementParser';

// ── Fixture + independently-specified control numbers ──────────────────────
// The fixture is a sanitized Amazon flat-file V2 settlement (no real customer
// or order data). Its payout control total and line count are stated here
// independently of the parser, computed by hand from the fixture rows:
//   2500 -375 -322 -206 -1200 -30 -418 -150 -150 -5000 +5000 +4000 = 3649
const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'settlement-sample.tsv'),
  'utf-8',
);
const SETTLEMENT_ID = 'SETTLE-TEST-001';
const CONTROL_TOTAL_CENTS = 3649;
const EXPECTED_LINE_COUNT = 12;

// Expected per-line cents, in file order — the byte-for-byte preservation lock.
const EXPECTED_CENTS = [2500, -375, -322, -206, -1200, -30, -418, -150, -150, -5000, 5000, 4000];

// Expected classification counts. The categories partition the lines, so their
// sum MUST equal the line count (nothing disappears).
const EXPECTED_CLASS_COUNTS: Record<SettlementCategory, number> = {
  order: 2,
  fee: 4,
  'tax-withholding': 1,
  refund: 2,
  'shipping-label': 1,
  reserve: 2,
  other: 0,
};

function memDb() {
  // ':memory:' guarantees invariant #6 — no test ever touches data/flipledger.db.
  return openFlipLedgerDb({ dbPath: ':memory:', foreignKeys: false });
}

// ── Invariant 1: every settlement line preserved in integer cents ──────────
test('every settlement line is preserved in integer cents', () => {
  const { settlementId, lines } = parseSettlementLines(FIXTURE);
  assert.equal(settlementId, SETTLEMENT_ID);
  assert.equal(lines.length, EXPECTED_LINE_COUNT, 'no line dropped');
  for (const l of lines) {
    assert.ok(Number.isInteger(l.amountCents), `amountCents must be an integer: ${l.amountCents}`);
  }
  assert.deepEqual(lines.map(l => l.amountCents), EXPECTED_CENTS, 'cents preserved exactly, in order');
});

// ── Invariant 2: sum of stored lines == independent payout control total ────
test('sum of stored lines equals the independent payout control total', () => {
  const { settlementId, lines } = parseSettlementLines(FIXTURE);

  // Pure reconcile matches the control total.
  assert.equal(reconcilePayout(lines), CONTROL_TOTAL_CENTS);

  // And the PERSISTED rows sum to the same control total.
  const db = memDb();
  try {
    replaceSettlementLines(db, settlementId, lines);
    const sum = (db.prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS s FROM settlement_transactions WHERE settlement_id = ?',
    ).get(SETTLEMENT_ID) as { s: number }).s;
    assert.equal(sum, CONTROL_TOTAL_CENTS);
  } finally {
    db.close();
  }
});

// ── Invariant 3: each kind classified without disappearing ─────────────────
test('refund, order, fee, tax-withholding, shipping-label, reserve, and duplicate-identical-fee lines are classified without disappearing', () => {
  const { lines } = parseSettlementLines(FIXTURE);

  const counts: Record<string, number> = {};
  for (const l of lines) {
    const cat = classifySettlementLine(l);
    counts[cat] = (counts[cat] || 0) + 1;
  }

  for (const [cat, expected] of Object.entries(EXPECTED_CLASS_COUNTS)) {
    assert.equal(counts[cat] || 0, expected, `category ${cat} count`);
  }

  // The classifier partitions the lines: the buckets sum back to every line.
  const classifiedTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(classifiedTotal, lines.length, 'no line lost during classification');

  // Each represented kind is present at least once (none silently vanished).
  for (const kind of ['refund', 'order', 'fee', 'tax-withholding', 'shipping-label', 'reserve'] as const) {
    assert.ok((counts[kind] || 0) >= 1, `${kind} line must survive`);
  }

  // Duplicate-identical fee lines are BOTH preserved (never collapsed): two
  // "Storage Fee" rows of -150 cents must remain two distinct lines.
  const storageDupes = lines.filter(l => l.amountDescription === 'Storage Fee' && l.amountCents === -150);
  assert.equal(storageDupes.length, 2, 'duplicate-identical fee lines both preserved');
});

// ── Invariant 4: parsing the same settlement twice is identical ────────────
test('parsing the same settlement twice produces the same row count and totals', () => {
  const a = parseSettlementLines(FIXTURE);
  const b = parseSettlementLines(FIXTURE);
  assert.deepEqual(a, b, 'pure parse is deterministic');

  const db = memDb();
  try {
    const n1 = replaceSettlementLines(db, a.settlementId, a.lines);
    const count1 = (db.prepare('SELECT COUNT(*) AS c FROM settlement_transactions').get() as { c: number }).c;
    const sum1 = (db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM settlement_transactions').get() as { s: number }).s;

    const n2 = replaceSettlementLines(db, b.settlementId, b.lines);
    const count2 = (db.prepare('SELECT COUNT(*) AS c FROM settlement_transactions').get() as { c: number }).c;
    const sum2 = (db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM settlement_transactions').get() as { s: number }).s;

    // Replay does not duplicate, drop, or alter totals — the atomic replace
    // leaves exactly one copy of the settlement.
    assert.equal(n1, EXPECTED_LINE_COUNT);
    assert.equal(n2, EXPECTED_LINE_COUNT);
    assert.equal(count1, EXPECTED_LINE_COUNT);
    assert.equal(count2, EXPECTED_LINE_COUNT);
    assert.equal(sum1, CONTROL_TOTAL_CENTS);
    assert.equal(sum2, CONTROL_TOTAL_CENTS);
  } finally {
    db.close();
  }
});

// ── Invariant 5: a failed/malformed parse cannot erase the prior settlement ─
test('a failed or malformed parse cannot erase the previously valid settlement', () => {
  const db = memDb();
  try {
    // Seed a known-good settlement.
    const good = parseSettlementLines(FIXTURE);
    replaceSettlementLines(db, good.settlementId, good.lines);
    const before = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents),0) AS s FROM settlement_transactions').get() as { c: number; s: number };
    assert.equal(before.c, EXPECTED_LINE_COUNT);
    assert.equal(before.s, CONTROL_TOTAL_CENTS);

    // (a) A re-ingest whose rows are malformed (a non-integer/NULL amount) must
    // throw and roll back atomically — the prior settlement is left intact.
    const malformed: SettlementLine[] = [
      { ...good.lines[0] },
      { ...good.lines[1], amountCents: null as unknown as number }, // violates NOT NULL
    ];
    assert.throws(() => replaceSettlementLines(db, SETTLEMENT_ID, malformed));

    const after = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents),0) AS s FROM settlement_transactions').get() as { c: number; s: number };
    assert.equal(after.c, EXPECTED_LINE_COUNT, 'rows not erased by failed replace');
    assert.equal(after.s, CONTROL_TOTAL_CENTS, 'total unchanged by failed replace');

    // (b) Truly malformed/unrecognized report content resolves no settlement-id,
    // so the reconciler is a no-op (it never deletes) — nothing can be erased.
    const garbage = parseSettlementLines('not\ta\tsettlement\njust noise');
    assert.equal(garbage.settlementId, null);
    assert.equal(garbage.lines.length, 0);
    assert.equal(replaceSettlementLines(db, garbage.settlementId, garbage.lines), 0);

    const stillThere = db.prepare('SELECT COUNT(*) AS c FROM settlement_transactions').get() as { c: number };
    assert.equal(stillThere.c, EXPECTED_LINE_COUNT, 'no-op reconcile cannot erase prior rows');
  } finally {
    db.close();
  }
});

// ── Invariant 5b (regression): no INVALID replacement can erase prior rows ──
// Reproduces the reported P1 and its siblings: a replace must reject bad input
// BEFORE the DELETE, leaving the previously valid settlement fully intact.
test('a valid-id-but-empty or invalid-row replacement preserves the prior settlement', () => {
  const HEADERS =
    'settlement-id\tsettlement-start-date\tsettlement-end-date\ttransaction-type\torder-id\tamount-type\tamount-description\tamount\tposted-date\tsku';

  function seeded() {
    const db = memDb();
    const good = parseSettlementLines(FIXTURE);
    replaceSettlementLines(db, good.settlementId, good.lines);
    return { db, good };
  }
  function assertIntact(db: ReturnType<typeof memDb>, label: string) {
    const r = db.prepare(
      'SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents),0) AS s FROM settlement_transactions',
    ).get() as { c: number; s: number };
    assert.equal(r.c, EXPECTED_LINE_COUNT, `${label}: rows not erased`);
    assert.equal(r.s, CONTROL_TOTAL_CENTS, `${label}: total unchanged`);
  }

  // (1) The exact reported P1: the settlement-id resolves from the metadata
  // columns, but every `amount` cell is non-numeric, so the parser drops every
  // row and returns ZERO lines under a VALID id. Replacing must be rejected —
  // not silently delete the 12 valid rows.
  {
    const ALL_MALFORMED =
      HEADERS + '\n' +
      'SETTLE-TEST-001\t2024-06-15 00:00:00 UTC\t2024-06-29 23:59:59 UTC\tOrder\t111-X\tPrincipal\tPrincipal\tNOT_A_NUMBER\t2024-06-20\tSKU-A\n' +
      'SETTLE-TEST-001\t2024-06-15 00:00:00 UTC\t2024-06-29 23:59:59 UTC\tOrder\t111-Y\tPrincipal\tPrincipal\tstill-not-a-number\t2024-06-21\tSKU-B\n';
    const parsed = parseSettlementLines(ALL_MALFORMED);
    assert.equal(parsed.settlementId, SETTLEMENT_ID, 'id still resolves from metadata');
    assert.equal(parsed.lines.length, 0, 'every malformed amount dropped → zero lines');

    const { db } = seeded();
    try {
      assert.throws(
        () => replaceSettlementLines(db, parsed.settlementId, parsed.lines),
        /zero parsed lines/,
        'valid-id-but-empty replace must throw before deleting',
      );
      assertIntact(db, 'empty-lines replace');
    } finally {
      db.close();
    }
  }

  // (2) A row whose settlement-id does not match the target is rejected before
  // the DELETE (it would otherwise smuggle a foreign row in under this id).
  {
    const { db, good } = seeded();
    try {
      const mismatched = good.lines.map((l, i) =>
        i === 3 ? { ...l, settlementId: 'OTHER-SETTLEMENT' } : { ...l },
      );
      assert.throws(
        () => replaceSettlementLines(db, SETTLEMENT_ID, mismatched),
        /does not match target/,
        'settlement-id mismatch must throw before deleting',
      );
      assertIntact(db, 'mismatched-id replace');
    } finally {
      db.close();
    }
  }

  // (3) A fractional (non-safe-integer) amountCents is rejected before the
  // DELETE — SQLite's INTEGER affinity would otherwise store a REAL 1.5.
  {
    const { db, good } = seeded();
    try {
      const fractional = good.lines.map((l, i) =>
        i === 5 ? { ...l, amountCents: 1.5 } : { ...l },
      );
      assert.throws(
        () => replaceSettlementLines(db, SETTLEMENT_ID, fractional),
        /safe integer/,
        'fractional amountCents must throw before deleting',
      );
      assertIntact(db, 'fractional-amount replace');
    } finally {
      db.close();
    }
  }
});

// ── Invariant 6: no test reads or writes data/flipledger.db ────────────────
test('no test reads or writes data/flipledger.db', () => {
  const db = memDb();
  try {
    // better-sqlite3 exposes the backing filename; an in-memory db is ':memory:'.
    assert.equal(db.name, ':memory:');
  } finally {
    db.close();
  }
  // The production path that this harness deliberately avoids:
  assert.ok(getFlipLedgerDbPath().endsWith(path.join('data', 'flipledger.db')));
});

// ── Invariant 7: the SHARED op used by production (replaceSettlementReport) ──
// This is the exact entry point reports.ts now calls — proving production and
// the harness run one implementation, not a mirror copy.
test('replaceSettlementReport (the production entry point) stores, replays, and protects prior rows', () => {
  function totals(db: ReturnType<typeof memDb>) {
    return db.prepare(
      'SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents),0) AS s FROM settlement_transactions',
    ).get() as { c: number; s: number };
  }

  // Stores the 12 fixture rows totaling 3,649¢.
  {
    const db = memDb();
    try {
      const r = replaceSettlementReport(db, FIXTURE);
      assert.equal(r.settlementId, SETTLEMENT_ID);
      assert.equal(r.replaced, EXPECTED_LINE_COUNT);
      const t = totals(db);
      assert.equal(t.c, EXPECTED_LINE_COUNT, 'all 12 rows stored');
      assert.equal(t.s, CONTROL_TOTAL_CENTS, 'stored total is 3,649¢');
    } finally {
      db.close();
    }
  }

  // Replays identically — re-running the same report leaves exactly one copy.
  {
    const db = memDb();
    try {
      replaceSettlementReport(db, FIXTURE);
      replaceSettlementReport(db, FIXTURE);
      const t = totals(db);
      assert.equal(t.c, EXPECTED_LINE_COUNT, 'replay does not duplicate');
      assert.equal(t.s, CONTROL_TOTAL_CENTS, 'replay total unchanged');
    } finally {
      db.close();
    }
  }

  // Preserves prior rows when given valid metadata with ZERO valid amount rows.
  // This is the production-level proof of the P1 fix: a settlement-id resolves
  // from the metadata columns, but every `amount` is non-numeric, so the parse
  // yields zero lines and the replace must THROW instead of erasing the prior 12.
  {
    const HEADERS =
      'settlement-id\tsettlement-start-date\tsettlement-end-date\ttransaction-type\torder-id\tamount-type\tamount-description\tamount\tposted-date\tsku';
    const ALL_MALFORMED =
      HEADERS + '\n' +
      'SETTLE-TEST-001\t2024-06-15 00:00:00 UTC\t2024-06-29 23:59:59 UTC\tOrder\t111-X\tPrincipal\tPrincipal\tNOT_A_NUMBER\t2024-06-20\tSKU-A\n' +
      'SETTLE-TEST-001\t2024-06-15 00:00:00 UTC\t2024-06-29 23:59:59 UTC\tOrder\t111-Y\tPrincipal\tPrincipal\tstill-not-a-number\t2024-06-21\tSKU-B\n';

    const db = memDb();
    try {
      replaceSettlementReport(db, FIXTURE); // seed the good 12 rows
      assert.throws(
        () => replaceSettlementReport(db, ALL_MALFORMED),
        /zero parsed lines/,
        'all-malformed report must throw, not erase',
      );
      const t = totals(db);
      assert.equal(t.c, EXPECTED_LINE_COUNT, 'prior rows preserved');
      assert.equal(t.s, CONTROL_TOTAL_CENTS, 'prior total preserved');
    } finally {
      db.close();
    }
  }
});

// ── Invariant 8: blank amount cells are skipped, not coerced to a now()-stamped
// zero-cent row (the nondeterministic drift the real-data shadow replay found) ─
const BLANK_HEADERS =
  'settlement-id\tsettlement-start-date\tsettlement-end-date\ttransaction-type\torder-id\tamount-type\tamount-description\tamount\tposted-date\tsku';
const META = 'SETTLE-TEST-001\t2024-06-15 00:00:00 UTC\t2024-06-29 23:59:59 UTC';

test('a blank amount with a missing posted-date is skipped and never triggers now()', () => {
  // Row A: a real transaction WITH a posted-date.
  // Row B: the drifting row — blank identity fields, blank amount, blank posted-date.
  const tsv =
    BLANK_HEADERS + '\n' +
    `${META}\tOrder\t111-A\tPrincipal\tPrincipal\t25.00\t2024-06-20\tSKU-A\n` +
    `${META}\t\t\t\t\t\t\t\n`; // tt, order, amount-type, desc, amount, posted-date, sku all blank

  let nowCalls = 0;
  const spyNow = () => { nowCalls++; return '2099-01-01T00:00:00.000Z'; };

  const { settlementId, lines } = parseSettlementLines(tsv, spyNow);
  assert.equal(settlementId, 'SETTLE-TEST-001');
  assert.equal(lines.length, 1, 'blank-amount row is skipped — only the real row survives');
  assert.equal(lines[0].amountCents, 2500);
  // The blank row never reaches the posted-date fallback, and the real row has
  // its own posted-date, so the injected now() is never called.
  assert.equal(nowCalls, 0, 'now() must not be called for the skipped blank row');
});

test('an explicit "0.00" amount remains a valid, deterministic zero-cent row', () => {
  const tsv =
    BLANK_HEADERS + '\n' +
    `${META}\tOrder\t111-A\tPrincipal\tPrincipal\t25.00\t2024-06-20\tSKU-A\n` +
    `${META}\tother-transaction\t\t\tFBA Inventory Reimbursement\t0.00\t2024-06-22\t\n`;

  // Explicit zero is preserved (not skipped like a blank), with its real
  // posted-date — so it is fully deterministic across repeated parses.
  const a = parseSettlementLines(tsv, () => 'SENTINEL');
  const b = parseSettlementLines(tsv, () => 'SENTINEL');
  assert.deepEqual(a, b, 'explicit-zero parse is deterministic');
  assert.equal(a.lines.length, 2, 'explicit "0.00" is kept as a real row');
  const zeroRow = a.lines.find(l => l.amountCents === 0);
  assert.ok(zeroRow, 'the 0.00 row is present with amountCents === 0');
  assert.equal(zeroRow!.postedDate, '2024-06-22', 'uses its real posted-date, not now()');
});

test('a non-numeric (non-blank) amount is still rejected', () => {
  const tsv =
    BLANK_HEADERS + '\n' +
    `${META}\tOrder\t111-A\tPrincipal\tPrincipal\t25.00\t2024-06-20\tSKU-A\n` +
    `${META}\tOrder\t111-B\tPrincipal\tPrincipal\tNOT_A_NUMBER\t2024-06-21\tSKU-B\n`;
  const { lines } = parseSettlementLines(tsv);
  assert.equal(lines.length, 1, 'non-numeric amount row dropped');
  assert.equal(lines[0].amountCents, 2500);
});
