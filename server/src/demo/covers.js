import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { politeFetch } from '../net/politeFetch.js';
import { decodeImage } from '../palette.js';

/**
 * Demo cover art is fetched lazily in the background and cached to the data
 * volume, exactly like real covers. Spines never wait on it: their colour is
 * already baked into the fixture, so a cold container shows a full-colour shelf
 * immediately and the cover images fill in behind it.
 */
export async function drainDemoCovers({ limit = 8 } = {}) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT book_id, cover_url FROM demo_books
     WHERE cover_state = 'pending' AND cover_url != '' LIMIT ?`,
  ).all(limit);
  if (!rows.length) return { fetched: 0 };

  mkdirSync(config.coverDir, { recursive: true });
  let fetched = 0;

  for (const row of rows) {
    try {
      const res = await politeFetch(row.cover_url, { binary: true, accept: 'image/*', retries: 1 });
      if (res.status !== 200 || !res.body) throw new Error(`HTTP ${res.status}`);
      const img = decodeImage(res.body, res.contentType);
      if (!img) throw new Error('undecodable');

      const ext = res.body[0] === 0x89 ? 'png' : 'jpg';
      const file = `${row.book_id}.${ext}`;
      writeFileSync(join(config.coverDir, file), res.body);
      db.prepare(
        `UPDATE demo_books SET cover_path=?, cover_type=?, cover_state='ok' WHERE book_id=?`,
      ).run(file, ext === 'png' ? 'image/png' : 'image/jpeg', row.book_id);
      fetched += 1;
    } catch {
      // Leave the spine colour in place and stop retrying this one.
      db.prepare("UPDATE demo_books SET cover_state='failed' WHERE book_id=?").run(row.book_id);
    }
  }
  return { fetched };
}

export const demoCoversPending = () =>
  getDb().prepare("SELECT COUNT(*) n FROM demo_books WHERE cover_state='pending' AND cover_url != ''").get().n;
