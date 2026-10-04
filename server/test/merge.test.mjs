import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshTestDb, getDb } from '../src/db.js';
import { mergeBooks } from '../src/goodreads/merge.js';

const book = (over = {}) => ({
  bookId: '34',
  title: 'The Fellowship of the Ring',
  displayTitle: 'The Fellowship of the Ring',
  shortTitle: 'The Fellowship of the Ring',
  series: 'The Lord of the Rings',
  seriesPosition: 1,
  author: 'J.R.R. Tolkien',
  authorSort: 'Tolkien, J.R.R.',
  isbn: '0618346252',
  pages: 398,
  avgRating: 4.39,
  userRating: 5,
  published: 1954,
  coverUrl: 'https://example.test/34.jpg',
  goodreadsUrl: 'https://www.goodreads.com/book/show/34',
  shelves: ['fantasy'],
  dateAdded: '2023-01-03T16:00:00.000Z',
  ...over,
});

function user(id = 1, email = 'a@example.test') {
  getDb().prepare("INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,'x','2026-01-01')").run(id, email);
  return id;
}

beforeEach(() => { freshTestDb(); });

test('a new book is inserted once with heuristic geometry', () => {
  const u = user();
  const r = mergeBooks({ userId: u, items: [book()], exclusiveShelf: 'read' });
  assert.deepEqual(r, { added: 1, updated: 0 });
  const row = getDb().prepare('SELECT * FROM books WHERE book_id = ?').get('34');
  assert.equal(row.num_pages, 398);
  assert.ok(row.thickness_mm > 0, 'a book must be renderable before enrichment runs');
  assert.ok(row.seed > 0);
  assert.ok(row.spine_style);
});

test('re-syncing the same book adds nothing and never deletes', () => {
  const u = user();
  mergeBooks({ userId: u, items: [book()], exclusiveShelf: 'read' });
  const second = mergeBooks({ userId: u, items: [book()], exclusiveShelf: 'read' });
  assert.equal(second.added, 0, 'books_new must be 0 on a repeat sync');
  assert.equal(second.updated, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM books').get().n, 1);
  assert.equal(getDb().prepare('SELECT seen_count n FROM user_books WHERE book_id=?').get('34').n, 2);
});

test('a book absent from a later feed is never removed', () => {
  const u = user();
  mergeBooks({ userId: u, items: [book(), book({ bookId: '99', title: 'Other' })], exclusiveShelf: 'read' });
  mergeBooks({ userId: u, items: [book()], exclusiveShelf: 'read' });
  // Append-only is the whole resilience story: a Goodreads outage or a format
  // change degrades to a stale shelf, never an empty one.
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM user_books WHERE user_id=?').get(u).n, 2);
});

test('enriched geometry survives a re-sync', () => {
  const u = user();
  mergeBooks({ userId: u, items: [book()], exclusiveShelf: 'read' });
  getDb().prepare(`UPDATE books SET height_mm=240, thickness_mm=31, dims_source='openlibrary',
                   binding='hardcover', enrich_state='done' WHERE book_id='34'`).run();
  mergeBooks({ userId: u, items: [book()], exclusiveShelf: 'read' });
  const row = getDb().prepare('SELECT * FROM books WHERE book_id=?').get('34');
  assert.equal(row.height_mm, 240);
  assert.equal(row.dims_source, 'openlibrary');
  assert.equal(row.binding, 'hardcover');
});

test('the exclusive shelf comes from the feed, not from the item', () => {
  const u = user();
  // user_shelves holds custom shelves only, so "to-read" can only be known
  // from which feed returned the book.
  mergeBooks({ userId: u, items: [book({ shelves: [] })], exclusiveShelf: 'to-read' });
  assert.equal(getDb().prepare('SELECT exclusive_shelf s FROM user_books WHERE book_id=?').get('34').s, 'to-read');
});

test('mutable user state is refreshed on re-sync', () => {
  const u = user();
  mergeBooks({ userId: u, items: [book({ userRating: 3 })], exclusiveShelf: 'read' });
  mergeBooks({ userId: u, items: [book({ userRating: 5, shelves: ['fantasy', 'reread'] })], exclusiveShelf: 'read' });
  const row = getDb().prepare('SELECT * FROM user_books WHERE book_id=?').get('34');
  assert.equal(row.user_rating, 5);
  assert.equal(row.user_shelves, 'fantasy, reread');
});

test('two users sharing a book share ONE bibliographic row', () => {
  const a = user(1, 'a@example.test');
  const b = user(2, 'b@example.test');
  mergeBooks({ userId: a, items: [book()], exclusiveShelf: 'read' });
  mergeBooks({ userId: b, items: [book()], exclusiveShelf: 'to-read' });

  // This is what makes enrichment cost scale with distinct books rather than
  // with users: one cover download, one lookup, one palette for both.
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM books').get().n, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM user_books').get().n, 2);

  // ...while their reading state stays separate.
  const rows = getDb().prepare('SELECT user_id, exclusive_shelf FROM user_books ORDER BY user_id').all();
  assert.deepEqual(rows.map((r) => r.exclusive_shelf), ['read', 'to-read']);
});

