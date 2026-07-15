import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getUnpreparedFbaSkus,
  isFbaSendReady,
  type ListingSendReadinessItem,
} from '../src/lib/listing-send-readiness';

test('new FBA MSKUs without FNSKU must be prepared before send', () => {
  const items: ListingSendReadinessItem[] = [
    { sku: 'new-pending', listingMode: 'CREATE_NEW', listingStatus: 'PROCESSING', fnsku: null },
    { sku: 'new-empty', listingMode: 'CREATE_NEW', listingStatus: null, fnsku: '' },
    { sku: 'new-active-no-fnsku', listingMode: 'CREATE_NEW', listingStatus: 'ACTIVE', fnsku: null },
  ];

  assert.deepEqual(getUnpreparedFbaSkus(items), ['new-pending', 'new-empty', 'new-active-no-fnsku']);
  assert.equal(isFbaSendReady(items), false);
});

test('replenishment and already-prepared FBA MSKUs can send', () => {
  const items: ListingSendReadinessItem[] = [
    { sku: 'replenish', listingMode: 'REPLENISH_EXISTING', listingStatus: 'PROCESSING', fnsku: null },
    { sku: 'new-active', listingMode: 'CREATE_NEW', listingStatus: 'ACTIVE', fnsku: 'X001ACTIVE' },
    { sku: 'new-fnsku', listingMode: 'CREATE_NEW', listingStatus: 'PROCESSING', fnsku: 'X001READY' },
  ];

  assert.deepEqual(getUnpreparedFbaSkus(items), []);
  assert.equal(isFbaSendReady(items), true);
});
