import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contrastRatio, relativeLuminance, medianCut, extractPalette, hashPalette,
  decodeImage, trimUniformBorder, samplePixels, unhex,
} from '../src/palette.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (f) => readFileSync(join(here, 'fixtures', f));

test('contrast ratio matches published WCAG vectors', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#767676', '#ffffff').toFixed(2), '4.54');
  assert.equal(contrastRatio('#ffffff', '#ffffff').toFixed(2), '1.00');
});

test('relative luminance is ordered', () => {
  assert.ok(relativeLuminance(unhex('#ffffff')) > relativeLuminance(unhex('#808080')));
  assert.ok(relativeLuminance(unhex('#808080')) > relativeLuminance(unhex('#000000')));
});

test('medianCut is deterministic', () => {
  // This value is STORED, so identical input must give byte-identical output.
  // k-means would need a seed and iteration count and could drift between runs.
  const pixels = Array.from({ length: 400 }, (_, i) => ({
    r: (i * 7) % 256, g: (i * 13) % 256, b: (i * 29) % 256, central: i % 3 === 0,
  }));
  assert.deepEqual(medianCut(pixels, 5), medianCut(pixels, 5));
});

test('medianCut returns weights summing to one', () => {
  const pixels = Array.from({ length: 100 }, (_, i) => ({ r: i, g: 255 - i, b: 128, central: false }));
  const total = medianCut(pixels, 5).reduce((a, c) => a + c.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('a white border does not become the spine colour', () => {
  // The single most common palette failure: without trimming, half a library
  // comes out white because covers sit inside a white frame.
  const p = extractPalette(fixture('cover-bordered.png'), 'image/png', '101', 'trade-paperback');
  const { r, g, b } = unhex(p.bg);
  assert.ok(r > 100 && g < 90 && b < 90, `expected a red field, got ${p.bg}`);
  assert.equal(p.source, 'image');
});

test('border trim finds the inner field', () => {
  const img = decodeImage(fixture('cover-bordered.png'), 'image/png');
  const box = trimUniformBorder(img);
  assert.ok(box.x >= 5 && box.y >= 5, `expected the 6px frame trimmed, got ${JSON.stringify(box)}`);
  assert.ok(samplePixels(img, box).length > 0);
});

test('grayscale covers get a seeded cloth hue, not a grey slab', () => {
  const p = extractPalette(fixture('cover-grayscale.png'), 'image/png', '102', 'hardcover');
  assert.equal(p.isGrayscale, true);
  assert.equal(p.source, 'grayscale-cloth');
  const { r, g, b } = unhex(p.bg);
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) > 12, `expected a real hue, got ${p.bg}`);
});

test('a real cover yields its real dominant colour', () => {
  // The NYRB edition of The Long Ships is red with gold type.
  const p = extractPalette(fixture('cover-real.jpg'), 'image/jpeg', '10081041', 'trade-paperback');
  const { r, g, b } = unhex(p.bg);
  assert.ok(r > 140 && r > g * 2 && r > b * 2, `expected red, got ${p.bg}`);
});

test('palette extraction is deterministic for the same book', () => {
  const buf = fixture('cover-real.jpg');
  assert.deepEqual(
    extractPalette(buf, 'image/jpeg', '10081041', 'trade-paperback'),
    extractPalette(buf, 'image/jpeg', '10081041', 'trade-paperback'),
  );
});

test('every palette meets WCAG 4.5:1 for its own lettering', () => {
  for (const [f, type, id] of [
    ['cover-bordered.png', 'image/png', '101'],
    ['cover-grayscale.png', 'image/png', '102'],
    ['cover-real.jpg', 'image/jpeg', '103'],
  ]) {
    const p = extractPalette(fixture(f), type, id);
    assert.ok(contrastRatio(p.fg, p.bg) >= 4.5,
      `${f}: ${p.fg} on ${p.bg} is ${contrastRatio(p.fg, p.bg).toFixed(2)}:1`);
  }
  assert.ok(contrastRatio(hashPalette('x').fg, hashPalette('x').bg) >= 4.5);
});

test('corrupt bytes fall back to a hash palette instead of throwing', () => {
  // No book is ever unrendered: the shelf must never have a hole in it.
  const p = extractPalette(Buffer.from('definitely not an image'), 'image/jpeg', '34');
  assert.equal(p.source, 'hash');
  assert.match(p.bg, /^#[0-9a-f]{6}$/);
  assert.equal(extractPalette(null, 'image/jpeg', '34').source, 'hash');
  assert.equal(decodeImage(Buffer.from('xx')), null);
});

test('hashPalette is stable across calls', () => {
  assert.deepEqual(hashPalette('34', 'hardcover'), hashPalette('34', 'hardcover'));
  assert.notDeepEqual(hashPalette('34', 'hardcover'), hashPalette('35', 'hardcover'));
});
