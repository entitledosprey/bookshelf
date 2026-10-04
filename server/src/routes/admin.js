import express from 'express';
import { randomBytes } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { wrap, isoNow, HttpError } from '../http.js';
import { requireAdmin } from '../auth/middleware.js';

export const router = express.Router();

// With ADMIN_API_KEY unset, requireAdmin 404s the whole surface.
router.use(requireAdmin);

/** Human-friendly code: no ambiguous characters, grouped for reading aloud. */
function inviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

router.post('/invites', wrap(async (_req, res) => {
  const code = inviteCode();
  const expires = new Date(Date.now() + config.inviteTtlDays * 86_400_000).toISOString();
  getDb().prepare('INSERT INTO invites (code, created_at, expires_at) VALUES (?,?,?)')
    .run(code, isoNow(), expires);
  res.status(201).json({ code, expiresAt: expires });
}));

router.get('/invites', wrap(async (_req, res) => {
  res.json(getDb().prepare(`SELECT i.code, i.created_at, i.expires_at, i.used_at, u.email AS used_by
    FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 50`).all());
}));

router.get('/users', wrap(async (_req, res) => {
  res.json(getDb().prepare(`SELECT u.id, u.email, u.goodreads_user_id, u.created_at, u.last_sync_at,
      (SELECT COUNT(*) FROM user_books ub WHERE ub.user_id = u.id) AS books
    FROM users u ORDER BY u.created_at`).all());
}));

/** Manual correction. Writes book_overrides, which every read path prefers. */
router.patch('/books/:bookId', wrap(async (req, res) => {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM books WHERE book_id = ?').get(req.params.bookId)) {
    throw new HttpError(404, 'unknown book');
  }
  const f = req.body ?? {};
  db.prepare(`INSERT INTO book_overrides
      (book_id, height_mm, width_mm, thickness_mm, binding, palette_bg, palette_accent,
       palette_fg, spine_style, display_title, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(book_id) DO UPDATE SET
        height_mm=COALESCE(excluded.height_mm, book_overrides.height_mm),
        width_mm=COALESCE(excluded.width_mm, book_overrides.width_mm),
        thickness_mm=COALESCE(excluded.thickness_mm, book_overrides.thickness_mm),
        binding=COALESCE(excluded.binding, book_overrides.binding),
        palette_bg=COALESCE(excluded.palette_bg, book_overrides.palette_bg),
        palette_accent=COALESCE(excluded.palette_accent, book_overrides.palette_accent),
        palette_fg=COALESCE(excluded.palette_fg, book_overrides.palette_fg),
        spine_style=COALESCE(excluded.spine_style, book_overrides.spine_style),
        display_title=COALESCE(excluded.display_title, book_overrides.display_title),
        updated_at=excluded.updated_at`)
    .run(req.params.bookId, f.heightMm ?? null, f.widthMm ?? null, f.thicknessMm ?? null,
         f.binding ?? null, f.paletteBg ?? null, f.paletteAccent ?? null, f.paletteFg ?? null,
         f.spineStyle ?? null, f.displayTitle ?? null, isoNow());
  res.json(db.prepare('SELECT * FROM book_overrides WHERE book_id = ?').get(req.params.bookId));
}));

/** Force re-enrichment, e.g. after bumping PALETTE_VERSION. */
router.post('/reenrich', wrap(async (req, res) => {
  const db = getDb();
  const ids = Array.isArray(req.body?.bookIds) ? req.body.bookIds : null;
  if (ids?.length) {
    const stmt = db.prepare("UPDATE books SET enrich_state='pending', enrich_attempts=0, enrich_retry_after=NULL WHERE book_id=?");
    for (const id of ids) stmt.run(String(id));
    return res.json({ queued: ids.length });
  }
  const n = db.prepare("UPDATE books SET enrich_state='pending', enrich_attempts=0, enrich_retry_after=NULL").run().changes;
  res.json({ queued: n });
}));
