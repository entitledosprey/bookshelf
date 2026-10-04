import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Me } from '../types';
import { GoodreadsUserIdHelp, GoodreadsRssHelp } from './GoodreadsHelp';

/**
 * Account settings: Goodreads details and password. Opened from the top bar.
 */
export function Account({ me, onUpdated, onClose, onSync }: {
  me: Me;
  onUpdated: (me: Me) => void;
  onClose: () => void;
  onSync: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  const [userId, setUserId] = useState(me.goodreadsUserId ?? '');
  const [rssKey, setRssKey] = useState('');
  const [grMsg, setGrMsg] = useState('');
  const [grErr, setGrErr] = useState('');
  const [grBusy, setGrBusy] = useState(false);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();
    el.focus({ preventScroll: true });
    el.scrollTop = 0;
    const onCancel = (e: Event) => { e.preventDefault(); onClose(); };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, [onClose]);

  const saveGoodreads = async (e: React.FormEvent) => {
    e.preventDefault();
    setGrBusy(true); setGrErr(''); setGrMsg('');
    try {
      const body: { goodreadsUserId?: string; goodreadsRssKey?: string } = {
        goodreadsUserId: userId,
      };
      // Only send the key when something was typed, so an empty field does not
      // wipe a key that is already stored.
      if (rssKey.trim()) body.goodreadsRssKey = rssKey;
      const updated = await api.updateAccount(body);
      onUpdated(updated);
      setRssKey('');
      setGrMsg('Saved. The next sync will use these details.');
    } catch (err) {
      setGrErr(err instanceof ApiError ? err.message : 'Could not save that.');
    } finally {
      setGrBusy(false);
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwBusy(true); setPwErr(''); setPwMsg('');
    if (next !== confirm) {
      setPwErr('The two new passwords do not match.');
      setPwBusy(false);
      return;
    }
    try {
      await api.changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      setPwMsg('Password changed. Any other signed-in devices were signed out.');
    } catch (err) {
      setPwErr(err instanceof ApiError ? err.message : 'Could not change your password.');
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <dialog
      className="sheet account"
      ref={ref}
      tabIndex={-1}
      aria-label="Account settings"
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="sheet-body">
        <h2 className="sheet-title">Account</h2>
        <p className="sheet-author">{me.username}</p>

        <section className="panel">
          <h3>Goodreads</h3>
          <form onSubmit={saveGoodreads}>
            {grErr && <p className="error">{grErr}</p>}
            {grMsg && <p className="ok">{grMsg}</p>}

            <label>
              User id
              <input
                className="field" value={userId} inputMode="numeric"
                placeholder="152185079 or your profile URL"
                onChange={(e) => setUserId(e.target.value)}
              />
            </label>
            <GoodreadsUserIdHelp />

            <label>
              RSS key <span className="hint">— only if your profile is private</span>
              <input
                className="field" value={rssKey} autoComplete="off" spellCheck={false}
                placeholder={me.goodreadsUserId ? 'leave empty to keep the stored key' : 'paste your RSS link'}
                onChange={(e) => setRssKey(e.target.value)}
              />
            </label>
            <GoodreadsRssHelp />

            <div className="row">
              <button className="btn" type="submit" disabled={grBusy}>
                {grBusy ? 'Saving' : 'Save Goodreads details'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={onSync}>
                Sync now
              </button>
            </div>
          </form>
        </section>

        <section className="panel">
          <h3>Password</h3>
          <form onSubmit={savePassword}>
            {pwErr && <p className="error">{pwErr}</p>}
            {pwMsg && <p className="ok">{pwMsg}</p>}

            <label>
              Current password
              <input className="field" type="password" value={current} required
                     autoComplete="current-password"
                     onChange={(e) => setCurrent(e.target.value)} />
            </label>
            <label>
              New password
              <input className="field" type="password" value={next} required minLength={8}
                     autoComplete="new-password"
                     onChange={(e) => setNext(e.target.value)} />
            </label>
            <label>
              New password again
              <input className="field" type="password" value={confirm} required minLength={8}
                     autoComplete="new-password"
                     onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <button className="btn" type="submit" disabled={pwBusy}>
              {pwBusy ? 'Changing' : 'Change password'}
            </button>
          </form>
        </section>

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
