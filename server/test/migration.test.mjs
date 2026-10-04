import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The users table is rebuilt to drop a NOT NULL on email, and four tables
 * reference it with ON DELETE CASCADE. Getting that wrong deletes every shelf
 * on the instance, so it is tested against a faithful copy of the old schema.
 */
const dir = mkdtempSync(join(tmpdir(), 'bookshelf-mig-'));

/** The schema as it was deployed before usernames existed. */
function buildLegacyDb(path) {
  const d = new DatabaseSync(path);
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      email             TEXT UNIQUE NOT NULL,
      password_hash     TEXT NOT NULL,
      goodreads_user_id TEXT,
      goodreads_rss_key TEXT,
      is_admin          INTEGER NOT NULL DEFAULT 0,
      prefs_json        TEXT NOT NULL DEFAULT '{}',
      created_at        TEXT NOT NULL,
      last_sync_at      TEXT
    );
    -- The columns the shipped DDL builds indexes over; a real legacy database
    -- has these, so the fixture must too.
    CREATE TABLE books (
      book_id TEXT PRIMARY KEY, title TEXT NOT NULL, author_sort TEXT NOT NULL DEFAULT '',
      series TEXT, series_position REAL,
      enrich_state TEXT NOT NULL DEFAULT 'pending', enrich_attempts INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL
    );
    CREATE TABLE covers (book_id TEXT PRIMARY KEY REFERENCES books(book_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending', palette_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE user_books (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
      exclusive_shelf TEXT NOT NULL DEFAULT 'read',
      user_shelves TEXT NOT NULL DEFAULT '',
      user_rating INTEGER,
      user_date_added TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, seen_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, book_id)
    );
    CREATE TABLE sessions (
      token_sha256 TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok'
    );
    CREATE TABLE invites (code TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      used_by INTEGER REFERENCES users(id) ON DELETE SET NULL, used_at TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    INSERT INTO users (id,email,password_hash,is_admin,created_at)
      VALUES (1,'owner@example.test','hash1',0,'2026-01-01'),
             (2,'second@example.test','hash2',0,'2026-01-02');
    INSERT INTO books (book_id,title,first_seen_at) VALUES ('b1','A Book','2026-01-01'), ('b2','Another','2026-01-01');
    INSERT INTO user_books (user_id,book_id,first_seen_at,last_seen_at)
      VALUES (1,'b1','2026-01-01','2026-01-01'), (1,'b2','2026-01-01','2026-01-01'),
             (2,'b1','2026-01-01','2026-01-01');
    INSERT INTO sessions VALUES ('tok1',1,'2026-01-01','2027-01-01','ua');
    INSERT INTO sync_runs (user_id,started_at) VALUES (1,'2026-01-01');
  `);
  d.close();
}

test('migrating the legacy schema preserves every row', async () => {
  const path = join(dir, 'legacy.db');
  buildLegacyDb(path);

  const { openDb, getDb } = await import('../src/db.js');
  openDb(path);
  const d = getDb();
  const n = (t) => d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

  assert.equal(n('users'), 2, 'no user may be lost');
  assert.equal(n('user_books'), 3, 'no shelving may be lost -- these cascade from users');
  assert.equal(n('books'), 2);
  assert.equal(n('sessions'), 1);
  assert.equal(n('sync_runs'), 1);

  assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), [],
    'the rebuilt table must leave no dangling references');
  assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('email becomes optional while staying unique', async () => {
  const { getDb } = await import('../src/db.js');
  const d = getDb();

  assert.equal(d.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'email').notnull, 0);

  // The bug this fixes: signing up with a username and no email.
  d.prepare(`INSERT INTO users (username,email,password_hash,created_at)
             VALUES ('alex',NULL,'h','2026-02-01')`).run();
  d.prepare(`INSERT INTO users (username,email,password_hash,created_at)
             VALUES ('sam',NULL,'h','2026-02-01')`).run();
  assert.equal(d.prepare('SELECT COUNT(*) n FROM users WHERE email IS NULL').get().n, 2,
    'many accounts may have no email');

  assert.throws(
    () => d.prepare(`INSERT INTO users (username,email,password_hash,created_at)
                     VALUES ('dupe','owner@example.test','h','2026-02-01')`).run(),
    /UNIQUE/,
    'duplicate emails must still be rejected',
  );
});

test('usernames were backfilled and the owner became an administrator', async () => {
  const { getDb } = await import('../src/db.js');
  const rows = getDb().prepare('SELECT id, username, is_admin FROM users WHERE id IN (1,2) ORDER BY id').all();
  assert.equal(rows[0].username, 'owner', 'username derived from the email local part');
  assert.equal(rows[1].username, 'second');
  assert.equal(rows[0].is_admin, 1, 'the first account runs the instance');
  assert.equal(rows[1].is_admin, 0);
});

test('deleting a user still cascades to their shelf but not to shared books', async () => {
  const { getDb } = await import('../src/db.js');
  const d = getDb();
  d.prepare('DELETE FROM users WHERE id = 2').run();
  assert.equal(d.prepare('SELECT COUNT(*) n FROM user_books WHERE user_id = 2').get().n, 0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM books').get().n, 2, 'shared books survive');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM user_books WHERE user_id = 1').get().n, 2);
  rmSync(dir, { recursive: true, force: true });
});
