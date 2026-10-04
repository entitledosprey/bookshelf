import { readFileSync } from 'node:fs';
import { getDb } from '../db.js';
import { isoNow } from '../http.js';

/**
 * The demo shelf: a curated set of real books, shown to visitors who are not
 * signed in so the site demonstrates itself without an account.
 *
 * Everything is baked into shelf.json by scripts/build-demo-fixture.mjs --
 * real titles, real page counts, and palettes extracted from real cover art
 * through the same chain the app uses for a signed-in library. Seeding
 * therefore needs no network, and the demo renders in full colour on a cold
 * container.
 *
 * Demo rows live in their own table rather than in books/user_books so they can
 * never be confused with, counted alongside, or returned to a real account.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL('./shelf.json', import.meta.url), 'utf8'),
);

export const DEMO_COUNT = FIXTURE.length;

const DDL = `
CREATE TABLE IF NOT EXISTS demo_books (
  book_id      TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  cover_path   TEXT NOT NULL DEFAULT '',
  cover_type   TEXT NOT NULL DEFAULT '',
  cover_url    TEXT NOT NULL DEFAULT '',
  cover_state  TEXT NOT NULL DEFAULT 'pending',
  seeded_at    TEXT NOT NULL
);
`;

export function seedDemo() {
  const db = getDb();
  db.exec(DDL);

  const ins = db.prepare(`
    INSERT INTO demo_books (book_id, payload_json, cover_url, seeded_at)
    VALUES (?,?,?,?)
    ON CONFLICT(book_id) DO UPDATE SET payload_json = excluded.payload_json`);

  const now = isoNow();
  db.exec('BEGIN');
  try {
    for (const b of FIXTURE) {
      const { coverUrl, ...payload } = b;
      ins.run(b.id, JSON.stringify(payload), coverUrl ?? '', now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return FIXTURE.length;
}

/** A random sample, so the shelf looks different on each visit. */
export function demoShelf(limit = 48) {
  const rows = getDb()
    .prepare('SELECT book_id, payload_json, cover_state FROM demo_books ORDER BY RANDOM() LIMIT ?')
    .all(limit);

  return rows.map((r) => {
    const b = JSON.parse(r.payload_json);
    return {
      ...b,
      exclusiveShelf: 'read',
      shelves: [],
      userRating: null,
      averageRating: null,
      dateAdded: null,
      palettePending: false,
      hasCover: r.cover_state === 'ok',
      // Distinguish "still being fetched" from "there is none", so the UI does
      // not claim a cover is missing while it is on its way.
      coverPending: r.cover_state === 'pending',
      coverUrl: `/api/v1/demo/covers/${b.id}`,
      goodreadsUrl: `https://www.goodreads.com/search?q=${encodeURIComponent(`${b.title} ${b.author}`)}`,
    };
  });
}
