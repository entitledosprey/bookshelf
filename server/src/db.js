import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_sha256 TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Global bibliographic data: one row per distinct book, shared by all users.
-- Two users who own the same book share one cover download, one dimension
-- lookup and one palette extraction.
CREATE TABLE IF NOT EXISTS books (
  book_id             TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  display_title       TEXT NOT NULL DEFAULT '',
  short_title         TEXT NOT NULL DEFAULT '',
  series              TEXT,
  series_position     REAL,
  author              TEXT NOT NULL DEFAULT '',
  author_sort         TEXT NOT NULL DEFAULT '',
  isbn                TEXT NOT NULL DEFAULT '',
  num_pages           INTEGER,
  pages_source        TEXT,
  avg_rating          REAL,
  published           INTEGER,
  goodreads_image_url TEXT NOT NULL DEFAULT '',
  goodreads_url       TEXT NOT NULL DEFAULT '',
  height_mm           REAL,
  width_mm            REAL,
  thickness_mm        REAL,
  dims_source         TEXT,
  binding             TEXT NOT NULL DEFAULT 'unknown',
  binding_source      TEXT,
  geometry_confidence REAL NOT NULL DEFAULT 0,
  spine_style         TEXT,
  seed                INTEGER,
  first_seen_at       TEXT NOT NULL,
  enrich_state        TEXT NOT NULL DEFAULT 'pending',
  enrich_attempts     INTEGER NOT NULL DEFAULT 0,
  enrich_retry_after  TEXT,
  enriched_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_books_enrich ON books(enrich_state, enrich_attempts);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author_sort, series, series_position);

-- Manual corrections, kept apart so re-enrichment can never clobber them.
-- Read paths COALESCE override over derived.
CREATE TABLE IF NOT EXISTS book_overrides (
  book_id      TEXT PRIMARY KEY REFERENCES books(book_id) ON DELETE CASCADE,
  height_mm    REAL,
  width_mm     REAL,
  thickness_mm REAL,
  binding      TEXT,
  palette_bg   TEXT,
  palette_accent TEXT,
  palette_fg   TEXT,
  spine_style  TEXT,
  display_title TEXT,
  updated_at   TEXT NOT NULL
);

-- Per-user ownership and reading state. Every read path filters through this,
-- so no user can see another's library.
CREATE TABLE IF NOT EXISTS user_books (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id         TEXT NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  exclusive_shelf TEXT NOT NULL DEFAULT 'read',
  user_shelves    TEXT NOT NULL DEFAULT '',
  user_rating     INTEGER,
  user_date_added TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  seen_count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_user_books_shelf ON user_books(user_id, exclusive_shelf);

CREATE TABLE IF NOT EXISTS covers (
  book_id         TEXT PRIMARY KEY REFERENCES books(book_id) ON DELETE CASCADE,
  path            TEXT NOT NULL DEFAULT '',
  content_type    TEXT NOT NULL DEFAULT '',
  bytes           INTEGER NOT NULL DEFAULT 0,
  width           INTEGER,
  height          INTEGER,
  source          TEXT NOT NULL DEFAULT '',
  source_url      TEXT NOT NULL DEFAULT '',
  fetched_at      TEXT,
  palette_bg      TEXT,
  palette_accent  TEXT,
  palette_fg      TEXT,
  swatches_json   TEXT NOT NULL DEFAULT '[]',
  is_grayscale    INTEGER NOT NULL DEFAULT 0,
  is_dark         INTEGER NOT NULL DEFAULT 0,
  palette_source  TEXT,
  palette_version INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_covers_status ON covers(status, palette_version);

CREATE TABLE IF NOT EXISTS sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  trigger       TEXT NOT NULL DEFAULT 'schedule',
  status        TEXT NOT NULL DEFAULT 'running',
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  items_seen    INTEGER NOT NULL DEFAULT 0,
  books_new     INTEGER NOT NULL DEFAULT 0,
  books_updated INTEGER NOT NULL DEFAULT 0,
  complete      INTEGER NOT NULL DEFAULT 0,
  error         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_runs_user ON sync_runs(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS host_cooldowns (
  host   TEXT PRIMARY KEY,
  until  TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

let db = null;

export function openDb(path = config.dbPath) {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(DDL);
  return db;
}

export function getDb() {
  if (!db) throw new Error('openDb() has not been called');
  return db;
}

/** Test helper: a fresh in-memory database with the full schema. */
export function freshTestDb() {
  db = null;
  return openDb(':memory:');
}

export const metaGet = (key) =>
  getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;

export const metaSet = (key, value) =>
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
