/**
 * Deterministic per-book randomness.
 *
 * Every "varied but deterministic" presentation choice -- spine layout, reading
 * direction, lean angle, cloth tint for grayscale covers -- derives from this.
 * Computed on the server and stored, so a book looks identical on every device
 * and every reload, and can never drift between client versions.
 */

/** xmur3: string -> 32-bit seed. */
export function seedFrom(str) {
  let h = 1779033703 ^ String(str).length;
  for (let i = 0; i < String(str).length; i += 1) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32: seed -> deterministic generator in [0,1). */
export function rngFrom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Eight curated spine treatments. Each is a CSS class that recolours and
 * repositions the SAME three custom properties (--spine-bg/-accent/-text), so
 * adding a style costs one class, not a combinatorial explosion.
 */
export const SPINE_STYLES = [
  'classic-serif-centred',
  'allcaps-sans-top',
  'stacked-slab',
  'banded-plate',
  'foil-rule',
  'publisher-footer',
  'two-tone-split',
  'cloth-stamped',
];

/**
 * Pick a spine style. Weighted so the shelf reads as a real mix rather than a
 * uniform eighth of each: plain treatments dominate, decorative ones are
 * accents. Hardcovers skew toward foil and cloth; paperbacks toward plates.
 */
export function pickSpineStyle(bookId, binding = 'unknown') {
  const r = rngFrom(seedFrom(`style:${bookId}`))();
  const hard = binding === 'hardcover' || binding === 'oversize';
  const table = hard
    ? [['cloth-stamped', 0.22], ['foil-rule', 0.2], ['classic-serif-centred', 0.2],
       ['publisher-footer', 0.12], ['allcaps-sans-top', 0.1], ['stacked-slab', 0.08],
       ['two-tone-split', 0.05], ['banded-plate', 0.03]]
    : [['classic-serif-centred', 0.24], ['allcaps-sans-top', 0.2], ['banded-plate', 0.16],
       ['publisher-footer', 0.12], ['stacked-slab', 0.1], ['two-tone-split', 0.08],
       ['foil-rule', 0.06], ['cloth-stamped', 0.04]];
  let acc = 0;
  for (const [name, w] of table) {
    acc += w;
    if (r < acc) return name;
  }
  return 'classic-serif-centred';
}
