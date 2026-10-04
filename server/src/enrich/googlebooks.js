import { politeFetch } from '../net/politeFetch.js';
import { config } from '../config.js';
import { parseLength } from './dimensions.js';
import { scoreMatch, ACCEPT_THRESHOLD } from './match.js';

const BASE = 'https://www.googleapis.com/books/v1/volumes';

/**
 * Google Books is the better source for dimensions when it has them, because
 * volumeInfo.dimensions is STRUCTURED ({height:"24.00 cm", ...}) rather than
 * Open Library's free text. It is also the more forgiving title matcher.
 *
 * But unauthenticated requests 429 almost immediately from a cold IP (verified),
 * so without GOOGLE_BOOKS_API_KEY this stays mostly inert and politeFetch gives
 * the host a 24h cooldown after a single strike. That is intentional: Open
 * Library carries enrichment and Google is an opportunistic upgrade.
 */
function url(q) {
  const u = new URL(BASE);
  u.searchParams.set('q', q);
  u.searchParams.set('maxResults', '5');
  if (config.googleBooksKey) u.searchParams.set('key', config.googleBooksKey);
  return u.toString();
}

async function query(q) {
  const res = await politeFetch(url(q), { accept: 'application/json' });
  if (res.status !== 200 || !res.body) return [];
  try { return JSON.parse(res.body)?.items ?? []; } catch { return []; }
}

/** Best available image link, normalised to https and a usable width. */
export function bestImageLink(imageLinks) {
  if (!imageLinks) return null;
  const raw = imageLinks.extraLarge || imageLinks.large || imageLinks.medium || imageLinks.thumbnail;
  if (!raw) return null;
  return raw
    .replace(/^http:/, 'https:')
    .replace(/&edge=curl/g, '')
    .replace(/([?&])zoom=\d+/, '$1zoom=1') + '&fife=w800';
}

function fromVolume(v, source) {
  const info = v?.volumeInfo ?? {};
  const d = info.dimensions ?? {};
  return {
    source,
    pages: Number.isFinite(info.pageCount) && info.pageCount > 0 ? info.pageCount : null,
    // printType is only BOOKS / MAGAZINES, so it tells us nothing about binding.
    physicalFormat: null,
    heightMm: parseLength(d.height),
    widthMm: parseLength(d.width),
    thicknessMm: parseLength(d.thickness),
    imageUrl: bestImageLink(info.imageLinks),
    title: info.title ?? null,
  };
}

export async function byIsbn(isbn) {
  const clean = String(isbn ?? '').replace(/[^0-9Xx]/g, '');
  if (clean.length !== 10 && clean.length !== 13) return null;
  const items = await query(`isbn:${clean}`);
  return items.length ? fromVolume(items[0], 'googlebooks') : null;
}

export async function searchByTitleAuthor({ title, author, pages, seriesPosition }) {
  if (!title) return null;
  const q = [`intitle:"${title.replace(/"/g, '')}"`, author && `inauthor:"${author.replace(/"/g, '')}"`]
    .filter(Boolean)
    .join('+');
  const items = await query(q);

  let best = null;
  for (const v of items) {
    const info = v?.volumeInfo ?? {};
    const score = scoreMatch(
      { title, author, pages, seriesPosition },
      { title: info.title, authors: info.authors ?? [], pages: info.pageCount ?? null },
    );
    if (score >= ACCEPT_THRESHOLD && (!best || score > best.score)) {
      best = { ...fromVolume(v, 'googlebooks-search'), score };
    }
  }
  return best;
}
