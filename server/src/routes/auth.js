import express from 'express';
import { createHash } from 'node:crypto';
import { getDb, metaGet } from '../db.js';
import { config } from '../config.js';
import { HttpError, wrap, isoNow, reqStr } from '../http.js';
import { scryptHash, scryptVerify } from '../auth/passwords.js';
import { issueSession, revokeSession, sessionCookie, clearCookie } from '../auth/sessions.js';
import { requireUser, throttle, tokenFromRequest } from '../auth/middleware.js';

export const router = express.Router();

const DEFAULT_PREFS = { theme: 'wood', order: 'author', scale: 1.6 };

const prefsOf = (row) => {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(row.prefs_json || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
};

export const meJson = (row) => ({
  id: row.id,
  username: row.username,
  email: row.email ?? null,
  goodreadsUserId: row.goodreads_user_id ?? null,
  isAdmin: !!row.is_admin,
  prefs: prefsOf(row),
  lastSyncAt: row.last_sync_at ?? null,
});

export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/** Signups can be closed by an administrator without redeploying. */
export const signupsEnabled = () => (metaGet('signups_enabled') ?? 'true') !== 'false';

/**
 * Open registration: a username and a password, nothing else required.
 *
 * Goodreads details are optional here so someone can get in and look around
 * first; the account settings panel collects them afterwards.
 */
router.post('/register', throttle({ bucket: 'register', max: 5, windowMs: 600_000 }),
  wrap(async (req, res) => {
    const db = getDb();
    if (!signupsEnabled()) throw new HttpError(403, 'new accounts are closed on this server');

    const username = reqStr(req.body, 'username', { max: 32 }).toLowerCase();
    const password = reqStr(req.body, 'password', { max: 200 });
    const goodreadsUserId = reqStr(req.body, 'goodreadsUserId', { max: 200, required: false });
    const rssKey = reqStr(req.body, 'goodreadsRssKey', { max: 200, required: false });

    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'usernames are 3-32 characters: letters, numbers, dashes and underscores');
    }
    if (password.length < 8) throw new HttpError(400, 'password must be at least 8 characters');

    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new HttpError(409, 'that username is taken');
    }

    // Accept a pasted profile URL or RSS link rather than demanding the raw id.
    const { id: grId, error: grError } = parseGoodreadsUserId(goodreadsUserId);
    if (grError) throw new HttpError(400, grError);
    const grKey = parseRssKey(rssKey);

    // The first account to exist runs the instance.
    const isFirst = db.prepare('SELECT COUNT(*) n FROM users').get().n === 0;

    const id = db.prepare(`INSERT INTO users
        (username, password_hash, goodreads_user_id, goodreads_rss_key, is_admin, prefs_json, created_at)
        VALUES (?,?,?,?,?,?,?)`)
      .run(username, scryptHash(password), grId || null, grKey || null,
           isFirst ? 1 : 0, JSON.stringify(DEFAULT_PREFS), isoNow()).lastInsertRowid;

    const { token, expiresAt } = issueSession(id, req.get('user-agent'));
    res.setHeader('Set-Cookie', sessionCookie(token, expiresAt));
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);

    if (grId) req.app.locals.requestSync?.(id, 'register');

    res.status(201).json({ token, expiresAt, user: meJson(row) });
  }));

router.post('/login', throttle({ bucket: 'login', max: 10 }), wrap(async (req, res) => {
  const ident = reqStr(req.body, 'username', { max: 200 }).toLowerCase();
  const password = reqStr(req.body, 'password', { max: 200 });

  // Accept an email as well as a username. Accounts created before usernames
  // existed were migrated by deriving one from their email address, and their
  // owners quite reasonably still type the email they signed up with.
  const row = getDb().prepare(
    'SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND lower(email) = ?) ORDER BY (username = ?) DESC LIMIT 1',
  ).get(ident, ident, ident);

  // Same message either way: do not reveal which accounts exist.
  if (!row || !scryptVerify(password, row.password_hash)) {
    throw new HttpError(401, 'incorrect username or password');
  }
  const { token, expiresAt } = issueSession(row.id, req.get('user-agent'));
  res.setHeader('Set-Cookie', sessionCookie(token, expiresAt));
  res.json({ token, expiresAt, user: meJson(row) });
}));

