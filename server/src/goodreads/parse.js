import { XMLParser } from 'fast-xml-parser';
import { splitTitle, authorSort, authorShort } from '../titles.js';

/**
 * Goodreads serves placeholder art whenever a data partner's licence forbids
 * showing the real cover, so this is common rather than rare.
 */
export const isPlaceholderCover = (url) => !url || url.includes('/nophoto/');

/**
 * Goodreads image URLs carry an Amazon size token; stripping it yields the
 * full-resolution original (typically 2-3x the linked size).
 *   .../34._SY475_.jpg -> .../34.jpg
 */
export const fullSizeCover = (url) =>
  (url ?? '').replace(/\._(?:SX|SY|SR|UX|UY|UF|CR|AC|US)[\d,_]*_(?=\.\w+$)/, '');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  cdataPropName: '__cdata',
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  // Every field we read is a scalar; without this, a field that happens to look
  // numeric (ISBN-10 "0618346252") would silently become a Number and lose
  // leading zeros, which breaks ISBN lookups.
  parseTagValue: false,
  parseAttributeValue: false,
});

/** fast-xml-parser hands back either a scalar or {__cdata}. Flatten both. */
function text(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    if ('__cdata' in node) return String(node.__cdata ?? '').trim();
    if ('#text' in node) return String(node['#text'] ?? '').trim();
  }
  return '';
}

const int = (v) => { const n = parseInt(text(v), 10); return Number.isFinite(n) ? n : null; };
const flt = (v) => { const n = parseFloat(text(v)); return Number.isFinite(n) ? n : null; };

/** Goodreads date strings are RFC-822; normalise to ISO or null. */
function isoDate(v) {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parse one page of a Goodreads shelf RSS feed.
 *
 * Two quirks that break naive parsers, both locked in by test/parse.test.mjs:
 *
 *  1. num_pages is NOT a direct child of <item>. It is nested one level down
 *     inside <book id="...">:  <book id="34"><num_pages>398</num_pages></book>
 *  2. <title> exists on both the channel and each item, so extraction must be
 *     scoped to items or every book inherits the shelf name.
 *
 * An item with no book_id is skipped rather than thrown on: one malformed row
 * must never cost us the other 199 on the page.
 *
 * @returns {{items: RawBook[], skipped: number, channelTitle: string}}
 */
export function parseFeedXml(xml) {
  const doc = parser.parse(xml ?? '');
  const channel = doc?.rss?.channel;
  if (!channel) return { items: [], skipped: 0, channelTitle: '' };

  const raw = channel.item == null ? [] : Array.isArray(channel.item) ? channel.item : [channel.item];
  const items = [];
  let skipped = 0;

  for (const it of raw) {
    // book_id can be absent; fall back to the review link's book id if present.
    const bookId = text(it.book_id) || text(it.book?.['@id']);
    if (!bookId) { skipped += 1; continue; }

    const rawTitle = text(it.title);
    const { title, displayTitle, shortTitle, series, seriesPosition } = splitTitle(rawTitle);
    const author = text(it.author_name);

    // The nested <book> element, which is where num_pages actually lives.
    const pages = int(it.book?.num_pages);

    const large = fullSizeCover(text(it.book_large_image_url) || text(it.book_image_url));
    const shelves = text(it.user_shelves)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    items.push({
      bookId,
      title,
      displayTitle,
      shortTitle,
      series,
      seriesPosition,
      author,
      authorSort: authorSort(author),
      authorShort: authorShort(author),
      isbn: text(it.isbn),
      pages,
      avgRating: flt(it.average_rating),
      userRating: int(it.user_rating) || null,
      published: int(it.book_published),
      coverUrl: isPlaceholderCover(large) ? '' : large,
      goodreadsUrl: `https://www.goodreads.com/book/show/${bookId}`,
      // user_shelves lists CUSTOM shelves only. A book shelved only as "read"
      // has an empty user_shelves, so the exclusive shelf cannot be derived
      // from the item -- it comes from which feed returned the book.
      shelves,
      dateAdded: isoDate(it.user_date_added),
      readAt: isoDate(it.user_read_at),
    });
  }

  return { items, skipped, channelTitle: text(channel.title) };
}
