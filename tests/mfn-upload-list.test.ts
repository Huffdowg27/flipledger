import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInventoryLoaderCsv,
  buildMfnUploadList,
  normalizeAirtableMfnRow,
} from '../src/lib/mfn-upload-list';

test('normalizes an Airtable MFN row into an upload-list row', () => {
  const row = normalizeAirtableMfnRow({
    id: 'rec123',
    fields: {
      Product: 'Staples Arc Desktop Paper Punch',
      ASIN: 'B00BJH0M3I',
      '\ufeffSeller Sku': 'LV_01RCFLIP_051126_69.05_125_1_609',
      'Order QTY': 1,
      Cost: 69.05,
      SalesPrice: 125,
      MFN: true,
      Received: true,
      'IL Upload MF': false,
      'item-condition': 11,
      'Shipping Template': 'Migrated Template',
    },
  });

  assert.equal(row.airtableRecordId, 'rec123');
  assert.equal(row.title, 'Staples Arc Desktop Paper Punch');
  assert.equal(row.asin, 'B00BJH0M3I');
  assert.equal(row.sku, 'LV_01RCFLIP_051126_69.05_125_1_609');
  assert.equal(row.quantity, 1);
  assert.equal(row.priceCents, 12500);
  assert.equal(row.costCents, 6905);
  assert.equal(row.conditionCode, '11');
  assert.equal(row.shippingTemplate, 'Migrated Template');
});

test('builds a ready list and blocks rows missing required upload fields', () => {
  const result = buildMfnUploadList([
    normalizeAirtableMfnRow({
      id: 'ready',
      fields: {
        Product: 'Ready Item',
        ASIN: 'B000READY1',
        'Seller Sku': 'ready-sku',
        'Order QTY': 2,
        Cost: 10,
        SalesPrice: 24.99,
        MFN: true,
        Received: true,
        'IL Upload MF': false,
        'item-condition': 11,
      },
    }),
    normalizeAirtableMfnRow({
      id: 'blocked',
      fields: {
        Product: 'Blocked Item',
        'Seller Sku': 'blocked-sku',
        'Order QTY': 1,
        SalesPrice: 19.99,
        MFN: true,
        Received: true,
      },
    }),
  ]);

  assert.equal(result.summary.totalRows, 2);
  assert.equal(result.summary.readyRows, 1);
  assert.equal(result.summary.blockedRows, 1);
  assert.equal(result.ready[0].sku, 'ready-sku');
  assert.deepEqual(result.blocked[0].blockingReasons, ['Missing ASIN / product-id']);
});

test('exports ready rows as an Inventory Loader style CSV with escaping', () => {
  const result = buildMfnUploadList([
    normalizeAirtableMfnRow({
      id: 'rec1',
      fields: {
        Product: 'Widget, Large',
        ASIN: 'B000CSV001',
        'Seller Sku': 'sku,with,commas',
        'Order QTY': 3,
        Cost: 5.5,
        SalesPrice: 15,
        MFN: true,
        Received: true,
        'item-condition': 11,
        'add-delete': 'a',
        'fulfillment-center-id': 'DEFAULT',
      },
    }),
  ]);

  const csv = buildInventoryLoaderCsv(result.ready);

  assert.match(csv, /^sku,product-id,product-id-type,price,item-condition,quantity,add-delete,fulfillment-center-id,merchant_shipping_group_name/m);
  assert.match(csv, /"sku,with,commas",B000CSV001,1,15.00,11,3,a,DEFAULT,/);
});
