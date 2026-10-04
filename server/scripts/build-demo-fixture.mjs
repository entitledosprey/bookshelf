/**
 * Build the demo shelf fixture.
 *
 * Run manually when the demo list changes:
 *   CONTACT_EMAIL=you@example.com node scripts/build-demo-fixture.mjs
 *
 * Resolves each curated title through the SAME enrichment chain the app uses
 * for real books, then bakes the result into src/demo/shelf.json so the demo
 * shelf renders instantly, with real colours, and with no network at boot.
 */
import { writeFileSync } from 'node:fs';
import { freshTestDb } from '../src/db.js';
import * as openlibrary from '../src/enrich/openlibrary.js';
import { politeFetch } from '../src/net/politeFetch.js';
import { extractPalette } from '../src/palette.js';
import { estimateGeometry, normalizeBinding } from '../src/enrich/geometry.js';
import { splitTitle, authorSort, authorShort } from '../src/titles.js';
import { pickSpineStyle, seedFrom } from '../src/seed.js';

freshTestDb();

// Chosen for breadth of genre, era and jacket colour, so the demo shelf looks
// like a real personal library rather than one publisher's catalogue.
const WANTED = [
  ['The Left Hand of Darkness', 'Ursula K. Le Guin'],
  ['Dune', 'Frank Herbert'],
  ['Neuromancer', 'William Gibson'],
  ['Snow Crash', 'Neal Stephenson'],
  ['The Dispossessed', 'Ursula K. Le Guin'],
  ['Hyperion', 'Dan Simmons'],
  ['The Three-Body Problem', 'Liu Cixin'],
  ['Foundation', 'Isaac Asimov'],
  ['A Wizard of Earthsea', 'Ursula K. Le Guin'],
  ['The Fellowship of the Ring', 'J.R.R. Tolkien'],
  ['The Hobbit', 'J.R.R. Tolkien'],
  ['Jonathan Strange & Mr Norrell', 'Susanna Clarke'],
  ['Piranesi', 'Susanna Clarke'],
  ['The Name of the Wind', 'Patrick Rothfuss'],
  ['American Gods', 'Neil Gaiman'],
  ['Good Omens', 'Neil Gaiman'],
  ['Mrs Dalloway', 'Virginia Woolf'],
  ['To the Lighthouse', 'Virginia Woolf'],
  ['Beloved', 'Toni Morrison'],
  ['Song of Solomon', 'Toni Morrison'],
  ['Things Fall Apart', 'Chinua Achebe'],
  ['One Hundred Years of Solitude', 'Gabriel García Márquez'],
  ['Love in the Time of Cholera', 'Gabriel García Márquez'],
  ['The Remains of the Day', 'Kazuo Ishiguro'],
  ['Never Let Me Go', 'Kazuo Ishiguro'],
  ['Klara and the Sun', 'Kazuo Ishiguro'],
  ['Pride and Prejudice', 'Jane Austen'],
  ['Emma', 'Jane Austen'],
  ['Jane Eyre', 'Charlotte Brontë'],
  ['Wuthering Heights', 'Emily Brontë'],
  ['Great Expectations', 'Charles Dickens'],
  ['Bleak House', 'Charles Dickens'],
  ['Moby-Dick', 'Herman Melville'],
  ['The Great Gatsby', 'F. Scott Fitzgerald'],
  ['The Sun Also Rises', 'Ernest Hemingway'],
  ['East of Eden', 'John Steinbeck'],
  ['The Grapes of Wrath', 'John Steinbeck'],
  ['Catch-22', 'Joseph Heller'],
  ['Slaughterhouse-Five', 'Kurt Vonnegut'],
  ['Catʼs Cradle', 'Kurt Vonnegut'],
  ['Nineteen Eighty-Four', 'George Orwell'],
  ['Animal Farm', 'George Orwell'],
  ['Brave New World', 'Aldous Huxley'],
  ['Fahrenheit 451', 'Ray Bradbury'],
  ['The Handmaidʼs Tale', 'Margaret Atwood'],
  ['Oryx and Crake', 'Margaret Atwood'],
  ['Blood Meridian', 'Cormac McCarthy'],
  ['The Road', 'Cormac McCarthy'],
  ['Infinite Jest', 'David Foster Wallace'],
  ['White Teeth', 'Zadie Smith'],
  ['Normal People', 'Sally Rooney'],
  ['A Little Life', 'Hanya Yanagihara'],
  ['The Secret History', 'Donna Tartt'],
  ['The Goldfinch', 'Donna Tartt'],
  ['Lincoln in the Bardo', 'George Saunders'],
  ['Tenth of December', 'George Saunders'],
  ['Station Eleven', 'Emily St. John Mandel'],
  ['Cloud Atlas', 'David Mitchell'],
  ['The Overstory', 'Richard Powers'],
  ['Gilead', 'Marilynne Robinson'],
  ['Housekeeping', 'Marilynne Robinson'],
  ['The Long Ships', 'Frans G. Bengtsson'],
  ['Shogun', 'James Clavell'],
  ['Wolf Hall', 'Hilary Mantel'],
  ['The Master and Margarita', 'Mikhail Bulgakov'],
  ['Crime and Punishment', 'Fyodor Dostoevsky'],
  ['The Brothers Karamazov', 'Fyodor Dostoevsky'],
  ['Anna Karenina', 'Leo Tolstoy'],
  ['War and Peace', 'Leo Tolstoy'],
  ['Mythos', 'Stephen Fry'],
  ['Sapiens', 'Yuval Noah Harari'],
  ['Guns, Germs, and Steel', 'Jared Diamond'],
  ['The Selfish Gene', 'Richard Dawkins'],
  ['A Brief History of Time', 'Stephen Hawking'],
  ['Cosmos', 'Carl Sagan'],
  ['The Sixth Extinction', 'Elizabeth Kolbert'],
  ['Thinking, Fast and Slow', 'Daniel Kahneman'],
  ['The Emperor of All Maladies', 'Siddhartha Mukherjee'],
  ['Bad Blood', 'John Carreyrou'],
  ['The Soul of a New Machine', 'Tracy Kidder'],
  ['The Making of the Atomic Bomb', 'Richard Rhodes'],
  ['Hiroshima', 'John Hersey'],
  ['The Right Stuff', 'Tom Wolfe'],
  ['Into Thin Air', 'Jon Krakauer'],
  ['The Immortal Life of Henrietta Lacks', 'Rebecca Skloot'],
  ['Just Mercy', 'Bryan Stevenson'],
  ['The Warmth of Other Suns', 'Isabel Wilkerson'],
  ['Educated', 'Tara Westover'],
  ['H Is for Hawk', 'Helen Macdonald'],
  ['The Wind-Up Bird Chronicle', 'Haruki Murakami'],
  ['Kafka on the Shore', 'Haruki Murakami'],
  ['Norwegian Wood', 'Haruki Murakami'],
  ['Convenience Store Woman', 'Sayaka Murata'],
  ['Pachinko', 'Min Jin Lee'],
  ['The Vegetarian', 'Han Kang'],
  ['Exhalation', 'Ted Chiang'],
  ['Stories of Your Life and Others', 'Ted Chiang'],
  ['Project Hail Mary', 'Andy Weir'],
  ['The Martian', 'Andy Weir'],
  ['Children of Time', 'Adrian Tchaikovsky'],
  ['A Memory Called Empire', 'Arkady Martine'],
  ['The Fifth Season', 'N.K. Jemisin'],
  ['Babel', 'R.F. Kuang'],
  ['Circe', 'Madeline Miller'],
  ['The Song of Achilles', 'Madeline Miller'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
let failed = 0;

for (const [title, author] of WANTED) {
  try {
    const hit = await openlibrary.searchByTitleAuthor({ title, author });
    if (!hit) { console.log(`  no confident match: ${title}`); failed += 1; continue; }

    // Prefer the edition record when we recovered an ISBN: it carries format.
    let ed = null;
    if (hit.isbn) { ed = await openlibrary.byIsbn(hit.isbn).catch(() => null); }

    const coverId = ed?.coverId ?? hit.coverId;
    if (!coverId) { console.log(`  no cover: ${title}`); failed += 1; continue; }

    const coverUrl = openlibrary.coverUrlForId(coverId, 'L');
    const img = await politeFetch(coverUrl, { binary: true, accept: 'image/*', retries: 1 });
    if (img.status !== 200 || !img.body) { console.log(`  cover fetch failed: ${title}`); failed += 1; continue; }

    const id = `demo-${coverId}`;
    // The curated list is of books as printed works, but Open Library will
    // happily return the audio or Kindle edition for a given ISBN. Those render
    // as identical thin slabs, which is wrong for a shelf demo, so fall back to
    // the neutral print default rather than shipping a shelf of audiobooks.
    let binding = normalizeBinding(ed?.physicalFormat, ed?.heightMm ?? null);
    if (binding === 'audiobook' || binding === 'ebook') binding = 'unknown';
    const pages = ed?.pages ?? hit.pages ?? null;
    const palette = extractPalette(img.body, img.contentType, id, binding);
    const geo = estimateGeometry({
      pages, binding,
      heightMm: ed?.heightMm ?? null,
      widthMm: ed?.widthMm ?? null,
      thicknessMm: ed?.thicknessMm ?? null,
      source: (ed?.heightMm || ed?.thicknessMm) ? 'openlibrary' : undefined,
    });
    const t = splitTitle(title);

    out.push({
      id,
      title: t.title,
      displayTitle: t.displayTitle,
      shortTitle: t.shortTitle,
      series: t.series,
      seriesPosition: t.seriesPosition,
      author,
      authorSort: authorSort(author),
      authorShort: authorShort(author),
      isbn: hit.isbn ?? '',
      pages,
      published: null,
      binding,
      geometry: geo,
      palette,
      spineStyle: pickSpineStyle(id, binding),
      seed: seedFrom(id),
      coverUrl,
    });
    console.log(`  ok ${out.length.toString().padStart(3)}  ${title} -> ${palette.bg} ${binding} ${geo.thicknessMm}mm`);
  } catch (err) {
    failed += 1;
    console.log(`  error: ${title}: ${err.message}`);
  }
  await sleep(150);
}

writeFileSync(
  new URL('../src/demo/shelf.json', import.meta.url),
  `${JSON.stringify(out, null, 1)}\n`,
);
console.log(`\nwrote ${out.length} books (${failed} skipped) to src/demo/shelf.json`);
