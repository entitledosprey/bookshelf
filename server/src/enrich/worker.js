import { getDb } from '../db.js';
import { config } from '../config.js';
import { isoNow } from '../http.js';
import { estimateGeometry, normalizeBinding } from './geometry.js';
import { extractPalette, PALETTE_VERSION } from '../palette.js';
import { pickSpineStyle } from '../seed.js';
import * as openlibrary from './openlibrary.js';
import * as googlebooks from './googlebooks.js';
import { resolveCover } from './covers.js';
import { CooldownError } from '../net/politeFetch.js';

/**
 * Enrichment runs as a global background worker, not per user and never on a
 * request path. Because `books` is keyed by Goodreads book id and shared across
 * accounts, two users who own the same book cost ONE cover download, ONE
 * dimension lookup and ONE palette extraction.
 *
 * Backoff on failure is 1d -> 3d -> 7d -> 30d -> never, so a book that simply
 * is not in any database stops costing requests.
 */
const BACKOFF_DAYS = [1, 3, 7, 30];

const pick = (...vals) => vals.find((v) => v != null && v !== '') ?? null;

export function pendingCount() {
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM books
              WHERE enrich_state = 'pending'
                AND (enrich_retry_after IS NULL OR enrich_retry_after < ?)`)
    .get(isoNow()).n;
}

/** Enrich one book: metadata, then cover, then palette. */
export async function enrichBook(book) {
  const db = getDb();
  let meta = null;
  let googleUrl = null;
  let coverId = null;

  if (book.isbn) {
    meta = await openlibrary.byIsbn(book.isbn).catch((e) => { if (e instanceof CooldownError) return null; throw e; });
    coverId = meta?.coverId ?? null;
    // Google is an opportunistic upgrade, mainly for structured dimensions.
    if (!meta?.heightMm) {
      const g = await googlebooks.byIsbn(book.isbn).catch(() => null);
      if (g) {
        googleUrl = g.imageUrl ?? null;
        meta = {
          ...(meta ?? {}),
          source: meta?.source ?? g.source,
          pages: pick(meta?.pages, g.pages),
          physicalFormat: pick(meta?.physicalFormat, g.physicalFormat),
          heightMm: pick(meta?.heightMm, g.heightMm),
          widthMm: pick(meta?.widthMm, g.widthMm),
          thicknessMm: pick(meta?.thicknessMm, g.thicknessMm),
          coverId,
        };
      }
    }
  } else {
    // No ISBN (about 22% of items). Title+author search, strictly gated.
    const q = {
      title: book.display_title || book.title,
      author: book.author,
      pages: book.num_pages,
      seriesPosition: book.series_position,
    };
    const g = await googlebooks.searchByTitleAuthor(q).catch(() => null);
    const o = g ? null : await openlibrary.searchByTitleAuthor(q).catch(() => null);
    const found = g ?? o;
    if (found) {
      meta = found;
      coverId = found.coverId ?? null;
      googleUrl = found.imageUrl ?? null;
    }
  }

  const dimsFromMeta = meta?.heightMm != null || meta?.thicknessMm != null;
  const pages = pick(book.num_pages, meta?.pages);

  // Fetch the cover first: when no publisher format is known, the cover's
  // aspect ratio is the best remaining evidence for which format this is.
  let cover = null;
  try {
    cover = await resolveCover({
      bookId: book.book_id,
      goodreadsUrl: book.goodreads_image_url || null,
      openLibraryCoverId: coverId,
      googleUrl,
    });
  } catch (err) {
    if (!(err instanceof CooldownError)) throw err;
  }

  const binding = normalizeBinding(meta?.physicalFormat, meta?.heightMm ?? null);
  const bindingSource = meta?.physicalFormat ? (meta.source ?? 'openlibrary') : 'inferred';

  const geo = estimateGeometry({
    pages,
    binding,
    heightMm: meta?.heightMm ?? null,
    widthMm: meta?.widthMm ?? null,
    thicknessMm: meta?.thicknessMm ?? null,
    source: dimsFromMeta ? (meta.source?.startsWith('google') ? 'googlebooks' : 'openlibrary') : undefined,
  });

  let palette = null;
  if (cover?.buffer) {
    palette = extractPalette(cover.buffer, cover.contentType, book.book_id, binding);
  }

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE books SET
        num_pages = COALESCE(num_pages, ?), pages_source = COALESCE(pages_source, ?),
        binding = ?, binding_source = ?,
        height_mm = ?, width_mm = ?, thickness_mm = ?, dims_source = ?, geometry_confidence = ?,
        spine_style = ?, enrich_state = 'done', enriched_at = ?, enrich_retry_after = NULL
      WHERE book_id = ?`)
      .run(
        pages, pages == null ? null : (meta?.source ?? 'goodreads'),
        binding, bindingSource,
        geo.heightMm, geo.widthMm, geo.thicknessMm, geo.source, geo.confidence,
        pickSpineStyle(book.book_id, binding), isoNow(), book.book_id,
      );

    if (cover) {
      db.prepare(`INSERT INTO covers (
            book_id, path, content_type, bytes, width, height, source, source_url, fetched_at,
            palette_bg, palette_accent, palette_fg, swatches_json,
            is_grayscale, is_dark, palette_source, palette_version, status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ok')
          ON CONFLICT(book_id) DO UPDATE SET
            path=excluded.path, content_type=excluded.content_type, bytes=excluded.bytes,
            width=excluded.width, height=excluded.height, source=excluded.source,
            source_url=excluded.source_url, fetched_at=excluded.fetched_at,
            palette_bg=excluded.palette_bg, palette_accent=excluded.palette_accent,
            palette_fg=excluded.palette_fg, swatches_json=excluded.swatches_json,
            is_grayscale=excluded.is_grayscale, is_dark=excluded.is_dark,
            palette_source=excluded.palette_source, palette_version=excluded.palette_version,
            status='ok'`)
        .run(
          book.book_id, cover.path, cover.contentType, cover.bytes, cover.width, cover.height,
          cover.source, cover.sourceUrl, isoNow(),
          palette?.bg ?? null, palette?.accent ?? null, palette?.fg ?? null,
          JSON.stringify(palette?.swatches ?? []),
          palette?.isGrayscale ? 1 : 0, palette?.isDark ? 1 : 0,
          palette?.source ?? null, PALETTE_VERSION,
        );
    } else {
      // No cover anywhere: still give the book a palette so the shelf has no
      // hole in it, and mark the cover row so we do not retry forever.
      const { hashPalette } = await import('../palette.js');
      const hp = hashPalette(book.book_id, binding);
      db.prepare(`INSERT INTO covers (book_id, status, palette_bg, palette_accent, palette_fg,
            swatches_json, is_dark, palette_source, palette_version)
          VALUES (?, 'not_found', ?,?,?,?,?,?,?)
          ON CONFLICT(book_id) DO UPDATE SET
            status='not_found', palette_bg=excluded.palette_bg, palette_accent=excluded.palette_accent,
            palette_fg=excluded.palette_fg, swatches_json=excluded.swatches_json,
            is_dark=excluded.is_dark, palette_source=excluded.palette_source,
            palette_version=excluded.palette_version`)
        .run(book.book_id, hp.bg, hp.accent, hp.fg, JSON.stringify(hp.swatches),
             hp.isDark ? 1 : 0, hp.source, PALETTE_VERSION);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { bookId: book.book_id, dimsSource: geo.source, cover: cover?.source ?? null, palette: palette?.source ?? null };
}

