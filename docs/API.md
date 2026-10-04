# Bookshelf API (`/api/v1`)

This document and `shared/types.ts` are the same contract in two forms. The web
client is one consumer; a native iOS client would be written against this file.

## Design rules

1. **The server never emits HTML or CSS.** Geometry is millimetres, colour is
   hex, presentation is an enum plus an integer seed. Any renderer can consume it.
2. **Versioned.** Breaking changes land on `/api/v2`, so an old App Store build
   keeps working.
3. **One token, two transports.** Every authenticated endpoint accepts the
   session token from *either* `Authorization: Bearer <token>` *or* the
   `bookshelf_session` httpOnly cookie. The web client uses the cookie so an XSS
   cannot read the token; a native client should send the Bearer header and keep
   the token in the Keychain.
4. **Preferences live on the server**, not in local storage, so theme and sort
   order follow the account onto another device.

Errors are always `{ "error": "lower-case sentence" }` with a meaningful status.

## Authentication

Signup is open. The **first account created on an instance becomes the
administrator**; an administrator can close signups afterwards.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/auth/config` | — | `{ signupsEnabled }`. |
| `POST` | `/auth/register` | — | `{ username, password, goodreadsUserId?, goodreadsRssKey? }` → `201 { token, expiresAt, user }`. `403` when signups are closed. Queues a first sync if Goodreads details were given. |
| `POST` | `/auth/login` | — | `{ username, password }` → `{ token, expiresAt, user }`. Also sets the cookie. |
| `POST` | `/auth/logout` | session | `204`. Revokes the token server-side. |
| `GET` | `/auth/me` | session | The `Me` object. |
| `PATCH` | `/auth/prefs` | session | `{ theme?, order?, scale? }` → the merged `Prefs`. |
| `PATCH` | `/auth/account` | session | `{ goodreadsUserId?, goodreadsRssKey? }` → `Me`. Both accept a pasted URL. |
| `POST` | `/auth/password` | session | `{ currentPassword, newPassword }`. Revokes every OTHER session. |

Usernames are 3–64 characters, lowercased and unique, starting with a letter or
number. They may contain `. _ + @ -`, so **an email address is a valid
username** — which is what most people type. Signing up with one keeps it as the
account's contact address, and either form signs in. Passwords must be at least
8 characters. Login returns the same message
for a wrong password and an unknown account, so account existence is not leaked.

A Goodreads user id must be the **number** from the profile URL; a display name
is rejected with a message saying so, because it otherwise produces a bare 404
from Goodreads that is baffling to diagnose.

## The demo shelf

Public, no credentials. This is what a visitor sees before signing in.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/demo/books` | A random sample of real books, same shape as `/books` plus `demo: true`. Never cached. |
| `GET` | `/demo/covers/:bookId` | Demo cover art only; real users' covers are not reachable here. |

Demo books carry ids prefixed `demo-`, live in their own table, and never appear
in a signed-in account's shelf.

