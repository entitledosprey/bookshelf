import { politeFetch } from '../net/politeFetch.js';
import { parsePhysicalDimensions } from './dimensions.js';
import { scoreMatch, ACCEPT_THRESHOLD } from './match.js';

const BASE = 'https://openlibrary.org';

/**
 * Open Library cover URLs MUST be built from a CoverID (or OLID).
 *
 * The /b/isbn/{isbn}-L.jpg convenience path is rate limited to 100 requests per
 * IP per 5 minutes and returns 403 past that, while /b/id/{coverId}-L.jpg is
 * not limited. So we always resolve the edition JSON first and use covers[0].
 */
export const coverUrlForId = (coverId, size = 'L') =>
  `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;

const json = async (url) => {
  const res = await politeFetch(url, { accept: 'application/json' });
  if (res.status !== 200 || !res.body) return null;
  try { return JSON.parse(res.body); } catch { return null; }
};

/**
 * Edition lookup by ISBN.
 *
 * Note that most editions return NONE of the physical fields -- a live check of
 * /isbn/9780316769488.json came back with no physical_dimensions,
 * physical_format or number_of_pages at all. Treat every field as optional.
 */
export async function byIsbn(isbn) {
  const clean = String(isbn ?? '').replace(/[^0-9Xx]/g, '');
  if (clean.length !== 10 && clean.length !== 13) return null;

  const ed = await json(`${BASE}/isbn/${clean}.json`);
  if (!ed) return null;

  const dims = parsePhysicalDimensions(ed.physical_dimensions);
  return {
    source: 'openlibrary',
    pages: Number.isFinite(ed.number_of_pages) ? ed.number_of_pages : null,
    physicalFormat: ed.physical_format ?? null,
    heightMm: dims?.heightMm ?? null,
    widthMm: dims?.widthMm ?? null,
    thicknessMm: dims?.thicknessMm ?? null,
    coverId: Array.isArray(ed.covers) ? ed.covers.find((c) => Number.isFinite(c) && c > 0) ?? null : null,
    title: ed.title ?? null,
  };
}

/** Fallback for the ~22% of books with no ISBN. `fields` trims the response. */
export async function searchByTitleAuthor({ title, author, pages, seriesPosition }) {
  if (!title) return null;
  const u = new URL(`${BASE}/search.json`);
  u.searchParams.set('title', title);
  if (author) u.searchParams.set('author', author);
  u.searchParams.set('fields', 'key,title,author_name,cover_i,number_of_pages_median,isbn');
  u.searchParams.set('limit', '5');

  const data = await json(u.toString());
  const docs = data?.docs ?? [];
  let best = null;

  for (const d of docs) {
    const score = scoreMatch(
      { title, author, pages, seriesPosition },
      { title: d.title, authors: d.author_name ?? [], pages: d.number_of_pages_median ?? null },
    );
    if (score >= ACCEPT_THRESHOLD && (!best || score > best.score)) {
      best = {
        score,
        source: 'openlibrary-search',
        pages: Number.isFinite(d.number_of_pages_median) ? d.number_of_pages_median : null,
        physicalFormat: null,
        heightMm: null, widthMm: null, thicknessMm: null,
        coverId: Number.isFinite(d.cover_i) && d.cover_i > 0 ? d.cover_i : null,
        isbn: Array.isArray(d.isbn) ? d.isbn[0] : null,
        title: d.title ?? null,
      };
    }
  }
  return best;
}
