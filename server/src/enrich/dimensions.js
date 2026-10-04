/**
 * Parsing physical dimensions out of free text.
 *
 * Open Library's `physical_dimensions` is a single human-written string whose
 * unit AND axis order both vary between records:
 *   "8.2 x 5.5 x 1.1 inches"   "21 x 14 x 3 centimeters"
 *   "190 x 130 x 20 mm"        "6.14 x 0.98 x 9.21 inches"  <- thickness in the middle
 *
 * Rather than trust the order, we sort the three values: for essentially every
 * book height >= width >= thickness, which disambiguates reliably. Landscape
 * art books come out portrait -- about a 1% cosmetic error, worth accepting.
 */

const UNIT_TO_MM = [
  [/\b(?:inch|inches|in)\b|["”]/, 25.4],
  [/\bcentimet(?:er|re)s?\b|\bcm\b/, 10],
  [/\bmillimet(?:er|re)s?\b|\bmm\b/, 1],
];

/** Parse one length, e.g. "24.00 cm", '9.5"', "240 mm". Returns mm or null. */
export function parseLength(raw) {
  const s = String(raw ?? '').toLowerCase().trim();
  if (!s) return null;
  const num = s.match(/(\d+(?:\.\d+)?)/);
  if (!num) return null;
  const v = Number(num[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  for (const [re, mult] of UNIT_TO_MM) if (re.test(s)) return v * mult;
  // No unit: infer from magnitude.
  if (v <= 15) return v * 25.4;
  if (v <= 60) return v * 10;
  return v;
}

/** Mixed fractions appear in older records: "8 1/2 x 11 inches". */
function toNumber(tok) {
  const mixed = tok.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = tok.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = Number(tok);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string} raw
 * @returns {{heightMm:number,widthMm:number,thicknessMm:number|null,confidence:number}|null}
 */
export function parsePhysicalDimensions(raw) {
  let s = String(raw ?? '').toLowerCase().trim();
  if (!s) return null;

  s = s.replace(/[×✕╳]/g, 'x').replace(/\s+/g, ' ').replace(/[.;,]+$/, '');

  let mult = null;
  for (const [re, m] of UNIT_TO_MM) if (re.test(s)) { mult = m; break; }

  const tokens = s.match(/\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?/g) ?? [];
  const nums = tokens.map(toNumber).filter((n) => n != null && n > 0);
  if (nums.length < 2) return null;

  let confidence = mult == null ? 0.5 : 0.9;
  if (mult == null) {
    const max = Math.max(...nums);
    mult = max <= 15 ? 25.4 : max <= 60 ? 10 : 1;
  }

  // Sort descending: height >= width >= thickness.
  const mm = nums.map((n) => n * mult).sort((a, b) => b - a);
  const heightMm = mm[0];
  const widthMm = mm[1];
  const thicknessMm = mm.length >= 3 ? mm[2] : null;

  // Reject the whole parse when out of physical range. Open Library really does
  // contain placeholder rows like "1 x 1 x 1 inches"; rendering that as a 25mm
  // tall book looks like a bug, so an honest heuristic is strictly better.
  if (heightMm < 100 || heightMm > 400) return null;
  if (widthMm < 70 || widthMm > 320) return null;
  if (thicknessMm != null && (thicknessMm < 3 || thicknessMm > 120)) return null;
  if (widthMm > heightMm) return null;

  return {
    heightMm: Math.round(heightMm * 10) / 10,
    widthMm: Math.round(widthMm * 10) / 10,
    thicknessMm: thicknessMm == null ? null : Math.round(thicknessMm * 10) / 10,
    confidence,
  };
}
