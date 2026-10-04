# Bookshelf — notes for Claude

A self-hosted web app that renders a Goodreads library as spines standing in a
bookcase, sized from each book's real page count and dimensions and coloured
from its real cover art. Multi-user, one container, deployed to a VM.

## Commands

```bash
cd server && npm test            # node --test, fully offline, ~6s
cd client && npm run build       # tsc --noEmit then vite, outputs to ../server/public
cd server && npm run dev         # node --watch src/index.js
cd client && npm run dev         # vite on :5173, proxies /api to :8080
```

Run the client build before judging anything visual: the server only ever
serves the built bundle from `server/public`, never client sources.

Regenerating the demo shelf (only when the curated list changes — it makes ~200
Open Library requests):

```bash
cd server && CONTACT_EMAIL=you@example.com node scripts/build-demo-fixture.mjs
```

## Architecture

```
shared/types.ts     the API contract, imported by the client
docs/API.md         the same contract in prose; write an iOS client against this
server/src/
  index.js          express app, static SPA, /healthz, boots the scheduler
  db.js             DDL + forward-only migrations  ← read this before schema work
  config.js         every env var, with inert defaults
  goodreads/        feed.js (paginated walk), parse.js, merge.js, sync.js
  enrich/           openlibrary, googlebooks, dimensions, geometry, covers, worker
  palette.js        median-cut palette extraction, WCAG contrast
  seed.js           deterministic per-book randomness (spine style, lean, tint)
  demo/             the public sample shelf: seed.js, covers.js, shelf.json
  auth/             scrypt passwords, opaque sessions, Bearer-or-cookie middleware
  net/politeFetch.js  per-host serial queues, backoff, cooldowns
  routes/           auth, books, covers, sync, admin, demo
client/src/
  components/       Spine, Shelf, Bookcase, BookSheet, Account, Admin, Login, …
  lib/              api.ts (the only fetch layer), geometry.ts, spine-style.ts
  styles/           tokens.css (3 themes), shelf.css, spines.css, sheet.css
```

## Constraints that will bite you

**Every dependency must be pure JavaScript.** The Dockerfile installs in a
`--platform=$BUILDPLATFORM` stage and copies `node_modules` into the target-arch
runtime stage, so a native binary is the *wrong architecture* on arm64 and the
container dies at runtime, not at build time. Passwords use `node:crypto`
scrypt, images decode with `jpeg-js`/`pngjs`, SQLite is `node:sqlite`. Never add
`sharp`, `canvas`, `@napi-rs/canvas`, `better-sqlite3`, `bcrypt`,
`node-vibrant` or `get-image-colors` — the last two pull in the first two.

**The merge is append-only and must stay that way.** `goodreads/merge.js` is the
single write path into `books`/`user_books`. It inserts new rows, refreshes only
*mutable Goodreads* fields, and never deletes. That is the whole resilience
story: a Goodreads outage or format change degrades to a stale shelf, never an
empty one. `my_rating` and `notes` are the user's own and are deliberately NOT
in the `ON CONFLICT DO UPDATE` list — adding them there would let a sync erase
what someone wrote. There is a test for this; do not weaken it.

**Facts about the Goodreads feed, measured not assumed.** The widely repeated
"RSS is capped at 100 books" is false:

| Request | Result |
| --- | --- |
| `?shelf=read` | 100 items (the default, hence the myth) |
| `&per_page=200` | 200 items |
| `&per_page=300`+ | silently falls back to 100 — **200 is the real max** |
| `&page=1,2,3` | 100 each, **zero book_id overlap** |
| `&per_page=200&page=1..N` | terminates on a short page |

Also: `num_pages` is nested inside `<book id="…">`, not a direct child of
`<item>`. `<title>` exists on both the channel and each item. `user_shelves`
lists *custom* shelves only, so a book's exclusive shelf is knowable only from
which feed returned it — which is why sync walks the three exclusive shelves
separately rather than `#ALL#`. About 22% of items have no ISBN.

**An empty shelf is not a broken feed.** A shelf with nothing on it returns a
well-formed feed with zero items. `parseFeedXml` returns `valid` (did we find
`rss > channel`?) and that — not the item count — is what distinguishes "empty"
from "format changed". Getting this wrong failed the whole sync for anyone with
nothing currently-reading.

