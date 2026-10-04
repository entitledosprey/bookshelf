import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { politeFetch } from '../net/politeFetch.js';
import { decodeImage } from '../palette.js';

/**
 * Covers are always downloaded and cached to the data volume, never hotlinked
 * from the browser. Three reasons:
 *   - the nginx CSP stays at img-src 'self' data:
 *   - Goodreads/Amazon CDNs can start blocking by referer at any time
 *   - the whole premise of the local store is that the shelf keeps working when
 *     the upstreams do not
 */

const MIN_WIDTH = 120;

/**
 * Second-line placeholder defence, after download. Goodreads' /nophoto/ URLs
 * are caught by pattern upstream; this catches generic grey boxes that slip
 * through from any source.
 */
export function looksLikePlaceholder(img) {
  if (!img) return true;
  if (img.width < MIN_WIDTH) return true;
  const step = Math.max(1, Math.floor((img.width * img.height) / 2000));
  let n = 0;
  let sr = 0, sg = 0, sb = 0;
  const pts = [];
  for (let i = 0; i < img.width * img.height; i += step) {
    const o = i * 4;
    const p = { r: img.data[o], g: img.data[o + 1], b: img.data[o + 2] };
    pts.push(p); sr += p.r; sg += p.g; sb += p.b; n += 1;
  }
  if (!n) return true;
  const mr = sr / n, mg = sg / n, mb = sb / n;
  let tight = 0;
  for (const p of pts) {
    if (Math.abs(p.r - mr) < 8 && Math.abs(p.g - mg) < 8 && Math.abs(p.b - mb) < 8) tight += 1;
  }
  return tight / n > 0.98;
}

/** Download, validate and cache one candidate. Returns null if unusable. */
async function tryCandidate(bookId, url, source) {
  if (!url) return null;
  let res;
  try {
    res = await politeFetch(url, { binary: true, accept: 'image/*', retries: 1 });
  } catch {
    return null;
  }
  if (res.status !== 200 || !res.body || res.body.length < 1024) return null;

  const img = decodeImage(res.body, res.contentType);
  if (!img || looksLikePlaceholder(img)) return null;

  const ext = /png/i.test(res.contentType) || res.body[0] === 0x89 ? 'png' : 'jpg';
  const file = `${bookId}.${ext}`;
  mkdirSync(config.coverDir, { recursive: true });
  writeFileSync(join(config.coverDir, file), res.body);

  return {
    path: file,
    contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
    bytes: res.body.length,
    width: img.width,
    height: img.height,
    source,
    sourceUrl: url,
    buffer: res.body,
  };
}

/**
 * Try candidates in precedence order and keep the one with the largest decoded
 * pixel area. Goodreads' full-size image is tried first because it is the
 * edition the user actually shelved.
 *
 * @param {{bookId:string, goodreadsUrl?:string, openLibraryCoverId?:number|null, googleUrl?:string|null}} c
 */
export async function resolveCover(c) {
  const candidates = [
    [c.goodreadsUrl, 'goodreads'],
    [c.openLibraryCoverId ? `https://covers.openlibrary.org/b/id/${c.openLibraryCoverId}-L.jpg` : null, 'openlibrary'],
    [c.googleUrl, 'googlebooks'],
  ].filter(([u]) => u);

  let best = null;
  for (const [url, source] of candidates) {
    const got = await tryCandidate(c.bookId, url, source);
    if (!got) continue;
    if (!best || got.width * got.height > best.width * best.height) best = got;
    // A genuinely large cover is good enough; stop paying for more requests.
    if (best.width >= 500) break;
  }
  return best;
}
