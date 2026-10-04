import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhysicalDimensions as P, parseLength } from '../src/enrich/dimensions.js';
import { estimateGeometry, normalizeBinding } from '../src/enrich/geometry.js';

test('parses the common Open Library shapes', () => {
  assert.deepEqual(P('8.2 x 5.5 x 1.1 inches'), { heightMm: 208.3, widthMm: 139.7, thicknessMm: 27.9, confidence: 0.9 });
  assert.deepEqual(P('21 x 14 x 3 centimeters'), { heightMm: 210, widthMm: 140, thicknessMm: 30, confidence: 0.9 });
  assert.deepEqual(P('190 x 130 x 20 mm'), { heightMm: 190, widthMm: 130, thicknessMm: 20, confidence: 0.9 });
});

test('axis order varies in real records, so values are sorted', () => {
  // Thickness in the middle. Height is always the largest, thickness smallest.
  const r = P('6.14 x 0.98 x 9.21 inches');
  assert.equal(r.heightMm, 233.9);
  assert.equal(r.widthMm, 156);
  assert.equal(r.thicknessMm, 24.9);
});

test('two values give height and width with no thickness', () => {
  const r = P('9.1 x 6.1 inches');
  assert.equal(r.thicknessMm, null);
  assert.equal(r.heightMm, 231.1);
});

test('handles unicode multiplication signs, case and trailing punctuation', () => {
  const r = P('9.21 × 6.14 × 1.1 in.');
  assert.equal(r.heightMm, 233.9);
  assert.deepEqual(P('7.9 X 5.1 X 0.9 inches').thicknessMm, 22.9);
});

test('handles mixed fractions', () => {
  const r = P('8 1/2 x 11 inches');
  assert.equal(r.heightMm, 279.4);
  assert.equal(r.widthMm, 215.9);
});

test('rejects placeholder and impossible values outright', () => {
  // "1 x 1 x 1 inches" is a real placeholder in Open Library data. Rendering it
  // as a 25mm-tall book looks like a bug; an honest heuristic is better.
  assert.equal(P('1 x 1 x 1 inches'), null);
  assert.equal(P('500 x 400 x 200 mm'), null);
  assert.equal(P('garbage'), null);
  assert.equal(P(''), null);
  assert.equal(P(null), null);
});

test('parseLength normalises single lengths', () => {
  assert.equal(parseLength('24.00 cm'), 240);
  assert.equal(parseLength('240 mm'), 240);
  assert.ok(Math.abs(parseLength('9.5"') - 241.3) < 0.1);
  assert.equal(parseLength(''), null);
});

test('normalizeBinding maps the vocabulary of three different sources', () => {
  assert.equal(normalizeBinding('Mass Market Paperback'), 'mass-market');
  assert.equal(normalizeBinding('Hardcover'), 'hardcover');
  assert.equal(normalizeBinding('Kindle Edition'), 'ebook');
  assert.equal(normalizeBinding('Audible Audio'), 'audiobook');
  assert.equal(normalizeBinding('Paperback'), 'trade-paperback');
  assert.equal(normalizeBinding(''), 'unknown');
  // A measured height disambiguates the ambiguous "Paperback".
  assert.equal(normalizeBinding('Paperback', 174), 'mass-market');
});

test('geometry is monotonic in page count', () => {
  const thin = estimateGeometry({ pages: 150, binding: 'trade-paperback' });
  const fat = estimateGeometry({ pages: 900, binding: 'trade-paperback' });
  assert.ok(fat.thicknessMm > thin.thicknessMm);
});

test('geometry is clamped at both ends so a bad page count cannot break the shelf', () => {
  const absurd = estimateGeometry({ pages: 99999, binding: 'trade-paperback' });
  assert.ok(absurd.thicknessMm <= 70);
  // And never thicker than height/2.5: a book is not a cube.
  assert.ok(absurd.thicknessMm <= absurd.heightMm / 2.5);
  const tiny = estimateGeometry({ pages: 1, binding: 'trade-paperback' });
  assert.ok(tiny.thicknessMm >= 6);
});

test('confidence reports how much is measured versus estimated', () => {
  assert.equal(estimateGeometry({ pages: 300, binding: 'hardcover', heightMm: 240, thicknessMm: 30 }).confidence, 0.95);
  assert.equal(estimateGeometry({ pages: 300, binding: 'hardcover' }).confidence, 0.6);
  assert.equal(estimateGeometry({ binding: 'unknown' }).confidence, 0.2);
});

test('real dimensions are preferred over the heuristic', () => {
  const g = estimateGeometry({ pages: 300, binding: 'hardcover', heightMm: 210, widthMm: 140, thicknessMm: 19, source: 'openlibrary' });
  assert.equal(g.heightMm, 210);
  assert.equal(g.thicknessMm, 19);
  assert.equal(g.source, 'openlibrary');
});

test('ebooks and audiobooks do not get a fabricated paper thickness', () => {
  const e = estimateGeometry({ pages: 900, binding: 'ebook' });
  assert.ok(e.thicknessMm < 20, 'a 900-page Kindle edition is not 50mm of paper');
  const a = estimateGeometry({ pages: 900, binding: 'audiobook' });
  assert.ok(a.thicknessMm < 20);
});
