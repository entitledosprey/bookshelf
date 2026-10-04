import { config } from '../config.js';
import { HttpError } from '../http.js';
import { userForToken, COOKIE_NAME } from './sessions.js';
import { safeEqual } from './passwords.js';

/** Minimal cookie parse; we set exactly one cookie and need no dependency. */
function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export function tokenFromRequest(req) {
  const auth = req.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return cookieValue(req.get('cookie'), COOKIE_NAME);
}

export function requireUser(req, _res, next) {
  const user = userForToken(tokenFromRequest(req));
  if (!user) return next(new HttpError(401, 'authentication required'));
  req.user = user;
  req.token = tokenFromRequest(req);
  next();
}

/**
 * Admin access, two ways in:
 *
 *  - a signed-in user whose account is flagged is_admin, which is what the
 *    admin panel in the UI uses; the first account created owns the instance
 *  - the ADMIN_API_KEY header, kept as break-glass for scripting and for
 *    recovering an instance with no usable admin account
 *
 * Header only, never a query parameter: a key in a URL lands in nginx access
 * logs and browser history.
 */
export function requireAdmin(req, _res, next) {
  const user = userForToken(tokenFromRequest(req));
  if (user?.is_admin) {
    req.user = user;
    req.token = tokenFromRequest(req);
    return next();
  }
  const given = req.get('x-admin-key') ?? '';
  if (config.adminApiKey && given && safeEqual(given, config.adminApiKey)) return next();
  // Do not advertise the surface to someone who is simply not an admin.
  return next(new HttpError(user ? 403 : 401, 'administrator access required'));
}

/** In-memory throttle. Keyed by ip+bucket; nginx limit_req is the outer layer. */
const hits = new Map();
export function throttle({ bucket, max = 10, windowMs = 60_000 }) {
  return (req, _res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now > rec.resetAt) {
      hits.set(key, { n: 1, resetAt: now + windowMs });
      return next();
    }
    rec.n += 1;
    if (rec.n > max) return next(new HttpError(429, 'too many requests, slow down'));
    next();
  };
}

export const _resetThrottle = () => hits.clear();