## Books

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/books` | session | `{ books, sections, totals }`. Optional `?q=` and `?shelf=`. |
| `GET` | `/books/:bookId` | session | One `Book`, `404` if not on this user's shelf. |
| `PATCH` | `/books/:bookId` | session | `{ myRating?, notes? }` → the updated `Book`. `myRating` is 1-5 or `null` to clear; notes cap at 20000 characters. `404` for a book not on your shelf. |
| `GET` | `/covers/:bookId` | session | The cached image. `ETag`, `Cache-Control: private, immutable`. `404` when no cover was found. |

`sections` splits the shelf into `library` (read and currently-reading) and
`toRead`, as arrays of book ids.

A `Book` looks like this:

```json
{
  "id": "10081041",
  "title": "The Long Ships",
  "displayTitle": "The Long Ships",
  "shortTitle": "The Long Ships",
  "series": null,
  "seriesPosition": null,
  "author": "Frans G. Bengtsson",
  "authorSort": "Bengtsson, Frans G.",
  "isbn": "159017416X",
  "pages": 528,
  "published": 1941,
  "averageRating": 4.38,
  "userRating": 5,
  "myRating": 4,
  "notes": "Lent to Sam, March.",
  "notesUpdatedAt": "2026-10-04T17:12:03.000Z",
  "exclusiveShelf": "read",
  "shelves": ["adventure", "history"],
  "dateAdded": "2026-09-11T17:07:58.000Z",
  "binding": "trade-paperback",
  "geometry": { "heightMm": 198, "widthMm": 129, "thicknessMm": 31.4,
                "source": "heuristic", "confidence": 0.6 },
  "palette": { "bg": "#b5261a", "accent": "#dac68a", "fg": "#ffffff",
               "swatches": ["#38251d", "#ba271b"], "isDark": true,
               "isGrayscale": false, "source": "image" },
  "palettePending": false,
  "spineStyle": "classic-serif-centred",
  "seed": 1927361045,
  "hasCover": true,
  "coverAspect": 0.667,
  "coverUrl": "/api/v1/covers/10081041",
  "goodreadsUrl": "https://www.goodreads.com/book/show/10081041"
}
```

### Rendering a spine from this payload

* **Width** is `geometry.thicknessMm`, **height** is `geometry.heightMm`. Pick a
  mm→point scale; the web client uses 0.65 pt/mm at scale 1. Keep the proportions
  — they are the product.
* Thin books need a padded hit area rather than an inflated width.
* **Colour**: fill with `palette.bg`, letter in `palette.fg` (guaranteed ≥ 4.5:1
  against `bg`), use `palette.accent` for rules, plates and foil.
* **`spineStyle`** is one of eight layouts; **`seed`** drives any further stable
  per-book variation (reading direction, lean angle).
* **`geometry.source`** is `heuristic` for most books. Say so in the UI rather
  than presenting an estimate as a measurement — `confidence` is 0.95 for fully
  measured, 0.6 for estimated from a real page count, 0.2 for no page count.
* **`myRating`** and **`notes`** are the reader's own, entered in this app and
  **never touched by a sync** — unlike `userRating`, which mirrors Goodreads and
  is overwritten on every run. `?q=` searches notes as well as title and author.
* **`palettePending`** means enrichment has not run yet; the `palette` supplied
  is a seeded fallback so the book is still renderable.
* **`binding`** `ebook` and `audiobook` get a fixed slim thickness, never a page
  count converted to paper. Render them visibly non-physical.

## Sync

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/sync/status` | session | Last run, `capability`, `coverage`. |
| `GET` | `/sync/runs` | session | The last 20 runs. |
| `POST` | `/sync/run` | session | `202`. Rate limited to 4 per 5 minutes. |

`capability` reports what the running system has actually observed about the
Goodreads feed (`perPage200Works`, `pageParamWorks`) rather than what any
documentation claims. `coverage.complete` is true only when every shelf walk
ended on a short page, which proves the whole library was enumerated.

## Admin

Two ways in: a **session belonging to an account flagged `is_admin`** (what the
admin panel uses), or the `X-Admin-Key` header as break-glass for scripting.
Anonymous requests get `401`; a signed-in non-admin gets `403`.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/overview` | Store, enrichment and demo totals; active rate-limit cooldowns; measured feed capability; whether signups are open. |
| `GET` | `/admin/users` | Accounts with book counts, session counts and last sync status. Never returns password hashes or stored RSS keys — only whether a key exists. |
| `GET` | `/admin/runs` | The last 30 sync runs across all accounts. |
| `PATCH` | `/admin/users/:id` | `{ isAdmin?, goodreadsUserId? }`. Refuses to demote the last administrator. |
| `POST` | `/admin/users/:id/password` | `{ newPassword }`. Also revokes all of that user's sessions. |
| `POST` | `/admin/users/:id/signout` | Revokes sessions without changing the password. |
| `POST` | `/admin/users/:id/sync` | Queues a sync for that account. |
| `DELETE` | `/admin/users/:id` | Removes the account, its shelf and sessions. Shared `books` rows survive. Refuses the last administrator or your own account. |
| `PATCH` | `/admin/settings` | `{ signupsEnabled }`. |
| `PATCH` | `/admin/books/:bookId` | Writes `book_overrides`; every read path prefers these, so re-enrichment can never undo a manual fix. |
| `POST` | `/admin/reenrich` | `{ bookIds? }` or all. Use after bumping `PALETTE_VERSION`. |

## Health

`GET /healthz` → `{ ok, uptime, books, enrichPending }`. Never contacts
Goodreads: a rate-limited upstream must not be able to make the container look
unhealthy.
