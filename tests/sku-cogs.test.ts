import test from 'node:test';
import assert from 'node:assert/strict';

import { extractCogsFromSku, isCogsEncodedSku } from '../src/lib/sku-cogs';

test('extracts COGS cents from bare LV_/ZTPC_ SKUs', () => {
  assert.equal(extractCogsFromSku('LV_01FAFLIP_030226_22.5_52_3_P_212'), 2250);
  assert.equal(extractCogsFromSku('ZTPC_01X_010126_9.99_30_2_P_1'), 999);
});

test('unwraps amzn.gr. global prefix to read embedded cost (audit F2)', () => {
  // Amazon wraps the seller SKU and appends a -XXXX suffix on the value segment.
  assert.equal(extractCogsFromSku('amzn.gr.LV_01AFLIP_112025_17.9-JcSyVV-LN'), 1790);
  assert.equal(extractCogsFromSku('amzn.gr.LV_01FAFLIP_100924_92.-Ry8DNG-LN'), 9200);
  assert.equal(isCogsEncodedSku('amzn.gr.LV_01AFLIP_112025_17.9-JcSyVV-LN'), true);
});

test('returns 0 / false for non-encoded SKUs', () => {
  assert.equal(extractCogsFromSku('Nintendo_2026-05-30_0_22.97_1068'), 0);
  assert.equal(extractCogsFromSku('B00ABCDEF0'), 0);
  assert.equal(extractCogsFromSku(null), 0);
  assert.equal(extractCogsFromSku(''), 0);
  assert.equal(isCogsEncodedSku('Nintendo_2026-05-30_0_22.97_1068'), false);
});

test('ignores non-positive or unparseable encoded values', () => {
  assert.equal(extractCogsFromSku('LV_X_Y_0_'), 0);
  assert.equal(extractCogsFromSku('LV_X_Y_abc_'), 0);
});
