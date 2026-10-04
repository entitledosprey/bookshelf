import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type AdminOverview, type AdminUser, type AdminRun } from '../lib/api';
import type { Me } from '../types';

/**
 * Administration: who has an account, what their syncs are doing, and the
 * handful of levers worth having without a redeploy.
 *
 * Reached from the top bar by any account flagged as an administrator; the
 * first account created on an instance gets that flag.
 */
export function Admin({ me, onClose }: { me: Me; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [runs, setRuns] = useState<AdminRun[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'users' | 'syncs' | 'server'>('users');
  // Two-step delete: the first click arms it, the second carries it out.
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, u, r] = await Promise.all([api.admin.overview(), api.admin.users(), api.admin.runs()]);
      setOverview(o); setUsers(u); setRuns(r); setErr('');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not load administration data.');
    }
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();
    el.focus({ preventScroll: true });
    const onCancel = (e: Event) => { e.preventDefault(); onClose(); };
    el.addEventListener('cancel', onCancel);
    void load();
    return () => el.removeEventListener('cancel', onCancel);
  }, [onClose, load]);

  const act = async (fn: () => Promise<unknown>, success: string) => {
    setMsg(''); setErr('');
    try { await fn(); setMsg(success); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'That did not work.'); }
  };

  const resetPassword = (u: AdminUser) => {
    // Generated rather than typed: an administrator should never be choosing,
    // seeing twice, or reusing someone else's password.
    const pw = Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 30]).join('');
    void act(async () => {
      await api.admin.resetPassword(u.id, pw);
      setMsg(`New password for ${u.username}: ${pw} — copy it now, it is not stored anywhere.`);
    }, '');
  };

  const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');

  return (
    <dialog
      className="sheet admin" ref={ref} tabIndex={-1} aria-label="Administration"
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="sheet-body">
        <h2 className="sheet-title">Administration</h2>

        {err && <p className="error">{err}</p>}
        {msg && <p className="ok">{msg}</p>}

        <div className="seg tabs" role="tablist">
          {(['users', 'syncs', 'server'] as const).map((t) => (
            <button key={t} role="tab" aria-pressed={tab === t} onClick={() => setTab(t)}>
              {t === 'users' ? `People (${overview?.users ?? 0})`
                : t === 'syncs' ? 'Syncs' : 'Server'}
            </button>
          ))}
        </div>

        {tab === 'users' && (
          <section className="panel">
            {users.map((u) => (
              <div className="urow" key={u.id}>
                <div className="urow-head">
                  <strong>{u.username}</strong>
                  {!!u.is_admin && <span className="chip">admin</span>}
                  {u.id === me.id && <span className="chip">you</span>}
                  <span className="urow-spacer" />
                  <span className="hint">{u.books} books</span>
                </div>
                <dl className="facts compact">
                  <dt>Goodreads</dt>
                  <dd>
                    {u.goodreads_user_id || <span className="hint">not set</span>}
                    {u.has_rss_key ? <span className="hint"> · private-profile key stored</span> : null}
                  </dd>
                  <dt>Last sync</dt>
                  <dd>
                    {fmt(u.last_sync_at)}
                    {u.last_status && u.last_status !== 'ok' && (
                      <> <span className="chip">{u.last_status}</span></>
                    )}
                    {u.last_error && <div className="provenance">{u.last_error}</div>}
                  </dd>
                  <dt>Joined</dt><dd>{fmt(u.created_at)}</dd>
                  <dt>Sessions</dt><dd>{u.sessions}</dd>
                </dl>
                <div className="row">
                  <button className="btn btn-ghost" disabled={!u.goodreads_user_id}
                    onClick={() => act(() => api.admin.syncUser(u.id), `Sync queued for ${u.username}.`)}>
                    Sync now
                  </button>
                  <button className="btn btn-ghost" onClick={() => resetPassword(u)}>
                    Reset password
                  </button>
                  <button className="btn btn-ghost" disabled={!u.sessions}
                    onClick={() => act(() => api.admin.signOutUser(u.id), `${u.username} signed out everywhere.`)}>
                    Sign out everywhere
                  </button>
                  <button className="btn btn-ghost"
                    onClick={() => act(() => api.admin.patchUser(u.id, { isAdmin: !u.is_admin }),
                      `${u.username} is ${u.is_admin ? 'no longer' : 'now'} an administrator.`)}>
                    {u.is_admin ? 'Remove admin' : 'Make admin'}
                  </button>
                  {u.id !== me.id && (
                    <button className="btn btn-ghost danger"
                      onClick={() => {
                        if (confirmDelete !== u.id) { setConfirmDelete(u.id); return; }
                        setConfirmDelete(null);
                        void act(() => api.admin.deleteUser(u.id), `Deleted ${u.username}.`);
                      }}>
                      {confirmDelete === u.id ? 'Really delete?' : 'Delete'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}

        {tab === 'syncs' && (
          <section className="panel">
            {runs.length === 0 && <p className="hint">No syncs have run yet.</p>}
            {runs.map((r) => (
              <div className="urow" key={r.id}>
                <div className="urow-head">
                  <strong>{r.username}</strong>
                  <span className="chip">{r.status}</span>
                  <span className="hint">{r.trigger}</span>
                  <span className="urow-spacer" />
                  <span className="hint">{fmt(r.started_at)}</span>
                </div>
                <p className="hint">
                  {r.pages_fetched} pages · {r.items_seen} items seen · {r.books_new} new · {r.books_updated} updated
                </p>
                {r.error && <p className="provenance">{r.error}</p>}
              </div>
            ))}
          </section>
        )}

        {tab === 'server' && overview && (
          <section className="panel">
            <dl className="facts compact">
              <dt>People</dt><dd>{overview.users} ({overview.admins} admin, {overview.sessions} sessions)</dd>
              <dt>Books</dt><dd>{overview.books} distinct · {overview.shelvings} shelvings</dd>
              <dt>Covers</dt><dd>{overview.covers} cached · {overview.palettes} palettes</dd>
              <dt>Measured</dt>
              <dd>
                {overview.realDimensions} of {overview.books} have real dimensions
                <div className="provenance">the rest use the page-count heuristic</div>
              </dd>
              <dt>Enrichment</dt>
              <dd>{overview.enrichPending} pending · {overview.enrichFailed} failed</dd>
              <dt>Demo shelf</dt>
              <dd>{overview.demoBooks} books · {overview.demoCoversPending} covers still to fetch</dd>
              <dt>Goodreads feed</dt>
              <dd className="provenance">
                per_page=200 {overview.capability.perPage200Works ?? 'untested'} ·
                page= {overview.capability.pageParamWorks ?? 'untested'}
              </dd>
              {overview.cooldowns.length > 0 && (
                <>
                  <dt>Rate limited</dt>
                  <dd>
                    {overview.cooldowns.map((c) => (
                      <div key={c.host}>{c.host} until {fmt(c.until)} ({c.reason})</div>
                    ))}
                  </dd>
                </>
              )}
            </dl>

            <div className="row">
              <button className="btn"
                onClick={() => act(() => api.admin.setSignups(!overview.signupsEnabled),
                  overview.signupsEnabled ? 'New signups are closed.' : 'New signups are open.')}>
                {overview.signupsEnabled ? 'Close new signups' : 'Open new signups'}
              </button>
              <button className="btn btn-ghost"
                onClick={() => act(() => api.admin.reenrich(), 'Every book queued for re-enrichment.')}>
                Re-enrich all books
              </button>
            </div>
            <p className="hint">
              Signups are currently <strong>{overview.signupsEnabled ? 'open' : 'closed'}</strong>.
              Every account adds polling load against Goodreads, which is deliberately
              serialised, so syncs take longer as more people join.
            </p>
          </section>
        )}

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>Refresh</button>
        </div>
      </div>
    </dialog>
  );
}
