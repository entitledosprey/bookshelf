/**
 * Finding a Goodreads user id and RSS key is the one genuinely fiddly step in
 * setting this up, so it gets real instructions rather than a placeholder.
 *
 * Both fields accept a pasted URL — the server pulls the id or the key out of
 * it — because a URL is what people actually have in their clipboard.
 */
export function GoodreadsUserIdHelp() {
  return (
    <details className="help">
      <summary>Where do I find my Goodreads user id?</summary>
      <ol>
        <li>Sign in to Goodreads and open your own profile.</li>
        <li>
          Look at the address bar. It reads{' '}
          <code>goodreads.com/user/show/<b>152185079</b>-your-name</code>.
        </li>
        <li>The number is your user id. You can paste the whole address here and we will take the number out of it.</li>
      </ol>
    </details>
  );
}

export function GoodreadsRssHelp() {
  return (
    <details className="help">
      <summary>Where do I find my RSS key, and do I need one?</summary>
      <p>
        You only need a key if your Goodreads profile is private. If your profile is
        public, leave this empty — your shelves can be read without it.
      </p>
      <ol>
        <li>Sign in to Goodreads and open <b>My Books</b>.</li>
        <li>
          Scroll to the very bottom of the shelf listing. There is an{' '}
          <b>RSS</b> link there.
        </li>
        <li>
          Copy that link and paste the whole thing here. It looks like{' '}
          <code>…/review/list_rss/152185079?key=<b>abc123…</b></code>, and we will
          take the key out of it.
        </li>
      </ol>
      <p className="help-note">
        The key is a read-only token for your own shelves. It is stored so syncs can
        run on a schedule, and it is never shown to anyone else.
      </p>
    </details>
  );
}