test('deleting a user removes their shelf but not the shared books', () => {
  const a = user(1, 'a@example.test');
  const b = user(2, 'b@example.test');
  mergeBooks({ userId: a, items: [book()], exclusiveShelf: 'read' });
  mergeBooks({ userId: b, items: [book()], exclusiveShelf: 'read' });
  getDb().prepare('DELETE FROM users WHERE id = ?').run(a);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM user_books').get().n, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM books').get().n, 1);
});

test('a sync never overwrites your own rating or notes', () => {
  // The whole reason these live in separate columns from user_rating: the
  // Goodreads rating is refreshed on every sync, and yours must not be.
  const u = user();
  mergeBooks({ userId: u, items: [book({ userRating: 3 })], exclusiveShelf: 'read' });
  getDb().prepare(`UPDATE user_books SET my_rating = 5, notes = ?, notes_updated_at = '2026-01-01'
                   WHERE user_id = ? AND book_id = '34'`)
    .run('Reread this every winter. The Moria chapter still gets me.', u);

  // A later sync where Goodreads reports a different rating and new shelves.
  mergeBooks({ userId: u, items: [book({ userRating: 1, shelves: ['fantasy', 'reread'] })], exclusiveShelf: 'read' });

  const row = getDb().prepare("SELECT * FROM user_books WHERE user_id = ? AND book_id = '34'").get(u);
  assert.equal(row.user_rating, 1, 'the Goodreads rating should follow Goodreads');
  assert.equal(row.my_rating, 5, 'your own rating must survive the sync');
  assert.match(row.notes, /Moria/, 'your notes must survive the sync');
  assert.equal(row.notes_updated_at, '2026-01-01');
  assert.equal(row.user_shelves, 'fantasy, reread');
});

test('ratings and notes are per user, not per book', () => {
  const a = user(1, 'a@example.test');
  const b = user(2, 'b@example.test');
  mergeBooks({ userId: a, items: [book()], exclusiveShelf: 'read' });
  mergeBooks({ userId: b, items: [book()], exclusiveShelf: 'read' });

  getDb().prepare("UPDATE user_books SET my_rating = 5, notes = 'loved it' WHERE user_id = ? AND book_id = '34'").run(a);
  getDb().prepare("UPDATE user_books SET my_rating = 2, notes = 'not for me' WHERE user_id = ? AND book_id = '34'").run(b);

  const rows = getDb().prepare('SELECT user_id, my_rating, notes FROM user_books ORDER BY user_id').all();
  assert.deepEqual(rows.map((r) => r.my_rating), [5, 2]);
  assert.deepEqual(rows.map((r) => r.notes), ['loved it', 'not for me']);
});

test('a missing page count still produces a renderable book', () => {
  const u = user();
  mergeBooks({ userId: u, items: [book({ pages: null })], exclusiveShelf: 'read' });
  const row = getDb().prepare('SELECT * FROM books WHERE book_id=?').get('34');
  assert.ok(row.thickness_mm >= 6);
  assert.equal(row.geometry_confidence, 0.2);
});
