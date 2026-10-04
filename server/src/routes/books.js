import express from 'express';
import { getDb } from '../db.js';
import { wrap, HttpError, isoNow } from '../http.js';
import { requireUser } from '../auth/middleware.js';
import { hashPalette } from '../palette.js';

export const router = express.Router();

/**
 * One request paints the whole shelf.
 *
 * Geometry is millimetres, colour is hex, presentation is an enum plus a seed.
 * No HTML, no CSS, no inline styles -- that is what keeps a native client
 * cheap: SwiftUI can render this payload with no server changes at all.
 *
 * COALESCE over book_overrides throughout, so manual corrections always win and
 * re-enrichment can never clobber them.
 */
const SELECT = `
  SELECT
    b.book_id, b.title, b.display_title, b.short_title, b.series, b.series_position,
    b.author, b.author_sort, b.isbn, b.num_pages, b.avg_rating, b.published,
    b.goodreads_url, b.seed,
    COALESCE(o.display_title, b.display_title) AS eff_display_title,
    COALESCE(o.binding,       b.binding)       AS eff_binding,
    COALESCE(o.height_mm,     b.height_mm)     AS eff_height,
    COALESCE(o.width_mm,      b.width_mm)      AS eff_width,
    COALESCE(o.thickness_mm,  b.thickness_mm)  AS eff_thickness,
    COALESCE(o.spine_style,   b.spine_style)   AS eff_spine_style,
    CASE WHEN o.height_mm IS NOT NULL OR o.thickness_mm IS NOT NULL
         THEN 'override' ELSE b.dims_source END AS eff_dims_source,
    b.geometry_confidence,
    COALESCE(o.palette_bg,     c.palette_bg)     AS eff_bg,
    COALESCE(o.palette_accent, c.palette_accent) AS eff_accent,
    COALESCE(o.palette_fg,     c.palette_fg)     AS eff_fg,
    c.swatches_json, c.is_dark, c.is_grayscale, c.width AS cover_w, c.height AS cover_h,
    CASE WHEN o.palette_bg IS NOT NULL THEN 'override' ELSE c.palette_source END AS eff_palette_source,
    c.status AS cover_status,
    ub.exclusive_shelf, ub.user_shelves, ub.user_rating, ub.user_date_added,
    ub.my_rating, ub.notes, ub.notes_updated_at
  FROM user_books ub
  JOIN books b           ON b.book_id = ub.book_id
  LEFT JOIN covers c     ON c.book_id = ub.book_id
  LEFT JOIN book_overrides o ON o.book_id = ub.book_id
  WHERE ub.user_id = ?`;

function toBook(r) {
  const palette = r.eff_bg
    ? {
        bg: r.eff_bg,
        accent: r.eff_accent ?? r.eff_bg,
        fg: r.eff_fg ?? '#ffffff',
        swatches: (() => { try { return JSON.parse(r.swatches_json || '[]'); } catch { return []; } })(),
        isDark: !!r.is_dark,
        isGrayscale: !!r.is_grayscale,
        source: r.eff_palette_source ?? 'image',
      }
    : null;

  return {
    id: r.book_id,
    title: r.title,
    displayTitle: r.eff_display_title || r.title,
    shortTitle: r.short_title || r.eff_display_title || r.title,
    series: r.series ?? null,
    seriesPosition: r.series_position ?? null,
    author: r.author,
    authorSort: r.author_sort,
    isbn: r.isbn || null,
    pages: r.num_pages ?? null,
    published: r.published ?? null,
    averageRating: r.avg_rating ?? null,
    userRating: r.user_rating ?? null,
    // Yours, entered here, kept separate from the Goodreads rating above.
    myRating: r.my_rating ?? null,
    notes: r.notes ?? '',
    notesUpdatedAt: r.notes_updated_at ?? null,
    exclusiveShelf: r.exclusive_shelf || 'read',
    shelves: (r.user_shelves || '').split(',').map((s) => s.trim()).filter(Boolean),
    dateAdded: r.user_date_added ?? null,
    binding: r.eff_binding || 'unknown',
    geometry: {
      heightMm: r.eff_height ?? 203,
      widthMm: r.eff_width ?? 133,
      thicknessMm: r.eff_thickness ?? 18,
      source: r.eff_dims_source ?? 'heuristic',
      confidence: r.geometry_confidence ?? 0.2,
    },
    // A book whose enrichment has not run yet still gets a usable spine, so the
    // shelf is never full of holes while the worker drains.
    palette: palette ?? hashPalette(r.book_id, r.eff_binding || 'unknown'),
    palettePending: !palette,
    spineStyle: r.eff_spine_style || 'classic-serif-centred',
    seed: r.seed ?? 0,
    hasCover: r.cover_status === 'ok',
    // The cover's own proportions, so the client can show the art uncropped
    // instead of forcing every jacket into one assumed ratio.
    coverAspect: r.cover_w && r.cover_h ? Math.round((r.cover_w / r.cover_h) * 1000) / 1000 : null,
    coverUrl: `/api/v1/covers/${r.book_id}`,
    goodreadsUrl: r.goodreads_url || `https://www.goodreads.com/book/show/${r.book_id}`,
  };
}

