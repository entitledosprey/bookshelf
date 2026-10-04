import express from 'express';
import { getDb } from '../db.js';
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
  email: row.email,
  goodreadsUserId: row.goodreads_user_id ?? null,
  isAdmin: !!row.is_admin,
  prefs: prefsOf(row),
  lastSyncAt: row.last_sync_at ?? null,
});

/**
 * Registration is invite-only: there is no open signup, so the abuse surface is
 * whoever you hand a code to, and Goodreads polling stays bounded.
 */
router.post('/register', throttle({ bucket: 'register', max: 10 }), wrap(async (req, res) => {
  const db = getDb();
  const code = reqStr(req.body, 'inviteCode', { max: 64 });
  const email = reqStr(req.body, 'email', { max: 200 }).toLowerCase();
  const password = reqStr(req.body, 'password', { max: 200 });
  const goodreadsUserId = reqStr(req.body, 'goodreadsUserId', { max: 64, required: false });
  const rssKey = reqStr(req.body, 'goodreadsRssKey', { max: 128, required: false });

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'that does not look like an email address');
  if (password.length < 8) throw new HttpError(400, 'password must be at least 8 characters');

  const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
  if (!invite) throw new HttpError(400, 'unknown invite code');
  if (invite.used_by) throw new HttpError(400, 'that invite code has already been used');
  if (new Date(invite.expires_at) <= new Date()) throw new HttpError(400, 'that invite code has expired');

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'an account with that email already exists');
  }

  const id = db.prepare(`INSERT INTO users
      (email, password_hash, goodreads_user_id, goodreads_rss_key, prefs_json, created_at)
      VALUES (?,?,?,?,?,?)`)
    .run(email, scryptHash(password), goodreadsUserId || null, rssKey || null,
         JSON.stringify(DEFAULT_PREFS), isoNow()).lastInsertRowid;

  db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(id, isoNow(), code);

  const { token, expiresAt } = issueSession(id, req.get('user-agent'));
  res.setHeader('Set-Cookie', sessionCookie(token, expiresAt));
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  // Queue this user's first sync without blocking the response.
  req.app.locals.requestSync?.(id, 'register');

  res.status(201).json({ token, expiresAt, user: meJson(row) });
}));

router.post('/login', throttle({ bucket: 'login', max: 10 }), wrap(async (req, res) => {
  const email = reqStr(req.body, 'email', { max: 200 }).toLowerCase();
  const password = reqStr(req.body, 'password', { max: 200 });
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Same message either way: do not reveal which accounts exist.
  if (!row || !scryptVerify(password, row.password_hash)) {
    throw new HttpError(401, 'incorrect email or password');
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

/** Also expose whether registration is even possible, so the UI can explain. */
router.get('/config', (_req, res) => {
  res.json({ invitesEnabled: !!config.adminApiKey });
});
