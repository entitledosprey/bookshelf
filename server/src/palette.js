import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { seedFrom, rngFrom } from './seed.js';

/**
 * Cover -> spine colours, in pure JavaScript.
 *
 * Deliberately NOT using: sharp, canvas, @napi-rs/canvas (native modules --
 * wrong architecture after the $BUILDPLATFORM node_modules copy), nor
 * node-vibrant / get-image-colors (which depend on those). jpeg-js and pngjs
 * are pure JS, and a 320x475 cover decodes in about a millisecond.
 *
 * Bump PALETTE_VERSION to force a recompute across the library.
 */
export const PALETTE_VERSION = 1;

/**
 * Cloth binding hues for covers that have no usable colour of their own.
 * Grayscale covers are very common (classics, Penguin and Vintage reissues,
 * photographic jackets) and a shelf of forty grey slabs reads as a rendering
 * bug. Real cloth cases on those editions are not grey either, so a seeded
 * bindery hue is both better looking and arguably more faithful. Always
 * recorded as palette_source='grayscale-cloth' so it stays auditable.
 */
export const CLOTH_HUES = [
  '#6b2b2b', // oxblood
  '#24432f', // forest
  '#22304d', // navy
  '#8a6a24', // ochre
  '#414a52', // slate
  '#4a2c47', // aubergine
  '#7a5a3a', // tan
  '#2f4650', // teal
];

/* ── colour helpers ─────────────────────────────────────────────────────── */

export const hex = ({ r, g, b }) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

export function unhex(s) {
  const m = String(s).replace('#', '');
  return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16) };
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(typeof a === 'string' ? unhex(a) : a);
  const lb = relativeLuminance(typeof b === 'string' ? unhex(b) : b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function rgbToHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
  else if (max === G) h = ((B - R) / d + 2) / 6;
  else h = ((R - G) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function hslToRgb({ h, s, l }) {
  const H = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    let T = t; if (T < 0) T += 1; if (T > 1) T -= 1;
    if (T < 1 / 6) return p + (q - p) * 6 * T;
    if (T < 1 / 2) return q;
    if (T < 2 / 3) return p + (q - p) * (2 / 3 - T) * 6;
    return p;
  };
  return { r: f(H + 1 / 3) * 255, g: f(H) * 255, b: f(H - 1 / 3) * 255 };
}

/* ── decoding ───────────────────────────────────────────────────────────── */

/** @returns {{width:number,height:number,data:Uint8Array}|null} RGBA. Never throws. */
export function decodeImage(buffer, contentType = '') {
  if (!buffer || buffer.length < 32) return null;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
  const isJpg = buffer[0] === 0xff && buffer[1] === 0xd8;
  try {
    if (isPng || /png/i.test(contentType)) {
      const png = PNG.sync.read(Buffer.from(buffer));
      return { width: png.width, height: png.height, data: png.data };
    }
    if (isJpg || /jpe?g/i.test(contentType)) {
      const img = jpeg.decode(Buffer.from(buffer), {
        useTArray: true, formatAsRGBA: true,
        maxResolutionInMP: 32, maxMemoryUsageInMB: 128,
      });
      return { width: img.width, height: img.height, data: img.data };
    }
  } catch {
    return null;
  }
  return null;
}

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] };
};

/* ── border trim ────────────────────────────────────────────────────────── */

/**
 * Covers very often sit inside a white or black border, and an untrimmed
 * dominant-colour pass then returns white for half the library. Two defences:
 * trim uniform near-white/near-black edge lines (capped at 15% a side so a
 * genuinely white cover is not eaten), then exclude the outer ring when
 * sampling.
 */
export function trimUniformBorder(img) {
  const maxTrimX = Math.floor(img.width * 0.15);
  const maxTrimY = Math.floor(img.height * 0.15);

  const lineIsBorder = (pts) => {
    let extreme = 0;
    for (const p of pts) {
      const l = relativeLuminance(p);
      if (l > 0.88 || l < 0.03) extreme += 1;
    }
    return extreme / pts.length >= 0.9;
  };
  const row = (y) => Array.from({ length: img.width }, (_, x) => px(img, x, y));
  const col = (x) => Array.from({ length: img.height }, (_, y) => px(img, x, y));

  let top = 0, bottom = img.height - 1, left = 0, right = img.width - 1;
  while (top < bottom && top < maxTrimY && lineIsBorder(row(top))) top += 1;
  while (bottom > top && img.height - 1 - bottom < maxTrimY && lineIsBorder(row(bottom))) bottom -= 1;
  while (left < right && left < maxTrimX && lineIsBorder(col(left))) left += 1;
  while (right > left && img.width - 1 - right < maxTrimX && lineIsBorder(col(right))) right -= 1;

  return { x: left, y: top, w: Math.max(1, right - left + 1), h: Math.max(1, bottom - top + 1) };
}