**Schema changes need a migration.** The DDL uses `CREATE TABLE IF NOT EXISTS`,
which does nothing to a table that already exists, so anything added after a
deployment must also go in `migrate()` in `db.js`. SQLite cannot drop `NOT NULL`
or a column constraint with `ALTER`, so that needs a table rebuild — and `users`
is referenced by `sessions`, `user_books` and `sync_runs` with `ON DELETE
CASCADE`, so a `DROP TABLE` with foreign keys enforced deletes every shelf on
the instance. Follow the existing pattern: `PRAGMA foreign_keys = OFF` *outside*
a transaction, rebuild inside one, `PRAGMA foreign_key_check` before committing,
roll back if anything dangles. Test a destructive migration against a copy of
the live database before deploying it (`VACUUM INTO`, then scp — a plain file
copy loses data, since the database is in WAL mode).

**The server never emits HTML or CSS.** `/api/v1/books` returns millimetres, hex
colours, an enum and a seed. That boundary is what makes a native iOS client
cheap, and a test asserts the payload contains no markup. Keep presentation in
the client.

**Palette extraction must be deterministic.** The result is *stored*, so
median-cut is used rather than k-means: identical input must give byte-identical
output or you will chase a phantom bug. Same for `seed.js` — spine style,
reading direction and lean are seeded from the book id so a book looks the same
on every device and reload.

**Do not fabricate data.** Most books have no real physical dimensions (Open
Library's `physical_dimensions` is absent for the large majority), so the
page-count heuristic is the *primary* path, not a fallback. Every figure carries
a `source` and `confidence`, and the UI says "estimated from 496 pages" rather
than implying a measurement. Ebooks and audiobooks get a fixed slim thickness,
never a page count converted into millimetres of paper. A cover-aspect binding
heuristic was tried and removed because it produced confidently wrong formats —
see the note in `enrich/geometry.js` before reinventing it.

**Outbound requests go through `politeFetch`.** Per-host serial queues with a
minimum gap, backoff, and cooldowns persisted to the database. N users syncing
still means one request at a time against Goodreads. Do not fetch directly.

## Testing

Plain `node --test`, no framework, fully offline. `test/rss-sink.mjs` serves
captured feeds locally and is pointed at by `GOODREADS_BASE_URL` — that override
is the single most valuable testability affordance here; without it the sync
loop cannot be tested.

Signup is rate limited to 5 per 10 minutes per IP, which is correct in
production and fatal in tests where everything comes from 127.0.0.1. Call the
exported `_resetThrottle()` between registration-heavy cases rather than
weakening the limit.

## Deployment

GitHub Actions builds a multi-arch image on push to `main` and publishes to
GHCR. The **repo is public but the package visibility is separate** — a package
created while a repo was private stays private, and there is no API to change
it; it must be flipped in the GitHub UI, or the host gets a 401 on pull.

The host is `ubuntu@158.101.19.175` (aarch64). **Multiplex SSH**: opening a
connection per command makes port 22 go dark for minutes at a time, while 80/443
stay fine. Use `ControlMaster auto` / `ControlPersist`, and avoid wrapping ssh in
`timeout`, which kills the client abruptly.

```
/opt/bookshelf/              docker-compose.yml + gitignored .env
calorie-app-nginx-1          owns :80/:443, config is ONE mounted file at
                             /home/ubuntu/calorie-app/nginx/nginx.conf
calorie-app_default          the shared network; reach apps by service name
```

nginx resolves upstream names at config load, so a new site fails `nginx -t`
until its container is running: start the container first, then `nginx -t`, then
reload. Always validate before reloading — a bad config takes down the other
sites too. TLS is certbot with Cloudflare DNS-01, and each site needs a deploy
hook in `/etc/letsencrypt/renewal-hooks/deploy/` that copies the cert into the
proxy's volume (certbot's `live/` entries are symlinks into `archive/`, which is
not inside that volume) and reloads nginx.

Take a `VACUUM INTO` backup before any migration. Commits use
`286470032+entitledosprey@users.noreply.github.com`.

## Conventions

- Node 24, ESM, Express 4, no ORM, no state library, hand-written CSS.
- Config reads env with inert defaults: an unset subsystem stays quiet rather
  than crashing. `configWarnings()` explains what is inactive at boot.
- Errors are `{ "error": "lower-case sentence" }` with a meaningful status, and
  should say what to do about it. The sync error for a bad Goodreads id names
  the mistake because a bare `HTTP 404 on page 1` is impossible to act on.
- Comments explain *why*, especially where the non-obvious choice was
  deliberate. Several in this codebase record things that were tried and
  rejected; keep them.
