import express from 'express';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { wrap, HttpError } from '../http.js';
import { demoShelf, DEMO_COUNT } from '../demo/seed.js';

export const router = express.Router();

/**
 * The public demo shelf. No authentication: this is what a visitor sees before
 * they have an account, so the site can show what it is rather than describe it.
 *
 * It serves a random sample from a curated set of real books, so the shelf
 * looks different on each visit. It is deliberately read-only and completely
 * separate from any real user's library.
 */
router.get('/books', wrap(async (req, res) => {
  const n = Math.min(80, Math.max(12, Number(req.query.limit) || 48));
  const books = demoShelf(n);
  res.setHeader('Cache-Control', 'no-store'); // a fresh sample every visit
  res.json({
    books,
    sections: { library: books.map((b) => b.id), toRead: [] },
    totals: {
      books: books.length,
      pool: DEMO_COUNT,
      withCover: books.filter((b) => b.hasCover).length,
      withPalette: books.length,
      withRealDimensions: books.filter((b) => b.geometry.source !== 'heuristic').length,
      enrichPending: 0,
    },
    demo: true,
  });
}));

/** Demo cover art, also unauthenticated — but only ever for demo books. */
router.get('/covers/:bookId', wrap(async (req, res) => {
  const row = getDb()
    .prepare("SELECT cover_path, cover_type FROM demo_books WHERE book_id = ? AND cover_state = 'ok'")
    .get(req.params.bookId);
  if (!row?.cover_path) throw new HttpError(404, 'no cover cached for this book');

  const file = join(config.coverDir, row.cover_path);
  if (!existsSync(file)) throw new HttpError(404, 'no cover cached for this book');

  const { size, mtimeMs } = statSync(file);
  const etag = `"${req.params.bookId}-${size}-${Math.round(mtimeMs)}"`;
  if (req.get('if-none-match') === etag) return res.status(304).end();

  res.setHeader('Content-Type', row.cover_type || 'image/jpeg');
  res.setHeader('Content-Length', String(size));
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  createReadStream(file).pipe(res);
}));
