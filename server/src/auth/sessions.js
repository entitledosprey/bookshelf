import { randomBytes, createHash } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { isoNow } from '../http.js';

/**
 * Opaque session tokens, accepted from either an Authorization: Bearer header
 * or an httpOnly cookie.
 *
 * One token works for both clients: the web app uses the cookie, so an XSS
 * cannot read it; a native iOS client sends the Bearer header and keeps the
 * token in the Keychain. Same table, same middleware, no duplicated auth.
 *
 * Only the SHA-256 of a token is stored, so a database leak does not hand over
 * live sessions.
 */

export const COOKIE_NAME = 'bookshelf_session';

const sha = (t) => createHash('sha256').update(t).digest('hex');

export function issueSession(userId, userAgent = '') {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionTtlDays * 86_400_000).toISOString();
  getDb()
    .prepare('INSERT INTO sessions (token_sha256, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)')
    .run(sha(token), userId, isoNow(), expires, String(userAgent).slice(0, 300));
  return { token, expiresAt: expires };
}

export function userForToken(token) {
  if (!token) return null;
  const row = getDb()
    .prepare(`SELECT u.*, s.expires_at FROM sessions s
              JOIN users u ON u.id = s.user_id
              WHERE s.token_sha256 = ?`)
    .get(sha(token));
  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) {
    getDb().prepare('DELETE FROM sessions WHERE token_sha256 = ?').run(sha(token));
    return null;
  }
  return row;
}

export const revokeSession = (token) =>
  getDb().prepare('DELETE FROM sessions WHERE token_sha256 = ?').run(sha(token));

export const pruneExpiredSessions = () =>
  getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(isoNow()).changes;

export function sessionCookie(token, expiresAt) {
  const bits = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (config.secureCookies) bits.push('Secure');
  return bits.join('; ');
}

export const clearCookie = () =>
  `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
