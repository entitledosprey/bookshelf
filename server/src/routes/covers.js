import express from 'express';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { wrap, HttpError } from '../http.js';
import { requireUser } from '../auth/middleware.js';

export const router = express.Router();

/** Covers are served off the local disk cache, never proxied live upstream. */
router.get('/:bookId', requireUser, wrap(async (req, res) => {
  const { bookId } = req.params;

  // Authorisation: only serve a cover for a book on this user's own shelf.
  const owned = getDb()
    .prepare('SELECT 1 FROM user_books WHERE user_id = ? AND book_id = ?')
    .get(req.user.id, bookId);
  if (!owned) throw new HttpError(404, 'not found');

  const row = getDb().prepare('SELECT path, content_type FROM covers WHERE book_id = ?').get(bookId);
  if (!row?.path) throw new HttpError(404, 'no cover cached for this book');

  const file = join(config.coverDir, row.path);
  if (!existsSync(file)) throw new HttpError(404, 'no cover cached for this book');

  const { size, mtimeMs } = statSync(file);
  const etag = `"${bookId}-${size}-${Math.round(mtimeMs)}"`;
  if (req.get('if-none-match') === etag) return res.status(304).end();

  res.setHeader('Content-Type', row.content_type || 'image/jpeg');
  res.setHeader('Content-Length', String(size));
  res.setHeader('ETag', etag);
  // Cover bytes for a given book never change in place.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  createReadStream(file).pipe(res);
}));
