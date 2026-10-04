import { getDb } from '../db.js';
import { userAgent } from '../config.js';

/**
 * Every outbound request in this app goes through here.
 *
 * Per-host serial queues with a minimum gap, so N users syncing concurrently
 * still produce one request at a time against Goodreads. This is the single
 * mechanism that keeps a multi-user install from looking like a scraper.
 */

const HOSTS = {
  'www.goodreads.com':        { minIntervalMs: 1500, cooldownMs: 60 * 60_000, strikes: 2 },
  'openlibrary.org':          { minIntervalMs: 1000, cooldownMs: 15 * 60_000, strikes: 3 },
  'covers.openlibrary.org':   { minIntervalMs: 1200, cooldownMs: 10 * 60_000, strikes: 3 },
  // Unauthenticated Google Books 429s almost immediately from a cold IP and
  // stays angry, so one strike buys a long rest rather than a retry storm.
  'www.googleapis.com':       { minIntervalMs: 1500, cooldownMs: 24 * 60 * 60_000, strikes: 1 },
  default:                    { minIntervalMs: 1000, cooldownMs: 10 * 60_000, strikes: 3 },
};

const policyFor = (host) => HOSTS[host] ?? HOSTS.default;

/** host -> tail of the serial chain, so requests queue instead of racing. */
const chains = new Map();
/** host -> consecutive 429/403 count. */
const strikes = new Map();

export class CooldownError extends Error {
  constructor(host, until) {
    super(`${host} is in cooldown until ${until}`);
    this.host = host;
    this.until = until;
    this.cooldown = true;
  }
}

export function cooldownUntil(host) {
  try {
    const row = getDb().prepare('SELECT until FROM host_cooldowns WHERE host = ?').get(host);
    if (!row) return null;
    return new Date(row.until) > new Date() ? row.until : null;
  } catch {
    return null; // db not open (unit tests): treat as no cooldown
  }
}

function setCooldown(host, ms, reason) {
  const until = new Date(Date.now() + ms).toISOString();
  try {
    getDb()
      .prepare(`INSERT INTO host_cooldowns (host, until, reason) VALUES (?, ?, ?)
                ON CONFLICT(host) DO UPDATE SET until = excluded.until, reason = excluded.reason`)
      .run(host, until, reason);
  } catch { /* unit tests without a db */ }
  return until;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serialise work per host with a minimum gap between starts. */
function enqueue(host, fn) {
  const { minIntervalMs } = policyFor(host);
  const prev = chains.get(host) ?? Promise.resolve(0);
  const next = prev.then(async (lastStart) => {
    const wait = Math.max(0, (lastStart || 0) + minIntervalMs - Date.now());
    if (wait > 0) await sleep(wait);
    const startedAt = Date.now();
    try {
      return { startedAt, result: await fn() };
    } catch (err) {
      return { startedAt, error: err };
    }
  });
  chains.set(host, next.then((o) => o.startedAt));
  return next.then((o) => {
    if (o.error) throw o.error;
    return o.result;
  });
}

/**
 * @param {string} url
 * @param {{timeoutMs?:number, retries?:number, etag?:string, lastModified?:string,
 *          accept?:string, binary?:boolean, ignoreCooldown?:boolean}} opts
 * @returns {Promise<{status:number, body:string|Buffer|null, etag:string|null,
 *                    lastModified:string|null, contentType:string, notModified:boolean}>}
 */
export async function politeFetch(url, opts = {}) {
  const { timeoutMs = 20_000, retries = 3, etag, lastModified, accept, binary = false } = opts;
  const host = new URL(url).hostname;
  const policy = policyFor(host);

  if (!opts.ignoreCooldown) {
    const until = cooldownUntil(host);
    if (until) throw new CooldownError(host, until);
  }

  return enqueue(host, async () => {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const headers = { 'User-Agent': userAgent(), Accept: accept ?? (binary ? 'image/*' : '*/*') };
      if (etag) headers['If-None-Match'] = etag;
      if (lastModified) headers['If-Modified-Since'] = lastModified;

      let res;
      try {
        res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (attempt > retries) throw err;
        await sleep(Math.min(60_000, 2 ** attempt * 1000) + Math.random() * 500);
        continue;
      }

      if (res.status === 429 || res.status === 403 || res.status === 503) {
        const n = (strikes.get(host) ?? 0) + 1;
        strikes.set(host, n);
        if (n >= policy.strikes) {
          strikes.set(host, 0);
          const until = setCooldown(host, policy.cooldownMs, `HTTP ${res.status}`);
          throw new CooldownError(host, until);
        }
        if (attempt > retries) {
          const until = setCooldown(host, policy.cooldownMs, `HTTP ${res.status}`);
          throw new CooldownError(host, until);
        }
        // Honour Retry-After when present, else exponential backoff.
        const ra = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(ra) && ra > 0
          ? Math.min(120_000, ra * 1000)
          : Math.min(60_000, 2 ** attempt * 1000) + Math.random() * 500;
        await sleep(waitMs);
        continue;
      }

      strikes.set(host, 0);

      if (res.status === 304) {
        return { status: 304, body: null, etag: etag ?? null, lastModified: lastModified ?? null, contentType: '', notModified: true };
      }

      const body = res.ok
        ? (binary ? Buffer.from(await res.arrayBuffer()) : await res.text())
        : null;

      return {
        status: res.status,
        body,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        contentType: res.headers.get('content-type') ?? '',
        notModified: false,
      };
    }
  });
}

/** Test seam: drop queue state between cases. */
export function _resetQueues() {
  chains.clear();
  strikes.clear();
}
