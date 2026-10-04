import { config } from '../config.js';
import { politeFetch } from '../net/politeFetch.js';
import { parseFeedXml } from './parse.js';

/**
 * Goodreads shelf RSS, paginated.
 *
 * Measured against the live endpoint (a public account, Oct 2026) rather than
 * taken from documentation, because the widely-repeated "RSS is capped at 100
 * books" claim is wrong:
 *
 *   ?shelf=read                      -> 100 items   (the default, hence the myth)
 *   &per_page=200                    -> 200 items
 *   &per_page=300 / 500 / 1000       -> silently falls back to 100
 *   &page=1,2,3                      -> 100 each, ZERO book_id overlap
 *   &per_page=200&page=1..5          -> 200,200,200,29,0  (clean termination)
 *   shelf=%23ALL%23&per_page=200     -> walks past 1200 books
 *
 * So PER_PAGE_MAX is 200 and a page walk enumerates the whole library. We still
 * stop on a repeated page fingerprint: if Goodreads ever starts ignoring page=,
 * the walk degrades to "first page only" instead of looping forever.
 */
export const PER_PAGE_MAX = 200;

/** "#ALL#" is the pseudo-shelf meaning every book on every shelf. */
export const ALL_SHELF = '#ALL#';

/** The three shelves every book sits on exactly one of. */
export const EXCLUSIVE_SHELVES = ['read', 'currently-reading', 'to-read'];

export function buildFeedUrl({ userId, shelf = ALL_SHELF, page = 1, perPage = PER_PAGE_MAX, key = '' }) {
  const u = new URL(`/review/list_rss/${encodeURIComponent(userId)}`, config.goodreadsBaseUrl);
  u.searchParams.set('shelf', shelf);
  u.searchParams.set('per_page', String(perPage));
  u.searchParams.set('page', String(page));
  if (key) u.searchParams.set('key', key);
  return u.toString();
}

/** Order-independent fingerprint of a page's book ids. */
export function fingerprint(bookIds) {
  return [...bookIds].sort().join(',');
}

/**
 * Walk one shelf to exhaustion.
 *
 * Yields {page, items, itemCount, skipped} per page. Stops when a page is
 * empty, short (< perPage, meaning the shelf is exhausted and therefore
 * provably complete), repeats the previous page's fingerprint, or hits
 * maxPages.
 */
export async function* walkShelf({ userId, shelf = ALL_SHELF, key = '', perPage = PER_PAGE_MAX, maxPages = config.syncMaxPages }) {
  let lastFingerprint = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = buildFeedUrl({ userId, shelf, page, perPage, key });
    const res = await politeFetch(url, { accept: 'application/rss+xml, application/xml, text/xml' });

    if (res.status !== 200 || !res.body) {
      yield { page, items: [], itemCount: 0, skipped: 0, status: res.status, stop: 'http', complete: false };
      return;
    }

    const { items, skipped } = parseFeedXml(res.body);

    // HTTP 200 but nothing parsed means the format changed. Report it loudly;
    // never let it be mistaken for "the shelf is empty" -- the merge is
    // append-only, so a bad parse can't erase the store, but we still want the
    // run marked failed rather than silently "ok".
    if (items.length === 0 && skipped === 0) {
      yield { page, items: [], itemCount: 0, skipped: 0, status: 200, stop: page === 1 ? 'parsed-zero' : 'empty', complete: page > 1 };
      return;
    }

    const fp = fingerprint(items.map((i) => i.bookId));
    if (lastFingerprint !== null && fp === lastFingerprint) {
      // page= was ignored: we got the same page back. Degrade, don't loop.
      yield { page, items: [], itemCount: items.length, skipped, status: 200, stop: 'page-ignored', complete: false };
      return;
    }
    lastFingerprint = fp;

    const short = items.length + skipped < perPage;
    yield {
      page,
      items,
      itemCount: items.length,
      skipped,
      status: 200,
      stop: short ? 'exhausted' : null,
      complete: short,
    };
    if (short) return;
  }

  // Ran out of page budget: coverage is partial, not provably complete.
  yield { page: maxPages, items: [], itemCount: 0, skipped: 0, status: 200, stop: 'max-pages', complete: false };
}
