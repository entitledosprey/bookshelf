import express from 'express';
import { getDb, metaGet, metaSet } from '../db.js';
import { wrap, isoNow, HttpError, reqStr } from '../http.js';
import { requireAdmin } from '../auth/middleware.js';
import { scryptHash } from '../auth/passwords.js';
import { pendingCount } from '../enrich/worker.js';
import { demoCoversPending } from '../demo/covers.js';
import { DEMO_COUNT } from '../demo/seed.js';
import { signupsEnabled, parseGoodreadsUserId } from './auth.js';

export const router = express.Router();
router.use(requireAdmin);

const num = (q) => getDb().prepare(q).get().n;

/** Everything an operator needs to see at a glance. */
router.get('/overview', wrap(async (_req, res) => {
  const db = getDb();
  res.json({
    users: num('SELECT COUNT(*) n FROM users'),
    admins: num('SELECT COUNT(*) n FROM users WHERE is_admin = 1'),
    sessions: num('SELECT COUNT(*) n FROM sessions'),
    books: num('SELECT COUNT(*) n FROM books'),
    shelvings: num('SELECT COUNT(*) n FROM user_books'),
    covers: num("SELECT COUNT(*) n FROM covers WHERE status = 'ok'"),
    palettes: num('SELECT COUNT(*) n FROM covers WHERE palette_bg IS NOT NULL'),
    realDimensions: num("SELECT COUNT(*) n FROM books WHERE dims_source IN ('openlibrary','googlebooks','override')"),
    enrichPending: pendingCount(),
    enrichFailed: num("SELECT COUNT(*) n FROM books WHERE enrich_state = 'failed'"),
    demoBooks: DEMO_COUNT,
    demoCoversPending: demoCoversPending(),
    signupsEnabled: signupsEnabled(),
    cooldowns: db.prepare('SELECT host, until, reason FROM host_cooldowns WHERE until > ?').all(isoNow()),
    capability: {
      perPage200Works: metaGet('capability.perPage200Works'),
      pageParamWorks: metaGet('capability.pageParamWorks'),
    },
  });
}));

router.get('/users', wrap(async (_req, res) => {
  res.json(getDb().prepare(`
    SELECT u.id, u.username, u.email, u.goodreads_user_id,
           u.goodreads_rss_key IS NOT NULL AND u.goodreads_rss_key != '' AS has_rss_key,
           u.is_admin, u.created_at, u.last_sync_at,
           (SELECT COUNT(*) FROM user_books ub WHERE ub.user_id = u.id) AS books,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
           (SELECT status FROM sync_runs r WHERE r.user_id = u.id ORDER BY r.id DESC LIMIT 1) AS last_status,
           (SELECT error  FROM sync_runs r WHERE r.user_id = u.id ORDER BY r.id DESC LIMIT 1) AS last_error
    FROM users u ORDER BY u.id`).all());
}));

router.get('/runs', wrap(async (_req, res) => {
  res.json(getDb().prepare(`
    SELECT r.*, u.username FROM sync_runs r
    JOIN users u ON u.id = r.user_id
    ORDER BY r.started_at DESC LIMIT 30`).all());
}));

const userOr404 = (id) => {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!row) throw new HttpError(404, 'no such user');
  return row;
};

/** Promote or demote, with a guard against removing the last administrator. */
router.patch('/users/:id', wrap(async (req, res) => {
  const db = getDb();
  const target = userOr404(req.params.id);
  const body = req.body ?? {};

  if (body.isAdmin !== undefined) {
    const makeAdmin = !!body.isAdmin;
    if (!makeAdmin && target.is_admin) {
      const admins = num('SELECT COUNT(*) n FROM users WHERE is_admin = 1');
      if (admins <= 1) throw new HttpError(400, 'that is the only administrator left');
    }
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(makeAdmin ? 1 : 0, target.id);
  }

  if (body.goodreadsUserId !== undefined) {
    const { id, error } = parseGoodreadsUserId(body.goodreadsUserId);
    if (error) throw new HttpError(400, error);
    db.prepare('UPDATE users SET goodreads_user_id = ? WHERE id = ?').run(id || null, target.id);
  }

  res.json(db.prepare('SELECT id, username, is_admin, goodreads_user_id FROM users WHERE id = ?').get(target.id));
}));

/** Reset a password on someone's behalf, and sign them out everywhere. */
router.post('/users/:id/password', wrap(async (req, res) => {
  const target = userOr404(req.params.id);
  const next = reqStr(req.body, 'newPassword', { max: 200 });
  if (next.length < 8) throw new HttpError(400, 'the new password must be at least 8 characters');
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(scryptHash(next), target.id);
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  res.json({ ok: true, username: target.username });
}));

/** Sign a user out of every device without changing their password. */
router.post('/users/:id/signout', wrap(async (req, res) => {
  const target = userOr404(req.params.id);
  const n = getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id).changes;
  res.json({ ok: true, revoked: n });
}));

router.post('/users/:id/sync', wrap(async (req, res) => {
  const target = userOr404(req.params.id);
  if (!target.goodreads_user_id) throw new HttpError(400, 'that account has no Goodreads user id');
  const queued = req.app.locals.requestSync?.(target.id, 'manual');
  if (queued === false) throw new HttpError(409, 'a sync is already running for that account');
  res.status(202).json({ queued: true });
}));

/**
 * Delete an account and everything personal to it. Shared bibliographic rows in
 * `books` are deliberately left alone: other accounts may shelve the same book,
 * and re-fetching covers and palettes is expensive.
 */
router.delete('/users/:id', wrap(async (req, res) => {
  const target = userOr404(req.params.id);
  if (target.is_admin && num('SELECT COUNT(*) n FROM users WHERE is_admin = 1') <= 1) {
    throw new HttpError(400, 'that is the only administrator left');
  }
  if (req.user && req.user.id === target.id) {
    throw new HttpError(400, 'you cannot delete the account you are signed in with');
  }
  getDb().prepare('DELETE FROM users WHERE id = ?').run(target.id);
  res.json({ ok: true, deleted: target.username });
}));

/** Close or open registration without a redeploy. */
router.patch('/settings', wrap(async (req, res) => {
  if (req.body?.signupsEnabled !== undefined) {
    metaSet('signups_enabled', req.body.signupsEnabled ? 'true' : 'false');
  }
  res.json({ signupsEnabled: signupsEnabled() });
}));

/** Force re-enrichment, e.g. after bumping PALETTE_VERSION. */
router.post('/reenrich', wrap(async (req, res) => {
  const db = getDb();
  const ids = Array.isArray(req.body?.bookIds) ? req.body.bookIds : null;
  const reset = "enrich_state='pending', enrich_attempts=0, enrich_retry_after=NULL";
  if (ids?.length) {
    const stmt = db.prepare(`UPDATE books SET ${reset} WHERE book_id=?`);
    for (const id of ids) stmt.run(String(id));
    return res.json({ queued: ids.length });
  }
  res.json({ queued: db.prepare(`UPDATE books SET ${reset}`).run().changes });
}));

/** Manual correction of one book; every read path prefers these overrides. */
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
