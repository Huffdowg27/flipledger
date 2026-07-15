import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { buildAsinLabelPdf, MAX_COPIES_PER_SPEC } from '../src/lib/asin-labels';

test('builds a valid PDF with one 2x1 page per copy', async () => {
  const pdf = await buildAsinLabelPdf([
    { asin: 'B0C4LSNFWL', title: 'Transformers Legacy: Evolution G2 Universe Toxitron', condition: 'New', bin: 'S1-B3', copies: 3 },
    { asin: 'B000000001', copies: 2 },
  ]);

  assert.equal(pdf.subarray(0, 4).toString('latin1'), '%PDF');
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 5);
  const { width, height } = doc.getPage(0).getSize();
  assert.equal(width, 144);  // 2" at 72pt/in
  assert.equal(height, 72);  // 1"
});

test('handles missing title, condition, and bin', async () => {
  const pdf = await buildAsinLabelPdf([{ asin: 'B0TESTONLY' }]);
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 1);
});

test('clamps copies to the per-spec cap and floors bad values to 1', async () => {
  const over = await buildAsinLabelPdf([{ asin: 'B0TESTONLY', copies: 999 }]);
  assert.equal((await PDFDocument.load(over)).getPageCount(), MAX_COPIES_PER_SPEC);

  const bad = await buildAsinLabelPdf([
    { asin: 'B0TESTONLY', copies: 0 },
    { asin: 'B0TESTONLY', copies: Number.NaN },
  ]);
  assert.equal((await PDFDocument.load(bad)).getPageCount(), 2);
});
