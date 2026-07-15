import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIncomingBulkReconciliation } from '../src/lib/incoming-bulk-reconcile';

const baseRow = {
  id: 1,
  sku: 'SKU-1',
  quantity: 2,
  quantityReceived: 0,
  orderedAt: '2026-07-01',
  skuInSellerCentral: true,
  liveSkusForAsin: [],
};

const baseCandidate = {
  inventoryLedgerId: 10,
  sku: 'SKU-1',
  availableToReconcile: 2,
  receivedAt: '2026-07-02T12:00:00Z',
  datePurchased: '2026-07-02',
};

test('classifies one exact SKU candidate with date and capacity as high-confidence', () => {
  const result = classifyIncomingBulkReconciliation(baseRow, [baseCandidate]);

  assert.deepEqual(result, {
    highConfidence: true,
    inventoryLedgerId: 10,
    quantity: 2,
    lotDate: '2026-07-02T12:00:00Z',
  });
});

test('disqualifies rows with multiple candidate lots', () => {
  const result = classifyIncomingBulkReconciliation(baseRow, [
    baseCandidate,
    { ...baseCandidate, inventoryLedgerId: 11 },
  ]);

  assert.equal(result.highConfidence, false);
  assert.equal(result.reason, 'multiple_candidates');
});

test('disqualifies SKU mismatch rows', () => {
  const result = classifyIncomingBulkReconciliation(
    {
      ...baseRow,
      skuInSellerCentral: false,
      liveSkusForAsin: [{ sku: 'SKU-LIVE', status: 'Active' }],
    },
    [baseCandidate],
  );

  assert.equal(result.highConfidence, false);
  assert.equal(result.reason, 'sku_mismatch');
});

test('disqualifies non-exact SKU candidates', () => {
  const result = classifyIncomingBulkReconciliation(baseRow, [
    { ...baseCandidate, sku: 'SKU-OTHER' },
  ]);

  assert.equal(result.highConfidence, false);
  assert.equal(result.reason, 'sku_not_exact');
});

test('disqualifies lots received before the incoming order date', () => {
  const result = classifyIncomingBulkReconciliation(baseRow, [
    { ...baseCandidate, receivedAt: '2026-06-30T12:00:00Z', datePurchased: '2026-06-30' },
  ]);

  assert.equal(result.highConfidence, false);
  assert.equal(result.reason, 'lot_before_order');
});

test('disqualifies candidates without enough available units', () => {
  const result = classifyIncomingBulkReconciliation(baseRow, [
    { ...baseCandidate, availableToReconcile: 1 },
  ]);

  assert.equal(result.highConfidence, false);
  assert.equal(result.reason, 'insufficient_available');
});
