import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  buildInboundPlanName,
  claimBatchForSend,
  compareInboundPlanManifest,
  selectRecoverableInboundPlan,
} from '../src/lib/inbound-plan-recovery';

test('inbound plan names are stable, batch-scoped, and within Amazon limit', () => {
  const first = buildInboundPlanName(42, '  July   retail arbitrage 🚀 batch with a long name  ');
  const second = buildInboundPlanName(42, '  July   retail arbitrage 🚀 batch with a long name  ');

  assert.equal(first, second);
  assert.match(first, /^FL-42-/);
  assert.ok(first.length <= 40);
  assert.doesNotMatch(first, /🚀/);
  assert.notEqual(first, buildInboundPlanName(43, 'July retail arbitrage batch'));
});

test('recovery finds one exact active plan and fails closed on ambiguity', () => {
  const expectedName = buildInboundPlanName(42, 'July batch');
  const base = {
    name: expectedName,
    status: 'ACTIVE',
  };

  assert.deepEqual(selectRecoverableInboundPlan([], expectedName), { kind: 'none' });
  assert.deepEqual(
    selectRecoverableInboundPlan([
      { ...base, inboundPlanId: 'PLAN-1' },
      { ...base, inboundPlanId: 'VOID', status: 'VOIDED' },
      { ...base, inboundPlanId: 'OTHER', name: 'Other batch' },
    ], expectedName),
    {
      kind: 'found',
      plan: { ...base, inboundPlanId: 'PLAN-1' },
    },
  );

  const ambiguous = selectRecoverableInboundPlan([
    { ...base, inboundPlanId: 'PLAN-1' },
    { ...base, inboundPlanId: 'PLAN-2' },
  ], expectedName);
  assert.equal(ambiguous.kind, 'ambiguous');
});

test('only one concurrent sender can claim a draft batch', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE listing_batches (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      send_error TEXT,
      sent_at TEXT,
      updated_at TEXT
    );
    INSERT INTO listing_batches (id, status) VALUES (42, 'draft');
  `);

  assert.equal(claimBatchForSend(db, 42, '2026-07-01T12:00:00.000Z'), true);
  assert.equal(claimBatchForSend(db, 42, '2026-07-01T12:00:01.000Z'), false);
  assert.deepEqual(
    db.prepare('SELECT status, sent_at FROM listing_batches WHERE id = 42').get(),
    {
      status: 'sending',
      sent_at: '2026-07-01T12:00:00.000Z',
    },
  );
  db.close();
});

test('recovery requires Amazon plan contents to match the local batch exactly', () => {
  assert.deepEqual(compareInboundPlanManifest(
    [
      { msku: 'SKU-B', quantity: 2 },
      { msku: 'SKU-A', quantity: 1 },
    ],
    [
      { msku: 'SKU-A', quantity: 1 },
      { msku: 'SKU-B', quantity: 1 },
      { msku: 'SKU-B', quantity: 1 },
    ],
  ), { ok: true });

  const mismatch = compareInboundPlanManifest(
    [{ msku: 'SKU-A', quantity: 2 }],
    [{ msku: 'SKU-A', quantity: 1 }],
  );
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.match(mismatch.error, /do not match/);
});