function markFailed(bookId, attempts, message) {
  const idx = Math.min(attempts, BACKOFF_DAYS.length - 1);
  const retryAfter = attempts >= BACKOFF_DAYS.length
    ? null
    : new Date(Date.now() + BACKOFF_DAYS[idx] * 86_400_000).toISOString();
  getDb().prepare(`UPDATE books SET
      enrich_attempts = enrich_attempts + 1,
      enrich_state = CASE WHEN ? IS NULL THEN 'failed' ELSE 'pending' END,
      enrich_retry_after = ?
    WHERE book_id = ?`).run(retryAfter, retryAfter, bookId);
  return message;
}

/** Drain up to `limit` pending books. Serial: politeFetch rate limits anyway. */
export async function drainEnrichment({ limit = config.enrichPerTick } = {}) {
  if (!config.enrichEnabled) return { processed: 0, failed: 0, skipped: 'disabled' };
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM books
      WHERE enrich_state = 'pending'
        AND (enrich_retry_after IS NULL OR enrich_retry_after < ?)
      ORDER BY first_seen_at DESC LIMIT ?`).all(isoNow(), limit);

  let processed = 0;
  let failed = 0;
  for (const book of rows) {
    try {
      await enrichBook(book);
      processed += 1;
    } catch (err) {
      failed += 1;
      markFailed(book.book_id, book.enrich_attempts, err?.message ?? String(err));
    }
  }
  return { processed, failed };
}
