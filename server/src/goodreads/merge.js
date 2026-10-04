import { getDb } from '../db.js';
import { isoNow } from '../http.js';
import { estimateGeometry } from '../enrich/geometry.js';
import { pickSpineStyle, seedFrom } from '../seed.js';

/**
 * The ONE write path into books/user_books. Both the RSS sync and the CSV
 * import call this; only the parser upstream differs.
 *
 * Append-only by design:
 *   - a book never seen before is inserted
 *   - a book seen again refreshes only MUTABLE user state (rating, shelves,
 *     date added) and bibliographic fields that are still blank
 *   - enriched geometry, palette and manual overrides are never overwritten
 *   - nothing is ever deleted
 *
 * That last point is the whole resilience story: if Goodreads blocks the feed
 * or changes format, the shelf keeps rendering from the local store rather than
 * emptying out. It also makes "parsed zero items" structurally harmless.
 *
 * @param {{userId:number, items:object[], exclusiveShelf:string, source?:string}} args
 * @returns {{added:number, updated:number}}
 */
export function mergeBooks({ userId, items, exclusiveShelf = 'read', source = 'rss' }) {
  const db = getDb();
  const now = isoNow();

  const selBook = db.prepare('SELECT book_id, num_pages, isbn, published, avg_rating, goodreads_image_url FROM books WHERE book_id = ?');

  const insBook = db.prepare(`
    INSERT INTO books (
      book_id, title, display_title, short_title, series, series_position,
      author, author_sort, isbn, num_pages, pages_source, avg_rating, published,
      goodreads_image_url, goodreads_url,
      height_mm, width_mm, thickness_mm, dims_source, binding, geometry_confidence,
      spine_style, seed, first_seen_at, enrich_state
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`);

  // Backfill only. COALESCE keeps whatever is already there, so re-syncing can
  // never clobber a value enrichment or an override has improved.
  const patchBook = db.prepare(`
    UPDATE books SET
      num_pages           = COALESCE(num_pages, ?),
      pages_source        = COALESCE(pages_source, ?),
      isbn                = CASE WHEN isbn = '' THEN ? ELSE isbn END,
      published           = COALESCE(published, ?),
      avg_rating          = COALESCE(?, avg_rating),
      goodreads_image_url = CASE WHEN goodreads_image_url = '' THEN ? ELSE goodreads_image_url END
    WHERE book_id = ?`);

  const insUser = db.prepare(`
    INSERT INTO user_books (
      user_id, book_id, exclusive_shelf, user_shelves, user_rating,
      user_date_added, first_seen_at, last_seen_at, seen_count
    ) VALUES (?,?,?,?,?,?,?,?,1)
    ON CONFLICT(user_id, book_id) DO UPDATE SET
      exclusive_shelf = excluded.exclusive_shelf,
      user_shelves    = excluded.user_shelves,
      user_rating     = excluded.user_rating,
      user_date_added = COALESCE(user_books.user_date_added, excluded.user_date_added),
      last_seen_at    = excluded.last_seen_at,
      seen_count      = user_books.seen_count + 1`);

  let added = 0;
  let updated = 0;

  db.exec('BEGIN');
  try {
    for (const it of items) {
      const existing = selBook.get(it.bookId);

      if (!existing) {
        // Insert with heuristic geometry so the book renders immediately; the
        // enrichment worker upgrades it later if real dimensions exist.
        const g = estimateGeometry({ pages: it.pages, binding: 'unknown' });
        insBook.run(
          it.bookId, it.title, it.displayTitle, it.shortTitle,
          it.series ?? null, it.seriesPosition ?? null,
          it.author, it.authorSort, it.isbn ?? '', it.pages ?? null,
          it.pages == null ? null : 'goodreads',
          it.avgRating ?? null, it.published ?? null,
          it.coverUrl ?? '', it.goodreadsUrl ?? '',
          g.heightMm, g.widthMm, g.thicknessMm, g.source, 'unknown', g.confidence,
          pickSpineStyle(it.bookId, 'unknown'), seedFrom(it.bookId), now,
        );
        added += 1;
      } else {
        patchBook.run(
          it.pages ?? null,
          it.pages == null ? null : 'goodreads',
          it.isbn ?? '',
          it.published ?? null,
          it.avgRating ?? null,
          it.coverUrl ?? '',
          it.bookId,
        );
      }

      const before = db.prepare('SELECT seen_count FROM user_books WHERE user_id = ? AND book_id = ?')
        .get(userId, it.bookId);
      insUser.run(
        userId, it.bookId, exclusiveShelf,
        (it.shelves ?? []).join(', '),
        it.userRating ?? null,
        it.dateAdded ?? null,
        now, now,
      );
      if (before) updated += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { added, updated };
}
