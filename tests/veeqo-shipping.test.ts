import test from 'node:test';
import assert from 'node:assert/strict';

import { parseVeeqoShippingCsv } from '../src/lib/imports/veeqo-shipping';

// NOTE: all order IDs / tracking numbers below are synthetic — never real data.
const HEADER =
  'Shipped Date,Store,Order ID,Carrier,Service,Total Label Cost,Currency,Tracking ID,Tracking Status';

test('parses MFN rows with a label cost and skips FBA/no-cost rows', () => {
  const csv = [
    HEADER,
    '2026-06-08 09:18:55,Example Store,111-1111111-1111111,Buy Shipping - USPS,USPS Ground Advantage,6.98,USD,TRK1,created',
    '2026-06-08 00:21:30,Example Store FBA,222-2222222-2222222,Other,,,,,created', // FBA, no cost
    '2026-06-08 09:30:56,Example Store,333-3333333-3333333,Buy Shipping - UPS,UPS Ground,13.37,USD,TRK2,created',
  ].join('\n');

  const r = parseVeeqoShippingCsv(csv);
  assert.equal(r.globalErrors.length, 0);
  assert.equal(r.rows.length, 2);
  assert.equal(r.skippedNoCost, 1);
  assert.deepEqual(
    r.rows.map((x) => [x.orderId, x.costCents]),
    [['111-1111111-1111111', 698], ['333-3333333-3333333', 1337]],
  );
  assert.equal(r.rows[0].shippedDate, '2026-06-08');
  assert.equal(r.rows[0].carrier, 'Buy Shipping - USPS');
});

test('handles quoted fields with embedded commas and $/comma in cost', () => {
  const csv = [
    HEADER,
    '2026-06-08,Store,444-4444444-4444444,"Buy Shipping, USPS","USPS Ground Advantage (1 - 70 lb)","$1,234.50",USD,TRK3,created',
  ].join('\n');
  const r = parseVeeqoShippingCsv(csv);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].costCents, 123450);
  assert.equal(r.rows[0].carrier, 'Buy Shipping, USPS');
});

test('flags non-USD currency and missing required columns', () => {
  const eur = parseVeeqoShippingCsv([HEADER, '2026-06-08,S,555-5555555-5555555,UPS,Gnd,5.00,EUR,T,created'].join('\n'));
  assert.deepEqual(eur.nonUsdCurrency, ['EUR']);

  const bad = parseVeeqoShippingCsv('Foo,Bar\n1,2');
  assert.ok(bad.globalErrors.some((e) => e.includes('Order ID')));
  assert.ok(bad.globalErrors.some((e) => e.includes('Total Label Cost')));
  assert.equal(bad.rows.length, 0);
});

test('a cost with no order id is an error, not a silent drop', () => {
  const r = parseVeeqoShippingCsv([HEADER, '2026-06-08,S,,UPS,Gnd,5.00,USD,T,created'].join('\n'));
  assert.equal(r.rows.length, 0);
  assert.ok(r.globalErrors.some((e) => e.toLowerCase().includes('no order id')));
});
