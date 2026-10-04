import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './lib/api';
import { arrange, type Order } from './lib/geometry';
import type { Book, Me, Prefs, ShelfResponse, SyncStatus as Status } from './types';
import { Login } from './components/Login';
import { Bookcase } from './components/Bookcase';
import { BookSheet } from './components/BookSheet';
import { Controls } from './components/Controls';
import { SyncStatus } from './components/SyncStatus';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [data, setData] = useState<ShelfResponse | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const lastFocused = useRef<HTMLElement | null>(null);

  const prefs: Prefs = me?.prefs ?? { theme: 'wood', order: 'author', scale: 1.6 };

  // Theme is an attribute on <html>, so every token swap is one repaint.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', prefs.theme);
  }, [prefs.theme]);

  useEffect(() => {
    api.me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setBooting(false));
  }, []);

  const load = useCallback(async () => {
    try {
      const [books, st] = await Promise.all([api.books(), api.syncStatus()]);
      setData(books);
      setStatus(st);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else setError(err instanceof Error ? err.message : 'Could not load your shelves.');
    }
  }, []);

  useEffect(() => { if (me) void load(); }, [me, load]);

  // While a sync or enrichment is in flight, refresh so spines fill in.
  useEffect(() => {
    if (!me) return;
    const busy = status?.running || (data?.totals.enrichPending ?? 0) > 0;
    if (!busy) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [me, status?.running, data?.totals.enrichPending, load]);

  const savePrefs = async (patch: Partial<Prefs>) => {
    setMe((m) => (m ? { ...m, prefs: { ...m.prefs, ...patch } } : m));
    try { await api.savePrefs(patch); } catch { /* local change already applied */ }
  };

  // Ordered list the sheet navigates along, matching what is on screen.
  const ordered = useMemo(
    () => (data ? arrange(data.books, prefs.order as Order) : []),
    [data, prefs.order],
  );

  const openBook = ordered.find((b) => b.id === openId) ?? null;
  const neighbours = useMemo(() => {
    if (!openBook) return { prev: null, next: null };
    const i = ordered.findIndex((b) => b.id === openBook.id);
    return { prev: ordered[i - 1] ?? null, next: ordered[i + 1] ?? null };
  }, [openBook, ordered]);

  const onOpen = useCallback((book: Book, el: HTMLElement) => {
    lastFocused.current = el;
    setOpenId(book.id);
  }, []);

  const onClose = useCallback(() => {
    setOpenId(null);
    // Return focus to the spine that was tapped.
    lastFocused.current?.focus();
  }, []);

  const runSync = async () => {
    try {
      await api.runSync();
      setStatus((s) => (s ? { ...s, running: true } : s));
      setTimeout(() => void load(), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a sync.');
    }
  };

  if (booting) return <div className="app" aria-busy="true" />;
  if (!me) return <div className="app"><Login onSignedIn={setMe} /></div>;

  const total = data?.totals.books ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="wordmark">Bookshelf</h1>
        <span className="count">
          {total > 0 ? `${total} ${total === 1 ? 'book' : 'books'}` : ''}
        </span>
        <span className="topbar-spacer" />
        <button className="btn btn-ghost" onClick={() => api.logout().then(() => setMe(null))}>
          Sign out
        </button>
      </header>

      <Controls query={query} onQuery={setQuery} prefs={prefs} onPrefs={savePrefs} />

      {error && <p className="notice">{error}</p>}
      <SyncStatus status={status} pending={data?.totals.enrichPending ?? 0} onSync={runSync} />

      {data && total === 0 && !status?.running ? (
        <div className="empty">
          <h2>Your shelf is empty</h2>
          <p>
            {me.goodreadsUserId
              ? 'The first sync runs within the hour, or start one now.'
              : 'Add your Goodreads user id to your account to fill this shelf.'}
          </p>
          {me.goodreadsUserId && (
            <button className="btn" onClick={runSync}>Sync now</button>
          )}
        </div>
      ) : data ? (
        <Bookcase
          data={data}
          order={prefs.order as Order}
          scale={prefs.scale}
          query={query}
          openId={openId}
          onOpen={onOpen}
        />
      ) : null}

      {openBook && (
        <BookSheet
          book={openBook}
          neighbours={neighbours}
          onClose={onClose}
          onNavigate={(b) => setOpenId(b.id)}
        />
      )}
    </div>
  );
}
