/**
 * Goodreads embeds series information in the title:
 *   "The Fellowship of the Ring (The Lord of the Rings, #1)"
 * Splitting it out improves enrichment matching, lets the shelf group series,
 * and gives the spine renderer progressively shorter strings to typeset.
 *
 * Spine truncation should be semantic before it is typographic: drop the series
 * parenthetical, then the subtitle, and only then let CSS ellipsize. Otherwise
 * a long title renders as "The Lord of the Ri..." which tells the reader nothing.
 */

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/**
 * @param {string} raw
 * @returns {{title:string, displayTitle:string, shortTitle:string,
 *            series:string|null, seriesPosition:number|null}}
 */
export function splitTitle(raw) {
  const title = (raw ?? '').replace(/\s+/g, ' ').trim();
  let displayTitle = title;
  let series = null;
  let seriesPosition = null;

  // Trailing parenthetical: "(Series, #2)", "(Series #2)", "(Series Book 2)", "(Series)".
  const m = title.match(/\s*\(([^()]*?)\)\s*$/);
  if (m) {
    const inner = m[1].trim();
    const num = inner.match(/(?:,\s*)?(?:#|book\s+|no\.?\s+|part\s+)(\d+(?:\.\d+)?)\s*$/i);
    if (num) {
      seriesPosition = Number(num[1]);
      series = inner.slice(0, num.index).replace(/[,\s]+$/, '').trim() || null;
      displayTitle = title.slice(0, m.index).trim();
    } else if (/\b(series|trilogy|cycle|saga|chronicles)\b/i.test(inner)) {
      series = inner;
      displayTitle = title.slice(0, m.index).trim();
    }
  }
  if (series === '') series = null;
  if (!displayTitle) displayTitle = title;

  // shortTitle additionally drops a subtitle after ':' or ' - '.
  let shortTitle = displayTitle;
  const sub = shortTitle.match(/^(.+?)\s*(?::|\s-\s)\s*\S/);
  if (sub && sub[1].trim().length >= 4) shortTitle = sub[1].trim();

  return { title, displayTitle, shortTitle, series, seriesPosition };
}

/** Roman numerals appear as series positions too ("Dune Messiah II"). */
export function romanToInt(s) {
  return ROMAN[String(s ?? '').toLowerCase()] ?? null;
}

/**
 * "Ursula K. Le Guin" -> "Le Guin, Ursula K." so the default shelf order groups
 * an author's books into one visible block of spines, like a real bookshelf.
 * Handles particles (van, de, von, le) and suffixes (Jr., III).
 */
export function authorSort(name) {
  const n = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) return '';
  if (n.includes(',')) return n; // already surname-first
  const parts = n.split(' ');
  if (parts.length === 1) return n;

  let end = parts.length;
  const SUFFIX = /^(jr\.?|sr\.?|iii|iv|ii|phd|md)$/i;
  let suffix = '';
  if (SUFFIX.test(parts[end - 1])) { suffix = parts[end - 1]; end -= 1; }

  let start = end - 1;
  const PARTICLE = /^(van|von|de|del|della|di|da|du|la|le|st\.?|mac|mc|ten|ter|bin|al)$/i;
  while (start > 1 && PARTICLE.test(parts[start - 1])) start -= 1;

  const surname = parts.slice(start, end).join(' ');
  const rest = parts.slice(0, start).join(' ');
  const tail = suffix ? `${surname} ${suffix}` : surname;
  return rest ? `${tail}, ${rest}` : tail;
}

/** "Ursula K. Le Guin" -> "U. K. Le Guin", for tight spines. */
export function authorShort(name) {
  const n = (name ?? '').trim();
  if (!n) return '';
  const parts = n.split(/\s+/);
  if (parts.length < 2) return n;
  const sorted = authorSort(n);
  const surname = sorted.includes(',') ? sorted.split(',')[0] : parts[parts.length - 1];
  const initials = n
    .slice(0, n.length - surname.length)
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => `${p[0].toUpperCase()}.`)
    .join(' ');
  return initials ? `${initials} ${surname}` : surname;
}