router.get('/', requireUser, wrap(async (req, res) => {
  const db = getDb();
  const rows = db.prepare(SELECT).all(req.user.id);
  let books = rows.map(toBook);

  const q = String(req.query.q ?? '').trim().toLowerCase();
  if (q) {
    books = books.filter((b) =>
      b.title.toLowerCase().includes(q) ||
      b.author.toLowerCase().includes(q) ||
      (b.series ?? '').toLowerCase().includes(q) ||
      // Your own notes are searchable too: it is often the only place you
      // recorded why a book mattered.
      b.notes.toLowerCase().includes(q));
  }
  const shelf = String(req.query.shelf ?? '').trim();
  if (shelf) books = books.filter((b) => b.exclusiveShelf === shelf || b.shelves.includes(shelf));

  const totals = {
    books: rows.length,
    withCover: rows.filter((r) => r.cover_status === 'ok').length,
    withPalette: rows.filter((r) => r.eff_bg).length,
    withRealDimensions: rows.filter((r) => ['openlibrary', 'googlebooks', 'override'].includes(r.eff_dims_source)).length,
    enrichPending: db.prepare(
      `SELECT COUNT(*) AS n FROM books b JOIN user_books ub ON ub.book_id = b.book_id
       WHERE ub.user_id = ? AND b.enrich_state = 'pending'`).get(req.user.id).n,
  };

  // To-read gets its own labelled section on the shelf, so the client is told
  // which ids belong where rather than re-deriving the rule.
  const sections = {
    library: books.filter((b) => b.exclusiveShelf !== 'to-read').map((b) => b.id),
    toRead: books.filter((b) => b.exclusiveShelf === 'to-read').map((b) => b.id),
  };

  res.json({ books, sections, totals });
}));

/**
 * Your rating and your notes for one book.
 *
 * Deliberately a separate column from the Goodreads rating: that one is
 * overwritten by every sync, and these are not.
 */
router.patch('/:bookId', requireUser, wrap(async (req, res) => {
  const db = getDb();
  const owned = db.prepare('SELECT 1 FROM user_books WHERE user_id = ? AND book_id = ?')
    .get(req.user.id, req.params.bookId);
  if (!owned) throw new HttpError(404, 'book not found on your shelf');

  const body = req.body ?? {};
  const sets = [];
  const vals = [];

  if (body.myRating !== undefined) {
    if (body.myRating === null) {
      sets.push('my_rating = NULL');
    } else {
      const n = Number(body.myRating);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        throw new HttpError(400, 'a rating is a whole number of stars from 1 to 5, or null to clear it');
      }
      sets.push('my_rating = ?');
      vals.push(n);
    }
  }

  if (body.notes !== undefined) {
    const notes = String(body.notes ?? '');
    if (notes.length > 20000) throw new HttpError(400, 'that note is too long');
    sets.push('notes = ?', 'notes_updated_at = ?');
    vals.push(notes, notes.trim() ? isoNow() : null);
  }

  if (!sets.length) throw new HttpError(400, 'nothing to update');

  vals.push(req.user.id, req.params.bookId);
  db.prepare(`UPDATE user_books SET ${sets.join(', ')} WHERE user_id = ? AND book_id = ?`).run(...vals);

  const row = db.prepare(`${SELECT} AND ub.book_id = ?`).get(req.user.id, req.params.bookId);
  res.json(toBook(row));
}));

router.get('/:bookId', requireUser, wrap(async (req, res) => {
  const row = getDb().prepare(`${SELECT} AND ub.book_id = ?`).get(req.user.id, req.params.bookId);
  if (!row) throw new HttpError(404, 'book not found on your shelf');
  res.json(toBook(row));
}));
