# Bookshelf

Your Goodreads library, rendered as a bookshelf: spines sized to each book's
real page count and physical dimensions, coloured from its real cover art. Tap a
spine to see the cover.

Multi-user and self-hosted as a single container. Visitors who are not signed
in get a sample shelf of real books, so the site shows what it is rather than
asking for an account first.

![A bookcase of spines sized to each book's real dimensions, in the warm library theme](docs/shelf.jpg)

## How it works

**Books come from the Goodreads shelf RSS feed**, walked page by page and
accumulated in a local SQLite store. The widely repeated claim that this feed is
capped at 100 books is wrong; measured against the live endpoint:

| Request | Result |
| --- | --- |
| `list_rss/1?shelf=read` | 100 items (the default, hence the myth) |
| `&per_page=200` | 200 items |
| `&per_page=300` / `500` / `1000` | silently falls back to 100 — **200 is the real max** |
| `&page=1,2,3` | 100 each, **zero `book_id` overlap** — real pagination |
| `&per_page=200&page=1..5` | 200, 200, 200, 29, 0 — clean termination |

So one sync enumerates an entire library, unauthenticated and with no API key.
The three exclusive shelves (`read`, `currently-reading`, `to-read`) are walked
separately, because a feed item's `user_shelves` lists *custom* shelves only — a
book shelved just as "read" has an empty one, so the shelf a book belongs to can
only be known from which feed returned it.

The merge is **append-only**: new books are inserted, mutable reading state is
refreshed, and nothing is ever deleted. If Goodreads changes format or blocks
the feed, the shelf keeps rendering from the local store.

**Spines are reconstructed, not photographed.** No API serves photographs of
book spines. Each spine's colour is extracted from the real cover art, its
thickness comes from the real page count, and its height from the real physical
dimensions where those exist. Every book reports where its numbers came from,
and the UI says "estimated from 496 pages" rather than implying a measurement.

**The three themes are different furniture, not different paint.** The warm
library is an enclosed walnut case with thick boards and books packed close;
the gallery is thin ash planks floating off a pale wall with no case at all;
dark academia is heavy joinery with a brass rail along each board and a deep
recess. Headroom, board thickness, upright width and shelf spacing are all
theme tokens.

**You can rate a book and keep notes on it.** Both are yours, stored per
account and separate from anything Goodreads sends, so a sync can never
overwrite them. Notes are searchable alongside titles and authors.

**Bibliographic data is shared between accounts, reading state is not.** Two
users who own the same book share one cover download, one metadata lookup and
one palette extraction; their ratings and shelves stay separate, and no user can
read another's library.

## Running it

```bash
cp .env.example .env     # set ADMIN_API_KEY at minimum
docker compose up -d
```

Then open the site and create an account with a username and a password. **The
first account created becomes the administrator**, so make it yours before
sharing the URL.

Goodreads details are optional at signup and can be added later from the account
panel. The user id is the number in `goodreads.com/user/show/`**`152185079`**`-name`
— a display name will not work. A private profile also needs the RSS key from the
feed link at the bottom of its My Books page. Both fields accept a pasted URL and
pull the value out of it.

### Administration

Any administrator gets an **Admin** button in the top bar:

- **People** — who has an account, their Goodreads details, book counts, last
  sync and its error if it failed. Reset a password, sign someone out
  everywhere, trigger their sync, grant or remove admin, or delete an account.
  The last remaining administrator cannot be demoted or deleted.
- **Syncs** — the last 30 runs across all accounts, with what each one fetched.
- **Server** — store and enrichment totals, active rate-limit cooldowns, what
  the running system has measured about the Goodreads feed, and a switch to
  close new signups.

Deleting an account removes that person's shelf and sessions but keeps the
shared `books` rows, since other accounts may shelve the same titles and
re-fetching covers and palettes is expensive.

The container expects to sit behind a reverse proxy; `nginx/bookshelf.conf` is a
server block for an existing nginx edge stack.

### Configuration

Everything in `.env.example` is optional except `ADMIN_API_KEY`, and every empty
value leaves its subsystem inert rather than crashing:

| Variable | Effect when empty |
| --- | --- |
| `ADMIN_API_KEY` | admin routes still work for signed-in administrators; only the break-glass header is disabled |
| `GOOGLE_BOOKS_API_KEY` | Google Books rate-limits almost immediately; Open Library carries enrichment |
| `CONTACT_EMAIL` | Open Library applies its lower anonymous rate limit (identified requests get 3×) |
| `ENRICH_ENABLED=false` | Spines use Goodreads covers and heuristic geometry only |

## Development

```bash
cd server && npm install && npm test
cd client && npm install && npm run build   # builds into server/public
GOODREADS_BASE_URL=... ADMIN_API_KEY=dev node server/src/index.js
```

`npm test` is plain `node --test` and runs fully offline — `test/rss-sink.mjs`
serves a captured feed locally, pointed at by `GOODREADS_BASE_URL`.

### No native dependencies, on purpose

The Dockerfile installs dependencies in a `--platform=$BUILDPLATFORM` stage and
copies `node_modules` into the target-arch runtime stage, so a native binary
would be the wrong architecture on arm64. Passwords use `node:crypto` scrypt
rather than bcrypt, images decode with `jpeg-js`/`pngjs` rather than sharp, and
SQLite is the built-in `node:sqlite`. Do not add `sharp`, `canvas`,
`better-sqlite3`, `bcrypt`, `node-vibrant` or `get-image-colors`.

### Layout

```
shared/types.ts   the API contract, imported by the client
docs/API.md       the same contract in prose — write an iOS client against this
server/src/
  goodreads/      feed walk, parsing, the single append-only merge
  enrich/         Open Library + Google Books, dimensions, covers, worker
  palette.js      median-cut palette extraction and WCAG contrast
  auth/           scrypt, opaque sessions, dual Bearer/cookie middleware
client/src/
  components/     Spine, Shelf, Bookcase, BookSheet
  styles/         three themes as token sets; only the chrome changes
```

## Known limits

- Signup is open by design, and each account adds polling load against
  Goodreads. Every outbound request is serialised through one 1.5s-spaced
  queue, so syncs get slower as more people join rather than getting the
  instance rate-limited. Close signups from the admin panel if that becomes a
  problem.
- The Goodreads RSS feed is unofficial. It works well today, and the local store
  means a break degrades to a stale shelf rather than an empty one, but it could
  change without notice.
- Open Library's `physical_dimensions` is absent for most editions, so most
  books fall back to the page-count heuristic. `geometry.source` makes that
  visible rather than hiding it.
- Spines are a faithful reconstruction, not photographs: a book whose real spine
  is black with gold foil but whose cover is bright red will render red.