/** Nearest-neighbour downsample inside `box`, skipping the outer 8% ring. */
export function samplePixels(img, box, target = 72) {
  const inset = 0.08;
  const x0 = box.x + box.w * inset, y0 = box.y + box.h * inset;
  const w = box.w * (1 - inset * 2), h = box.h * (1 - inset * 2);
  const cols = Math.max(1, Math.min(target, Math.round(w)));
  const rows = Math.max(1, Math.min(target, Math.round(h)));
  const out = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const x = Math.min(img.width - 1, Math.round(x0 + (i / cols) * w));
      const y = Math.min(img.height - 1, Math.round(y0 + (j / rows) * h));
      const p = px(img, x, y);
      // centrality: share of weight for pixels in the middle third
      p.central = i > cols / 3 && i < (cols * 2) / 3 && j > rows / 3 && j < (rows * 2) / 3;
      out.push(p);
    }
  }
  return out;
}

/* ── clustering ─────────────────────────────────────────────────────────── */

/**
 * Median cut, k buckets.
 *
 * Chosen over k-means deliberately: this value is STORED, and k-means needs a
 * seed and an iteration count, so identical input could produce different
 * stored output between runs. Median cut is deterministic, which is directly
 * unit-testable and saves an afternoon of chasing a phantom bug.
 *
 * Cuts along the perceptually weighted axis of greatest extent so green never
 * dominates the splits.
 */
export function medianCut(pixels, k = 5) {
  if (!pixels.length) return [];
  const W = { r: 0.299, g: 0.587, b: 0.114 };
  let boxes = [pixels];

  while (boxes.length < k) {
    let bestIdx = -1;
    let bestExtent = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i].length < 2) continue;
      for (const ch of ['r', 'g', 'b']) {
        let lo = 255, hi = 0;
        for (const p of boxes[i]) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch]; }
        const extent = (hi - lo) * W[ch];
        if (extent > bestExtent) { bestExtent = extent; bestIdx = i; }
      }
    }
    if (bestIdx < 0 || bestExtent <= 0) break;

    const box = boxes[bestIdx];
    let axis = 'r', axisExtent = -1;
    for (const ch of ['r', 'g', 'b']) {
      let lo = 255, hi = 0;
      for (const p of box) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch]; }
      const e = (hi - lo) * W[ch];
      if (e > axisExtent) { axisExtent = e; axis = ch; }
    }
    const sorted = [...box].sort((a, b) => a[axis] - b[axis] || a.r - b.r || a.g - b.g || a.b - b.b);
    const mid = Math.floor(sorted.length / 2);
    boxes.splice(bestIdx, 1, sorted.slice(0, mid), sorted.slice(mid));
    boxes = boxes.filter((b) => b.length > 0);
  }

  const total = pixels.length;
  return boxes
    .map((box) => {
      let r = 0, g = 0, b = 0, central = 0;
      for (const p of box) { r += p.r; g += p.g; b += p.b; if (p.central) central += 1; }
      const color = { r: r / box.length, g: g / box.length, b: b / box.length };
      return {
        color,
        weight: box.length / total,
        centrality: box.length ? central / box.length : 0,
        hsl: rgbToHsl(color),
      };
    })
    .sort((a, b) => b.weight - a.weight);
}

/* ── the palette ────────────────────────────────────────────────────────── */

function clothPalette(bookId, lightness = null) {
  const rnd = rngFrom(seedFrom(`cloth:${bookId}`));
  const base = unhex(CLOTH_HUES[Math.floor(rnd() * CLOTH_HUES.length)]);
  const h = rgbToHsl(base);
  // Preserve the cover's own lightness when we have it, so a bright
  // photographic jacket does not become a dark cloth case.
  const l = lightness == null ? h.l : Math.max(0.12, Math.min(0.62, lightness * 0.8 + h.l * 0.2));
  return hslToRgb({ h: h.h, s: h.s, l });
}

/** Pick spine lettering by measured contrast rather than by guessing. */
function pickText(bg, accent) {
  const bgHsl = rgbToHsl(bg);
  const candidates = [
    accent,
    { r: 255, g: 255, b: 255 },
    hslToRgb({ h: bgHsl.h, s: Math.min(0.25, bgHsl.s), l: 0.95 }),
    hslToRgb({ h: bgHsl.h, s: Math.min(0.5, bgHsl.s), l: 0.12 }),
  ];
  for (const c of candidates) if (contrastRatio(c, bg) >= 4.5) return c;
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 11, g: 11, b: 11 };
  return contrastRatio(white, bg) >= contrastRatio(black, bg) ? white : black;
}

/**
 * @returns {{bg:string,accent:string,fg:string,swatches:string[],
 *            isDark:boolean,isGrayscale:boolean,source:string}}
 */