router.post('/logout', requireUser, wrap(async (req, res) => {
  revokeSession(tokenFromRequest(req));
  res.setHeader('Set-Cookie', clearCookie());
  res.status(204).end();
}));

router.get('/me', requireUser, wrap(async (req, res) => res.json(meJson(req.user))));

/**
 * Preferences live on the user row rather than localStorage so they follow the
 * account onto a future iOS client.
 */
router.patch('/prefs', requireUser, wrap(async (req, res) => {
  const current = prefsOf(req.user);
  const next = { ...current };
  const { theme, order, scale } = req.body ?? {};
  if (theme !== undefined) {
    if (!['wood', 'gallery', 'academia'].includes(theme)) throw new HttpError(400, 'unknown theme');
    next.theme = theme;
  }
  if (order !== undefined) {
    if (!['author', 'added', 'title', 'colour', 'pages'].includes(order)) throw new HttpError(400, 'unknown order');
    next.order = order;
  }
  if (scale !== undefined) {
    const s = Number(scale);
    if (!Number.isFinite(s) || s < 0.6 || s > 4) throw new HttpError(400, 'scale out of range');
    next.scale = s;
  }
  getDb().prepare('UPDATE users SET prefs_json = ? WHERE id = ?').run(JSON.stringify(next), req.user.id);
  res.json(next);
}));

/**
 * Accept the raw numeric id, or a pasted profile URL, which is what people
 * actually have in their clipboard. Rejects a display name outright: entering
 * one produces a 404 from Goodreads that is otherwise baffling to diagnose.
 */
export function parseGoodreadsUserId(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return { id: '' };
  const fromUrl = v.match(/goodreads\.com\/user\/show\/(\d+)/);
  const id = fromUrl ? fromUrl[1] : v;
  if (!/^\d+$/.test(id)) {
    return {
      error: 'that should be the NUMBER from your profile URL, not your name — ' +
             'open your Goodreads profile and copy the number from goodreads.com/user/show/152185079-your-name',
    };
  }
  return { id };
}

/** Accept the key on its own or the whole RSS link it came from. */
export function parseRssKey(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  const m = v.match(/[?&]key=([^&\s]+)/);
  return m ? decodeURIComponent(m[1]) : v;
}

/**
 * Update Goodreads details. Changing the user id or key invalidates nothing --
 * the store is append-only -- so a correction simply means the next sync walks
 * the new shelves and adds whatever it finds.
 */
router.patch('/account', requireUser, wrap(async (req, res) => {
  const body = req.body ?? {};
  const fields = [];
  const values = [];

  if (body.goodreadsUserId !== undefined) {
    const { id, error } = parseGoodreadsUserId(body.goodreadsUserId);
    if (error) throw new HttpError(400, error);
    fields.push('goodreads_user_id = ?');
    values.push(id || null);
  }

  if (body.goodreadsRssKey !== undefined) {
    const key = parseRssKey(body.goodreadsRssKey);
    if (key.length > 128) throw new HttpError(400, 'that key does not look right');
    fields.push('goodreads_rss_key = ?');
    values.push(key || null);
  }

  if (!fields.length) throw new HttpError(400, 'nothing to update');

  values.push(req.user.id);
  getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(meJson(row));
}));

/**
 * Change password. Requires the current one, and revokes every OTHER session so
 * a password change actually ends access from anywhere else.
 */
router.post('/password', requireUser, throttle({ bucket: 'password', max: 10 }),
  wrap(async (req, res) => {
    const current = reqStr(req.body, 'currentPassword', { max: 200 });
    const next = reqStr(req.body, 'newPassword', { max: 200 });
    if (next.length < 8) throw new HttpError(400, 'the new password must be at least 8 characters');
    if (!scryptVerify(current, req.user.password_hash)) {
      throw new HttpError(401, 'that is not your current password');
    }
    if (current === next) throw new HttpError(400, 'the new password must be different');

    getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(scryptHash(next), req.user.id);

    // Keep this session alive, drop the rest.
    getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND token_sha256 != ?')
      .run(req.user.id, createHash('sha256').update(req.token).digest('hex'));

    res.json({ ok: true });
  }));

/** Also expose whether registration is even possible, so the UI can explain. */
router.get('/config', (_req, res) => {
  res.json({ signupsEnabled: signupsEnabled() });
});
