import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBuyListCsv } from '../src/lib/imports/airtable-buylist';

function csv(quantity: string): string {
  return [
    'ASIN,MSKU,Quantity,Cost,List Price',
    `B000TEST01,TEST-SKU,${quantity},10.00,25.00`,
  ].join('\n');
}

test('fractional Airtable quantities fail closed instead of becoming whole units', () => {
  const result = parseBuyListCsv(csv('1.5'));

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].quantity, 0);
  assert.deepEqual(result.rows[0].errors, ['Invalid quantity']);
  assert.equal(result.totals.validRowCount, 0);
  assert.equal(result.totals.totalUnits, 0);
});

test('integer-equivalent Airtable quantities retain supported formatting', () => {
  const decimalZero = parseBuyListCsv(csv('5.0'));
  const withUnits = parseBuyListCsv(csv('5 units'));

  assert.equal(decimalZero.rows[0].quantity, 5);
  assert.deepEqual(decimalZero.rows[0].errors, []);
  assert.equal(withUnits.rows[0].quantity, 5);
  assert.deepEqual(withUnits.rows[0].errors, []);
});

test('quantity parser rejects trailing numeric or punctuation garbage', () => {
  for (const quantity of ['5.2 units', '5abc', '5-0', '1,5']) {
    const result = parseBuyListCsv(csv(`"${quantity}"`));
    assert.equal(result.rows[0].quantity, 0, quantity);
    assert.ok(result.rows[0].errors.includes('Invalid quantity'), quantity);
  }
});
