/**
 * Title+author matching for the ~22% of feed items that carry no ISBN
 * (measured: 268 of 1200 items on a real account). Kindle editions and older
 * mass-market printings are the usual culprits.
 *
 * A wrong match is worse than no match: it paints a spine the colour of someone
 * else's book and reports fabricated dimensions as measured. So the gates below
 * are deliberately strict and we keep the honest heuristic when unsure.
 */

export const ACCEPT_THRESHOLD = 0.8;

const ARTICLES = /^(the|a|an|le|la|les|el|los|das|der|die)\s+/i;

export function normalizeTitle(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s*[:(–—-]\s.*$/, '')  // drop subtitle / parenthetical tail
    .replace(ARTICLES, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAuthor(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Surnames in a free-form author string, including "Le Guin" style particles.
 *
 * Splits on separators BEFORE normalising: normalising first would strip the
 * commas, collapsing "George Saunders, Ben Clark" into one name whose surname
 * is "clark", and the real author would then fail the match gate.
 */
export function surnames(author) {
  return String(author ?? '')
    .split(/\s*(?:,|;|\band\b|&|\/)\s*/)
    .map((part) => {
      const parts = normalizeAuthor(part).split(' ').filter(Boolean);
      if (!parts.length) return '';
      let start = parts.length - 1;
      const PARTICLE = /^(van|von|de|del|della|di|da|du|la|le|st|mac|mc|ten|ter|bin|al)$/;
      while (start > 0 && PARTICLE.test(parts[start - 1])) start -= 1;
      return parts.slice(start).join(' ');
    })
    .filter(Boolean);
}

export function levenshtein(a, b) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= t.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[t.length];
}

const ratio = (a, b) => {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
};

/** Trailing sequence number, so "Dune" never matches "Dune Messiah #2". */
function trailingNumber(s) {
  const m = String(s ?? '').match(/\b(\d{1,2})\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * @returns {number} 0..1; accept at >= ACCEPT_THRESHOLD
 */
export function scoreMatch(query, candidate) {
  const qt = normalizeTitle(query.title);
  const ct = normalizeTitle(candidate.title);
  if (!qt || !ct) return 0;

  // Hard gate 1: author surname must appear on both sides. This is what stops
  // the classic same-title-different-author disaster.
  const qs = surnames(query.author);
  const cs = surnames(Array.isArray(candidate.authors) ? candidate.authors.join(', ') : candidate.authors);
  if (qs.length && cs.length) {
    const shared = qs.some((a) => cs.some((b) => a === b || ratio(a, b) >= 0.9));
    if (!shared) return 0;
  } else if (qs.length && !cs.length) {
    return 0;
  }

  // Hard gate 2: series position equality when both expose one. Token overlap
  // alone happily matches "Harry Potter 1" to "Harry Potter 3".
  const qn = query.seriesPosition ?? trailingNumber(query.title);
  const cn = candidate.seriesPosition ?? trailingNumber(candidate.title);
  if (qn != null && cn != null && qn !== cn) return 0;

  const qTok = new Set(qt.split(' '));
  const cTok = new Set(ct.split(' '));
  const inter = [...qTok].filter((t) => cTok.has(t)).length;
  const jaccard = inter / (qTok.size + cTok.size - inter);
  const lev = ratio(qt, ct);
  // Token overlap is the main gate, but a near-perfect character match can
  // carry a title whose tokenisation differs ("Societe" vs "Society").
  if (lev < 0.82) return 0;
  if (jaccard < 0.6 && lev < 0.90) return 0;

  let score = 0.55 * lev + 0.45 * jaccard;

  // Page count is a soft signal only: editions legitimately differ in pagination.
  if (query.pages && candidate.pages) {
    const diff = Math.abs(query.pages - candidate.pages) / Math.max(query.pages, candidate.pages);
    if (diff > 0.35) score -= 0.12;
  }
  return Math.max(0, Math.min(1, score));
}
