import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Me } from '../types';

/**
 * Accounts are invite-only: there is no open signup, so this screen asks for a
 * code rather than offering to create one.
 */
export function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [goodreadsUserId, setGoodreadsUserId] = useState('');
  const [goodreadsRssKey, setGoodreadsRssKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = mode === 'login'
        ? await api.login(email, password)
        : await api.register({ inviteCode, email, password, goodreadsUserId, goodreadsRssKey });
      onSignedIn(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <h1>Bookshelf</h1>
      <p>Your Goodreads library, standing on a shelf.</p>

      <form onSubmit={submit}>
        {error && <p className="error">{error}</p>}

        {mode === 'register' && (
          <label>
            Invite code
            <input className="field" value={inviteCode} required
                   autoComplete="off" spellCheck={false}
                   onChange={(e) => setInviteCode(e.target.value.toUpperCase())} />
          </label>
        )}

        <label>
          Email
          <input className="field" type="email" value={email} required
                 autoComplete="email"
                 onChange={(e) => setEmail(e.target.value)} />
        </label>

        <label>
          Password
          <input className="field" type="password" value={password} required
                 minLength={8}
                 autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                 onChange={(e) => setPassword(e.target.value)} />
        </label>

        {mode === 'register' && (
          <>
            <label>
              Goodreads user id
              <input className="field" value={goodreadsUserId} required
                     inputMode="numeric" placeholder="e.g. 152185079"
                     onChange={(e) => setGoodreadsUserId(e.target.value.trim())} />
              <span className="hint">
                The number in your Goodreads profile URL, like
                goodreads.com/user/show/<strong>152185079</strong>-your-name
              </span>
            </label>
            <label>
              Goodreads RSS key <span className="hint">— only if your profile is private</span>
              <input className="field" value={goodreadsRssKey}
                     autoComplete="off" spellCheck={false}
                     onChange={(e) => setGoodreadsRssKey(e.target.value.trim())} />
            </label>
          </>
        )}

        <button className="btn" type="submit" disabled={busy}>
          {busy
            ? (mode === 'login' ? 'Signing in' : 'Creating your shelf')
            : (mode === 'login' ? 'Sign in' : 'Create my shelf')}
        </button>
      </form>

      <p className="switch">
        {mode === 'login' ? (
          <>Have an invite code? <button onClick={() => setMode('register')}>Set up your shelf</button></>
        ) : (
          <>Already set up? <button onClick={() => setMode('login')}>Sign in</button></>
        )}
      </p>
    </div>
  );
}
