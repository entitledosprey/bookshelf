import express from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configWarnings } from './config.js';
import { openDb, getDb } from './db.js';
import { HttpError } from './http.js';
import { router as authRouter } from './routes/auth.js';
import { router as booksRouter } from './routes/books.js';
import { router as coversRouter } from './routes/covers.js';
import { router as syncRouter } from './routes/sync.js';
import { router as adminRouter } from './routes/admin.js';
import { router as demoRouter } from './routes/demo.js';
import { router as decorationsRouter } from './routes/decorations.js';
import { seedDemo } from './demo/seed.js';
import { startScheduler, requestSync, syncRunning, nextSyncAt } from './scheduler.js';
import { pendingCount } from './enrich/worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // 6mb, because a framed photograph arrives as a base64 data URL.
  app.use(express.json({ limit: '6mb' }));

  app.locals.requestSync = requestSync;
  app.locals.syncRunning = syncRunning;
  app.locals.nextSyncAt = nextSyncAt;

  // CORS only when explicitly configured -- needed for a native dev client.
  if (config.corsOrigins.length) {
    app.use((req, res, next) => {
      const origin = req.get('origin');
      if (origin && config.corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });
  }

  /**
   * Healthcheck never touches Goodreads or any third party: the Docker
   * HEALTHCHECK depends on it, and a rate-limited upstream must not be able to
   * make the container look unhealthy.
   */
  app.get('/healthz', (_req, res) => {
    let books = 0;
    let pending = 0;
    try {
      books = getDb().prepare('SELECT COUNT(*) AS n FROM books').get().n;
      pending = pendingCount();
    } catch { /* db not ready */ }
    res.json({ ok: true, uptime: Math.round(process.uptime()), books, enrichPending: pending });
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/books', booksRouter);
  app.use('/api/v1/covers', coversRouter);
  app.use('/api/v1/sync', syncRouter);
  app.use('/api/v1/decorations', decorationsRouter);
  app.use('/api/v1/admin', adminRouter);
  // Public: the shelf a visitor sees before they have an account.
  app.use('/api/v1/demo', demoRouter);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'no such endpoint')));

  // Static SPA. No server-rendered templates anywhere, so there is no view
  // layer to strip out when the iOS client arrives.
  if (existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR, {
      setHeaders: (res, path) => {
        if (/\/assets\//.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[error]', err);
    res.status(status).json({ error: err.message || 'internal error' });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  openDb();
  // Baked into the image, so this needs no network and is instant.
  console.log(`[demo] seeded ${seedDemo()} demo books`);
  for (const w of configWarnings()) console.warn('[config]', w);
  const app = createApp();
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[bookshelf] listening on :${config.port} db=${config.dbPath}`);
    startScheduler();
  });
}
