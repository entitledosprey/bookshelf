/**
 * Spine geometry.
 *
 * This is the PRIMARY path, not a fallback. Open Library's physical_dimensions
 * is absent for most editions (a live check of /isbn/9780316769488.json returned
 * no physical_dimensions, physical_format, or number_of_pages at all), and
 * Google Books only has structured dimensions for a minority of volumes. So a
 * real measurement is a lucky upgrade and the heuristic carries the shelf.
 *
 * Every figure ships to the client with a `source` and `confidence` so the UI
 * can be honest about which numbers are measured and which are estimated.
 */

/**
 * pagesPerMm is derived from publishing PPI (pages per inch) stock ratings:
 * trade paper 400-500 PPI, mass market 600-700, bulky hardcover stock 350-450.
 * coverMm is boards + endpapers for cased bindings, cover stock for paperbacks.
 */
export const FORMAT_DEFAULTS = {
  hardcover:         { heightMm: 235, widthMm: 155, pagesPerMm: 15.5, coverMm: 4.0 },
  'trade-paperback': { heightMm: 198, widthMm: 129, pagesPerMm: 17.5, coverMm: 1.2 },
  'mass-market':     { heightMm: 174, widthMm: 106, pagesPerMm: 24.0, coverMm: 1.0 },
  oversize:          { heightMm: 280, widthMm: 216, pagesPerMm: 11.0, coverMm: 5.0 },
  // pagesPerMm is 0 for both: these are not physical objects, so page count
  // must never be turned into millimetres of paper for them.
  ebook:             { heightMm: 190, widthMm: 125, pagesPerMm: 0, coverMm: 0.0 },
  audiobook:         { heightMm: 140, widthMm: 125, pagesPerMm: 0,    coverMm: 0.0 },
  unknown:           { heightMm: 203, widthMm: 133, pagesPerMm: 19.0, coverMm: 1.5 },
};

export const MIN_THICKNESS_MM = 6;
export const MAX_THICKNESS_MM = 70;
export const MIN_HEIGHT_MM = 120;
export const MAX_HEIGHT_MM = 400;

/**
 * Map the free-text binding names Goodreads, Open Library and Google Books use
 * onto our seven buckets.
 *
 * `heightMm` is used as a tiebreak: "Paperback" is ambiguous between trade and
 * mass market, and a measured height <= 180mm settles it.
 */
export function normalizeBinding(raw, heightMm = null) {
  const s = String(raw ?? '').toLowerCase().trim();
  if (!s) return 'unknown';

  if (/audio|audible|cd|cassette|mp3/.test(s)) return 'audiobook';
  if (/kindle|ebook|e-book|epub|digital|nook/.test(s)) return 'ebook';
  if (/mass market/.test(s)) return 'mass-market';
  if (/hardcover|hardback|hard cover|cased|library binding|board book|leather|cloth/.test(s)) return 'hardcover';
  if (/spiral|comb|ring bound/.test(s)) return 'trade-paperback';
  if (/trade paper/.test(s)) return 'trade-paperback';
  if (/folio|coffee table|oversize|quarto/.test(s)) return 'oversize';
  if (/paperback|softcover|soft cover|pamphlet|chapbook|paper/.test(s)) {
    if (heightMm != null && heightMm <= 180) return 'mass-market';
    return 'trade-paperback';
  }
  return 'unknown';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Compute final spine geometry from whatever is known.
 *
 * @param {{pages?:number|null, binding?:string, heightMm?:number|null,
 *          widthMm?:number|null, thicknessMm?:number|null, source?:string}} input
 * @returns {{heightMm:number,widthMm:number,thicknessMm:number,
 *            source:string, confidence:number}}
 */
export function estimateGeometry(input = {}) {
  const binding = FORMAT_DEFAULTS[input.binding] ? input.binding : 'unknown';
  const d = FORMAT_DEFAULTS[binding];

  const realH = Number.isFinite(input.heightMm) && input.heightMm > 0 ? input.heightMm : null;
  const realW = Number.isFinite(input.widthMm) && input.widthMm > 0 ? input.widthMm : null;
  const realT = Number.isFinite(input.thicknessMm) && input.thicknessMm > 0 ? input.thicknessMm : null;
  const pages = Number.isFinite(input.pages) && input.pages > 0 ? input.pages : null;

  const heightMm = clamp(realH ?? d.heightMm, MIN_HEIGHT_MM, MAX_HEIGHT_MM);
  const widthMm = clamp(realW ?? d.widthMm, 70, 320);

  let thicknessMm;
  if (binding === 'ebook' || binding === 'audiobook') {
    // Checked FIRST, before the page-count branch. A 900-page Kindle edition
    // is not 47mm of paper; inventing that and presenting it as the book's real
    // size is the one thing this whole geometry engine must not do. They get a
    // fixed slim form, and spines.css renders them visibly non-physical.
    thicknessMm = 12;
  } else if (realT != null) {
    thicknessMm = realT;
  } else if (pages != null && d.pagesPerMm > 0) {
    thicknessMm = pages / d.pagesPerMm + d.coverMm;
  } else {
    thicknessMm = 18; // no page count at all
  }

  // Clamp twice: absolute bounds, then relative, so a bad page count cannot
  // produce a cube. A book thicker than height/2.5 does not exist on a shelf.
  thicknessMm = clamp(thicknessMm, MIN_THICKNESS_MM, MAX_THICKNESS_MM);
  thicknessMm = Math.min(thicknessMm, heightMm / 2.5);

  let confidence;
  let source;
  if (realT != null && realH != null) {
    confidence = 0.95;
    source = input.source ?? 'measured';
  } else if (realH != null || realT != null) {
    confidence = 0.75;
    source = input.source ?? 'measured';
  } else if (pages != null) {
    confidence = 0.6;
    source = 'heuristic';
  } else {
    confidence = 0.2;
    source = 'heuristic';
  }

  return {
    heightMm: Math.round(heightMm * 10) / 10,
    widthMm: Math.round(widthMm * 10) / 10,
    thicknessMm: Math.round(thicknessMm * 10) / 10,
    source,
    confidence,
  };
}

/**
 * Deliberately NOT inferring binding from the cover image's aspect ratio.
 *
 * It was tried and removed. Measured over 344 real covers the distribution is
 * far too tight to carry a signal -- p25 1.500, p50 1.511, p75 1.528 -- and the
 * outliers turn out to be bad scans rather than different formats: a 500x500
 * square scan of The Lion, the Witch and the Wardrobe was classified "oversize",
 * and Outlive (a normal hardcover) came out as "280 x 216 x 50 mm".
 *
 * Reporting a fabricated format as fact is worse than admitting we do not know,
 * so books with no publisher-supplied physical_format stay "unknown" and get
 * the neutral default. Height variation on the shelf comes only from real
 * physical_format values and real measured dimensions.
 */
