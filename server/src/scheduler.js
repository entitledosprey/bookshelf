import { getDb } from './db.js';
import { config } from './config.js';
import { syncUser } from './goodreads/sync.js';
import { drainEnrichment, pendingCount } from './enrich/worker.js';
import { pruneExpiredSessions } from './auth/sessions.js';
import { drainDemoCovers, demoCoversPending } from './demo/covers.js';

/**
 * In-process scheduler. One container, one long-lived process, so a module
 * variable is a perfectly good mutex and /api/v1/sync/status can read live
 * progress straight from memory. No cron container, no node-cron dependency.
 *
 * Users are walked SERIALLY and every outbound request additionally passes
 * through the per-host queue in net/politeFetch.js, so N users never means N
 * concurrent requests against Goodreads.
 */

const runningUsers = new Set();
let queue = [];
let ticking = false;
let nextRunAt = null;
let timer = null;

export const syncRunning = (userId) => runningUsers.has(userId);
export const nextSyncAt = () => nextRunAt;

/** Returns false if that user already has a sync running or queued. */
export function requestSync(userId, trigger = 'manual') {
  if (runningUsers.has(userId) || queue.some((q) => q.userId === userId)) return false;
  queue.push({ userId, trigger });
  void pump();
  return true;
}

async function pump() {
  if (ticking) return;
  ticking = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(job.userId);
      if (!user) continue;
      runningUsers.add(user.id);
      try {
        const r = await syncUser(user, { trigger: job.trigger });
        console.log(`[sync] user=${user.id} status=${r.status} pages=${r.pages ?? 0} items=${r.items ?? 0} new=${r.added ?? 0}${r.error ? ` error=${r.error}` : ''}`);
      } catch (err) {
        console.error(`[sync] user=${user.id} threw:`, err?.message ?? err);
      } finally {
        runningUsers.delete(user.id);
      }
    }

    // Drain enrichment after syncing, while we are already awake.
    if (config.enrichEnabled) {
      try {
        const r = await drainEnrichment();
        if (r.processed || r.failed) {
          console.log(`[enrich] processed=${r.processed} failed=${r.failed} pending=${pendingCount()}`);
        }
      } catch (err) {
        console.error('[enrich] threw:', err?.message ?? err);
      }
    }
  } finally {
    ticking = false;
  }
}

/** Queue every user whose last sync is older than the interval. */
function enqueueDueUsers() {
  const cutoff = new Date(Date.now() - config.syncIntervalHours * 3_600_000).toISOString();
  const due = getDb().prepare(
    `SELECT id FROM users
     WHERE goodreads_user_id IS NOT NULL AND goodreads_user_id != ''
       AND (last_sync_at IS NULL OR last_sync_at < ?)`,
  ).all(cutoff);
  for (const u of due) requestSync(u.id, 'schedule');
}

/**
 * setTimeout stores its delay in a 32-bit signed int. A delay above this is
 * silently clamped to 1ms by Node, which turns the scheduler into a tight loop
 * -- so a generous SYNC_INTERVAL_HOURS must be capped, not trusted.
 */
const MAX_TIMEOUT_MS = 2_147_483_647; // ~24.8 days

/**
 * Demo cover art gets its OWN short-interval loop that stops as soon as the set
 * is complete, rather than riding the 12-hour sync tick -- at 8 covers per tick
 * that would have taken days to fill a 92-book demo shelf.
 *
 * Spine colour is already baked into the fixture, so this only adds the
 * tap-to-open artwork and never blocks the demo shelf from rendering.
 */
function startDemoCovers() {
  let timer = null;
  const tick = async () => {
    try {
      if (demoCoversPending() === 0) {
        console.log('[demo] cover art complete');
        return; // self-terminating: nothing left to fetch
      }
      const d = await drainDemoCovers({ limit: 8 });
      if (d.fetched) console.log(`[demo] fetched ${d.fetched} cover(s), ${demoCoversPending()} remaining`);
    } catch (err) {
      console.error('[demo] cover fetch failed:', err?.message ?? err);
    }
    timer = setTimeout(tick, 20_000);
    timer.unref?.();
  };
  timer = setTimeout(tick, 3_000);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function startScheduler() {
  const intervalMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(60_000, config.syncIntervalHours * 3_600_000),
  );

  const schedule = () => {
    // +/-10% jitter so restarts do not align every instance on the same minute.
    const jitter = Math.min(MAX_TIMEOUT_MS, intervalMs * (0.9 + Math.random() * 0.2));
    nextRunAt = new Date(Date.now() + jitter).toISOString();
    timer = setTimeout(tick, jitter);
    timer.unref?.();
  };

  const tick = async () => {
    try {
      pruneExpiredSessions();
      enqueueDueUsers();
      await pump();
      // Keep draining enrichment even when no sync was due.
      if (config.enrichEnabled && pendingCount() > 0) await drainEnrichment();
    } catch (err) {
      console.error('[scheduler] tick failed:', err?.message ?? err);
    } finally {
      schedule();
    }
  };

  // First pass shortly after boot, so a fresh container fills its shelf without
  // waiting out a whole interval.
  const boot = setTimeout(tick, 8_000);
  boot.unref?.();
  schedule();

  const stopDemo = startDemoCovers();

  return () => { clearTimeout(timer); clearTimeout(boot); stopDemo(); };
}
