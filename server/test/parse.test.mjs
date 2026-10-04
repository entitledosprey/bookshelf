import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeedXml, isPlaceholderCover, fullSizeCover } from '../src/goodreads/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(join(here, 'fixtures', 'list_rss_read.xml'), 'utf8');
const { items, skipped, channelTitle } = parseFeedXml(xml);
const byId = (id) => items.find((b) => b.bookId === id);

test('parses every well-formed item and skips the malformed one', () => {
  assert.equal(items.length, 5);
  assert.equal(skipped, 1, 'the item with no book_id must be skipped, not thrown on');
  assert.equal(channelTitle, "Otis's bookshelf: read");
});

test('num_pages is read from the NESTED <book> element', () => {
  // <book id="34"><num_pages>398</num_pages></book> -- not a direct child of
  // <item>. This is the quirk that silently breaks naive parsers.
  assert.equal(byId('34').pages, 398);
  assert.equal(byId('10081041').pages, 528);
});

test('an empty num_pages becomes null rather than 0 or NaN', () => {
  assert.equal(byId('13641208').pages, null);
});

test('the channel title does not leak into item titles', () => {
  for (const b of items) assert.ok(!b.title.includes('bookshelf:'));
});

test('XML entities are decoded', () => {
  const b = byId('99001');
  assert.equal(b.title, "Jonathan Strange & Mr Norrell: A Writer's Café");
  assert.equal(b.author, 'Renée Dubois');
});

test('series is split out of the title', () => {
  const b = byId('34');
  assert.equal(b.displayTitle, 'The Fellowship of the Ring');
  assert.equal(b.series, 'The Lord of the Rings');
  assert.equal(b.seriesPosition, 1);
});

test('shortTitle drops the subtitle, displayTitle keeps it', () => {
  const b = byId('99001');
  assert.equal(b.displayTitle, "Jonathan Strange & Mr Norrell: A Writer's Café");
  assert.equal(b.shortTitle, 'Jonathan Strange & Mr Norrell');
});

test('ISBN-10 keeps its leading zero and is never coerced to a number', () => {
  assert.equal(byId('34').isbn, '0618346252');
  assert.equal(typeof byId('34').isbn, 'string');
});

test('a missing ISBN is an empty string, not undefined', () => {
  assert.equal(byId('13641208').isbn, '');
});

test('nophoto placeholders are rejected, real covers kept', () => {
  assert.equal(byId('13641208').coverUrl, '', 'the /nophoto/ placeholder must not become a cover');
  assert.ok(byId('34').coverUrl.startsWith('https://'));
});

test('user_shelves lists custom shelves only and may be empty', () => {
  assert.deepEqual(byId('34').shelves, ['fantasy', 'favourites']);
  // A book shelved only as "read" has NO custom shelves, which is why the
  // exclusive shelf has to come from which feed returned the book.
  assert.deepEqual(byId('13641208').shelves, []);
});

test('authorSort puts the surname first, handling particles', () => {
  assert.equal(byId('34').authorSort, 'Tolkien, J.R.R.');
  assert.equal(byId('10081041').authorSort, 'Bengtsson, Frans G.');
});

test('dates are normalised to ISO', () => {
  assert.match(byId('34').dateAdded, /^\d{4}-\d{2}-\d{2}T/);
});

test('cover size tokens are stripped to get the full-resolution image', () => {
  assert.equal(
    fullSizeCover('https://i.gr-assets.com/images/S/x/books/1298411339l/34._SY475_.jpg'),
    'https://i.gr-assets.com/images/S/x/books/1298411339l/34.jpg',
  );
  // Already full size: unchanged.
  assert.equal(fullSizeCover('https://x/34.jpg'), 'https://x/34.jpg');
});

test('placeholder detection', () => {
  assert.ok(isPlaceholderCover('https://s.gr-assets.com/assets/nophoto/book/111x148-abc.png'));
  assert.ok(isPlaceholderCover(''));
  assert.ok(!isPlaceholderCover('https://i.gr-assets.com/books/34.jpg'));
});

test('garbage input returns empty rather than throwing', () => {
  assert.deepEqual(parseFeedXml('not xml at all').items, []);
  assert.deepEqual(parseFeedXml('').items, []);
  assert.deepEqual(parseFeedXml(null).items, []);
});
