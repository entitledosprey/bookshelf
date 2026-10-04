const str = (k, d = '') => (process.env[k] ?? d).trim();
const num = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) ? n : d; };
const bool = (k, d) => {
  const v = str(k).toLowerCase();
  if (v === '') return d;
  return v === 'true' || v === '1' || v === 'yes';
};

export const config = {
  port: num('PORT', 8080),
  dbPath: str('DB_PATH', './data/bookshelf.db'),
  coverDir: str('COVER_DIR', './data/covers'),

  adminApiKey: str('ADMIN_API_KEY'),
  sessionTtlDays: num('SESSION_TTL_DAYS', 90),
  inviteTtlDays: num('INVITE_TTL_DAYS', 14),
  secureCookies: bool('SECURE_COOKIES', true),
  corsOrigins: str('CORS_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean),

  syncIntervalHours: num('SYNC_INTERVAL_HOURS', 12),
  goodreadsMinDelayMs: num('GOODREADS_MIN_DELAY_MS', 1500),
  syncMaxPages: num('SYNC_MAX_PAGES', 40),
  goodreadsBaseUrl: str('GOODREADS_BASE_URL', 'https://www.goodreads.com'),

  enrichEnabled: bool('ENRICH_ENABLED', true),
  enrichPerTick: num('ENRICH_PER_TICK', 10),
  googleBooksKey: str('GOOGLE_BOOKS_API_KEY'),
  contactEmail: str('CONTACT_EMAIL'),
  publicUrl: str('PUBLIC_URL'),
};

/**
 * Open Library explicitly grants identified requests (a descriptive UA with
 * contact info) a 3x higher rate limit, so fill CONTACT_EMAIL if you can.
 */
export function userAgent() {
  const bits = [config.publicUrl && `+${config.publicUrl}`, config.contactEmail]
    .filter(Boolean)
    .join('; ');
  return bits ? `bookshelf/1.0 (${bits})` : 'bookshelf/1.0';
}

/** Warnings, never crashes: an unset subsystem stays inert by design. */
export function configWarnings() {
  const w = [];
  if (!config.adminApiKey) w.push('ADMIN_API_KEY is empty: /api/v1/admin/* returns 404, so no invites can be minted.');
  if (!config.googleBooksKey) w.push('GOOGLE_BOOKS_API_KEY is empty: Google Books will rate-limit quickly; Open Library carries enrichment.');
  if (!config.contactEmail) w.push('CONTACT_EMAIL is empty: Open Library applies its lower anonymous rate limit.');
  if (!config.enrichEnabled) w.push('ENRICH_ENABLED is false: spines use Goodreads covers and heuristic geometry only.');
  return w;
}
