import express from 'express';
import { getDb, metaGet } from '../db.js';
import { wrap, HttpError } from '../http.js';
import { requireUser, throttle } from '../auth/middleware.js';

export const router = express.Router();

const bool = (v) => (v == null ? null : v === 'true');

router.get('/status', requireUser, wrap(async (req, res) => {
  const db = getDb();
  const last = db.prepare(
    'SELECT * FROM sync_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 1',
  ).get(req.user.id);

  const running = req.app.locals.syncRunning?.(req.user.id) ?? false;

  let explanation;
  if (!last) explanation = 'No sync has run yet for this account.';
  else if (last.complete) {
    explanation = `Every shelf walk ended on a short page, so all ${last.items_seen} books on your shelves were enumerated. The store is provably complete.`;
  } else if (last.status === 'failed') {
    explanation = 'The last sync failed. The shelf below still renders from the stored library, which is never deleted.';
  } else {
    explanation = 'The last sync did not finish every shelf, so coverage may be partial. It will resume on the next run.';
  }

  res.json({
    running,
    nextRunAt: req.app.locals.nextSyncAt?.() ?? null,
    lastRun: last
      ? {
          id: last.id,
          startedAt: last.started_at,
          finishedAt: last.finished_at,
          trigger: last.trigger,
          status: last.status,
          pagesFetched: last.pages_fetched,
          itemsSeen: last.items_seen,
          booksNew: last.books_new,
          booksUpdated: last.books_updated,
          error: last.error,
        }
      : null,
    // What the running system has actually observed, rather than what the
    // documentation claims. See src/goodreads/feed.js for the measurements.
    capability: {
      perPage200Works: bool(metaGet('capability.perPage200Works')),
      pageParamWorks: bool(metaGet('capability.pageParamWorks')),
    },
    coverage: { complete: !!last?.complete, explanation },
  });
}));

router.get('/runs', requireUser, wrap(async (req, res) => {
  const rows = getDb().prepare(
    'SELECT * FROM sync_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 20',
  ).all(req.user.id);
  res.json(rows);
}));

router.post('/run', requireUser, throttle({ bucket: 'sync', max: 4, windowMs: 300_000 }),
  wrap(async (req, res) => {
    if (!req.user.goodreads_user_id) {
      throw new HttpError(400, 'add your Goodreads user id to your account first');
    }
    const queued = req.app.locals.requestSync?.(req.user.id, 'manual');
    if (queued === false) throw new HttpError(409, 'a sync is already running for this account');
    res.status(202).json({ queued: true });
  }));
