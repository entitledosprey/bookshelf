import { getDb } from '../db.js';
import { isoNow } from '../http.js';
import { walkShelf, EXCLUSIVE_SHELVES } from './feed.js';
import { mergeBooks } from './merge.js';
import { CooldownError } from '../net/politeFetch.js';
import { metaSet } from '../db.js';

/**
 * Sync one user's library.
 *
 * Walks the three exclusive shelves rather than #ALL#, because the exclusive
 * shelf (read / currently-reading / to-read) cannot be derived from a feed item
 * -- <user_shelves> lists custom shelves only, and is empty for a book shelved
 * just as "read". The shelf a book belongs to is therefore whichever feed
 * returned it. We need that distinction because to-read gets its own section.
 *
 * The union of the three exclusive shelves is the whole library by construction,
 * and each walk runs to exhaustion, so coverage is complete rather than capped.
 */
export async function syncUser(user, { trigger = 'schedule' } = {}) {
  const db = getDb();
  const started = isoNow();

  const runId = db.prepare(
    `INSERT INTO sync_runs (user_id, started_at, trigger, status) VALUES (?,?,?,'running')`,
  ).run(user.id, started, trigger).lastInsertRowid;

  const finish = (status, extra = {}) => {
    db.prepare(`UPDATE sync_runs SET finished_at=?, status=?, pages_fetched=?, items_seen=?,
                books_new=?, books_updated=?, complete=?, error=? WHERE id=?`)
      .run(isoNow(), status, extra.pages ?? 0, extra.items ?? 0, extra.added ?? 0,
           extra.updated ?? 0, extra.complete ? 1 : 0, extra.error ?? '', runId);
    if (status === 'ok' || status === 'partial') {
      db.prepare('UPDATE users SET last_sync_at = ? WHERE id = ?').run(isoNow(), user.id);
    }
    return { runId, status, ...extra };
  };

  if (!user.goodreads_user_id) {
    return finish('failed', { error: 'no Goodreads user id configured for this account' });
  }

  let pages = 0;
  let items = 0;
  let added = 0;
  let updated = 0;
  let allComplete = true;
  const notes = [];

  try {
    for (const shelf of EXCLUSIVE_SHELVES) {
      let shelfComplete = false;

      for await (const page of walkShelf({
        userId: user.goodreads_user_id,
        shelf,
        key: user.goodreads_rss_key || '',
      })) {
        if (page.status !== 200) {
          // A 404 on the first page means the feed URL itself is wrong, which
          // in practice means the Goodreads user id is wrong -- most often a
          // display name typed in where the numeric id belongs. Say so, rather
          // than reporting a bare status code nobody can act on.
          if (page.status === 404 && page.page === 1) {
            throw new Error(
              `Goodreads has no shelves at user id "${user.goodreads_user_id}". ` +
              'Open your Goodreads profile and use the NUMBER from the address ' +
              '(goodreads.com/user/show/152185079-your-name), not your display name.',
            );
          }
          notes.push(`${shelf}: HTTP ${page.status} on page ${page.page}`);
          break;
        }
        if (page.stop === 'empty-shelf') {
          // Nothing on this shelf. Normal, and complete.
          shelfComplete = true;
          break;
        }
        if (page.stop === 'parse-error') {
          // Not a feed at all. Note it and carry on to the other shelves rather
          // than abandoning the run: the shelves that did parse have already
          // been merged, and throwing here would discard a good sync because
          // one shelf misbehaved.
          notes.push(`${shelf}: Goodreads returned something that is not an RSS feed`);
          break;
        }
        if (page.stop === 'page-ignored') {
          notes.push(`${shelf}: page= was ignored after page ${page.page - 1}; coverage may be partial`);
          metaSet('capability.pageParamWorks', 'false');
          break;
        }
        if (page.stop === 'max-pages') {
          notes.push(`${shelf}: stopped at the SYNC_MAX_PAGES ceiling; coverage partial`);
          break;
        }

        pages += 1;
        items += page.itemCount;

        if (page.items.length) {
          const r = mergeBooks({
            userId: user.id,
            items: page.items,
            exclusiveShelf: shelf,
            source: 'rss',
          });
          added += r.added;
          updated += r.updated;
        }

        if (page.page >= 2) metaSet('capability.pageParamWorks', 'true');
        if (page.itemCount > 100) metaSet('capability.perPage200Works', 'true');
        if (page.complete) { shelfComplete = true; break; }
      }

      if (!shelfComplete) allComplete = false;
    }
  } catch (err) {
    const msg = err instanceof CooldownError
      ? `rate limited: ${err.message}`
      : (err?.message ?? String(err));
    return finish(err instanceof CooldownError ? 'partial' : 'failed', {
      pages, items, added, updated, complete: false,
      error: [msg, ...notes].join(' | '),
    });
  }

  return finish(allComplete && notes.length === 0 ? 'ok' : 'partial', {
    pages, items, added, updated, complete: allComplete, error: notes.join(' | '),
  });
}