export function extractPalette(buffer, contentType, bookId, binding = 'unknown') {
  const img = decodeImage(buffer, contentType);

  // Any failure still yields a usable spine: no book is ever unrendered, and
  // the shelf never has a hole in it.
  if (!img || img.width < 16 || img.height < 16) {
    return hashPalette(bookId, binding);
  }

  const box = trimUniformBorder(img);
  const pixels = samplePixels(img, box);
  if (!pixels.length) return hashPalette(bookId, binding);

  // CMYK JPEGs without an Adobe APP14 marker decode inverted; a frame that is
  // almost entirely black or white is more likely broken than real.
  const meanL = pixels.reduce((a, p) => a + relativeLuminance(p), 0) / pixels.length;
  if (meanL < 0.004 || meanL > 0.985) return hashPalette(bookId, binding);

  const clusters = medianCut(pixels, 5);
  if (!clusters.length) return hashPalette(bookId, binding);

  const meanChroma =
    pixels.reduce((a, p) => a + (Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b)), 0) / pixels.length;
  const isGrayscale = meanChroma < 10;

  let bg;
  let source;
  if (isGrayscale) {
    bg = clothPalette(bookId, rgbToHsl(clusters[0].color).l);
    source = 'grayscale-cloth';
  } else {
    // Favour the ink over the paper: population, but weighted by saturation and
    // by how central the cluster is, and penalised at the lightness extremes.
    const score = (c) => {
      const sat = Math.min(1, c.hsl.s / 0.5);
      const extreme = c.hsl.l > 0.9 ? (c.hsl.l - 0.9) * 6 : c.hsl.l < 0.06 ? (0.06 - c.hsl.l) * 6 : 0;
      return c.weight ** 0.75 * (0.45 + 0.55 * sat) * (1 + c.centrality * 0.35) * (1 - Math.min(0.9, extreme));
    };
    const best = [...clusters].sort((a, b) => score(b) - score(a))[0];
    const h = rgbToHsl(best.color);
    // A near-white spine reads as a GAP on the shelf and a pure black one as a
    // hole punched in it, so clamp into a printable range and add a seeded
    // nudge so two black-jacketed neighbours are not pixel-identical.
    const jitter = (rngFrom(seedFrom(`l:${bookId}`))() - 0.5) * 0.04;
    const l = Math.max(0.1, Math.min(0.82, h.l + jitter));
    bg = hslToRgb({ h: h.h, s: h.s, l });
    source = 'image';
  }

  // Accent: the cluster furthest in chroma with a real lightness gap. If none
  // qualifies, synthesise one -- metallic for cased bindings, ink otherwise.
  const bgHsl = rgbToHsl(bg);
  let accent = null;
  let bestGap = 0;
  for (const c of clusters) {
    const gap = Math.abs(c.hsl.l - bgHsl.l);
    if (gap >= 0.25 && c.hsl.s >= 0.12 && gap > bestGap) { bestGap = gap; accent = c.color; }
  }
  if (!accent || isGrayscale) {
    const rnd = rngFrom(seedFrom(`accent:${bookId}`));
    const hard = binding === 'hardcover' || binding === 'oversize';
    if (hard && rnd() < 0.6) {
      accent = unhex(rnd() < 0.7 ? '#c9a227' : '#c9ccd1'); // gold / silver foil
    } else {
      const rot = (28 + rnd() * 14) * (rnd() < 0.5 ? -1 : 1);
      accent = hslToRgb({
        h: bgHsl.h + rot,
        s: Math.min(0.75, Math.max(0.3, bgHsl.s + 0.2)),
        l: bgHsl.l > 0.5 ? 0.2 : 0.82,
      });
    }
  }

  const fg = pickText(bg, accent);

  return {
    bg: hex(bg),
    accent: hex(accent),
    fg: hex(fg),
    swatches: clusters.slice(0, 5).map((c) => hex(c.color)),
    isDark: relativeLuminance(bg) < 0.2,
    isGrayscale,
    source,
  };
}

/** Last-resort palette derived purely from the book id. */
export function hashPalette(bookId, binding = 'unknown') {
  const bg = clothPalette(bookId);
  const bgHsl = rgbToHsl(bg);
  const rnd = rngFrom(seedFrom(`accent:${bookId}`));
  const hard = binding === 'hardcover' || binding === 'oversize';
  const accent = hard
    ? unhex(rnd() < 0.7 ? '#c9a227' : '#c9ccd1')
    : hslToRgb({ h: bgHsl.h + 32, s: 0.4, l: 0.85 });
  return {
    bg: hex(bg),
    accent: hex(accent),
    fg: hex(pickText(bg, accent)),
    swatches: [hex(bg)],
    isDark: relativeLuminance(bg) < 0.2,
    isGrayscale: false,
    source: 'hash',
  };
}
