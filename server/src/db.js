import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT UNIQUE,
  email             TEXT,
  password_hash     TEXT NOT NULL,
  goodreads_user_id TEXT,
  goodreads_rss_key TEXT,
  is_admin          INTEGER NOT NULL DEFAULT 0,
  prefs_json        TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  last_sync_at      TEXT
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
  -- user_rating mirrors Goodreads and is overwritten by every sync.
  user_rating     INTEGER,
  -- my_rating and notes are yours, entered here. The merge never touches them.
  my_rating       INTEGER,
  notes           TEXT NOT NULL DEFAULT '',
  notes_updated_at TEXT,
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

-- Things that are not books: framed photographs, small objects, whatever the
-- reader wants standing between the spines. Per user, like their shelf.
CREATE TABLE IF NOT EXISTS decorations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'frame',   -- frame | plant | print
  caption     TEXT NOT NULL DEFAULT '',
  image_path  TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  shelf_index INTEGER NOT NULL DEFAULT 0,      -- which shelf it stands on
  position    REAL NOT NULL DEFAULT 0.5,       -- 0..1 along that shelf
  width_mm    REAL NOT NULL DEFAULT 120,
  height_mm   REAL NOT NULL DEFAULT 160,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decorations_user ON decorations(user_id, shelf_index);

CREATE TABLE IF NOT EXISTS host_cooldowns (
  host   TEXT PRIMARY KEY,
  until  TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * Small forward-only migrations. The DDL above uses CREATE TABLE IF NOT EXISTS,
 * which does nothing to a table that already exists, so anything added after a
 * deployment has to be applied here too.
 */
function migrate(database) {
  const cols = (table) =>
    database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  const userCols = cols('users');

  // Accounts moved from invite-only email signup to open username signup.
  if (!userCols.includes('username')) {
    database.exec('ALTER TABLE users ADD COLUMN username TEXT');
    // Backfill from the email local part so existing accounts keep working,
    // de-duplicating if two addresses share one.
    const rows = database.prepare('SELECT id, email FROM users ORDER BY id').all();
    const taken = new Set();
    const upd = database.prepare('UPDATE users SET username = ? WHERE id = ?');
    for (const r of rows) {
      let base = String(r.email ?? `user${r.id}`).split('@')[0]
        .toLowerCase().replace(/[^a-z0-9_-]/g, '') || `user${r.id}`;
      let name = base;
      let n = 2;
      while (taken.has(name)) { name = `${base}${n}`; n += 1; }
      taken.add(name);
      upd.run(name, r.id);
    }
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
    // Whoever set the instance up is the administrator.
    database.exec('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)');
  }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');

  /*
   * Email started out as the required, unique login identifier. Signup now uses
   * a username and email is optional, but SQLite cannot drop a NOT NULL
   * constraint with ALTER, so the table has to be rebuilt.
   *
   * users is referenced by sessions, user_books and sync_runs, several
   * with ON DELETE CASCADE -- dropping it with foreign keys enforced would
   * delete every shelf on the instance. Hence the procedure SQLite documents
   * for this: disable foreign keys OUTSIDE a transaction, rebuild inside one,
   * verify with foreign_key_check before committing, then re-enable.
   */
  const emailCol = database.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'email');
  if (emailCol?.notnull === 1) {
    database.exec('PRAGMA foreign_keys = OFF');
    try {
      database.exec('BEGIN');
      database.exec(`
        CREATE TABLE users_rebuilt (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          username          TEXT UNIQUE,
          email             TEXT,
          password_hash     TEXT NOT NULL,
          goodreads_user_id TEXT,
          goodreads_rss_key TEXT,
          is_admin          INTEGER NOT NULL DEFAULT 0,
          prefs_json        TEXT NOT NULL DEFAULT '{}',
          created_at        TEXT NOT NULL,
          last_sync_at      TEXT
        )`);
      database.exec(`
        INSERT INTO users_rebuilt
          (id, username, email, password_hash, goodreads_user_id, goodreads_rss_key,
           is_admin, prefs_json, created_at, last_sync_at)
        SELECT id, username, email, password_hash, goodreads_user_id, goodreads_rss_key,
               is_admin, prefs_json, created_at, last_sync_at
        FROM users`);
      database.exec('DROP TABLE users');
      database.exec('ALTER TABLE users_rebuilt RENAME TO users');
      database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
      // Partial index: emails stay unique, but any number of rows may have none.
      database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');

      const broken = database.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) {
        throw new Error(`users rebuild left ${broken.length} dangling references`);
      }
      database.exec('COMMIT');
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    } finally {
      database.exec('PRAGMA foreign_keys = ON');
    }
  }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');

  // Invites are gone: signup is open, and nothing has read this table since.
  database.exec('DROP TABLE IF EXISTS invites');

  // Personal rating and notes, kept apart from the Goodreads rating so a sync
  // can never overwrite what you wrote.
  const ubCols = cols('user_books');
  if (!ubCols.includes('my_rating')) {
    database.exec('ALTER TABLE user_books ADD COLUMN my_rating INTEGER');
  }
  if (!ubCols.includes('notes')) {
    database.exec("ALTER TABLE user_books ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
    database.exec('ALTER TABLE user_books ADD COLUMN notes_updated_at TEXT');
  }
}

let db = null;

export function openDb(path = config.dbPath) {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(DDL);
  migrate(db);
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
