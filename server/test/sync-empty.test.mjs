import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRssSink } from './rss-sink.mjs';

/**
 * Regression: an account with nothing on one of its exclusive shelves.
 *
 * Goodreads answers an empty shelf with a well-formed, item-less feed. Treating
 * that as "the format changed" aborted the whole sync and reported failure to
 * someone whose library had in fact synced perfectly well.
 */
const dir = mkdtempSync(join(tmpdir(), 'bookshelf-empty-'));
let sink;
let db;

before(async () => {
  // currently-reading is empty; the other two shelves return the fixture.
  sink = await startRssSink({ emptyShelves: ['currently-reading'] });
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.COVER_DIR = join(dir, 'covers');
  process.env.ENRICH_ENABLED = 'false';
  process.env.GOODREADS_BASE_URL = sink.url;
  process.env.GOODREADS_MIN_DELAY_MS = '1';
  const m = await import('../src/db.js');
  db = m.freshTestDb();
});

after(async () => {
  await sink?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an empty shelf does not fail the sync', async () => {
  const { isoNow } = await import('../src/http.js');
  db.prepare(`INSERT INTO users (id, username, password_hash, goodreads_user_id, created_at)
              VALUES (1, 'reader', 'x', '12345', ?)`).run(isoNow());
  const user = db.prepare('SELECT * FROM users WHERE id = 1').get();

  const { syncUser } = await import('../src/goodreads/sync.js');
  const result = await syncUser(user, { trigger: 'manual' });

  assert.equal(result.status, 'ok',
    `an empty shelf must not fail the run (error was: ${result.error})`);
  assert.equal(result.error, '', 'an empty shelf should not even produce a note');
  assert.ok(result.added > 0, 'the populated shelves should still have been merged');
  assert.equal(result.complete, true, 'coverage is complete: every shelf was walked to its end');
});

test('books from the populated shelves are stored', () => {
  const n = db.prepare('SELECT COUNT(*) n FROM user_books WHERE user_id = 1').get().n;
  assert.ok(n > 0);
  // Nothing should be attributed to the empty shelf.
  const cr = db.prepare("SELECT COUNT(*) n FROM user_books WHERE exclusive_shelf = 'currently-reading'").get().n;
  assert.equal(cr, 0);
});
