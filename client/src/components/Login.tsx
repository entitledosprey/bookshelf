import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Me } from '../types';
import { GoodreadsUserIdHelp, GoodreadsRssHelp } from './GoodreadsHelp';

/**
 * Accounts are invite-only: there is no open signup, so this screen asks for a
 * code rather than offering to create one.
 */
export function Login({ onSignedIn, onCancel }: { onSignedIn: (me: Me) => void; onCancel?: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
        ? await api.login(username, password)
        : await api.register({ username, password, goodreadsUserId, goodreadsRssKey });
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

        <label>
          {mode === 'login' ? 'Username or email' : 'Username'}
          {/* The format rule constrains what a NEW username may be. Applying it
              when signing in blocks people whose account predates usernames,
              or who simply type the email they signed up with. */}
          <input className="field" value={username} required
                 autoComplete="username" spellCheck={false}
                 {...(mode === 'register'
                   ? { pattern: '[A-Za-z0-9][A-Za-z0-9_\\-]{2,31}',
                       placeholder: '3-32 letters, numbers, - or _' }
                   : { placeholder: 'your username or email' })}
                 onChange={(e) => setUsername(e.target.value)} />
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
            <p className="hint">
              You can add your Goodreads details now or later from your account.
              Without them you will see the sample shelf.
            </p>
            <label>
              Goodreads user id <span className="hint">— optional</span>
              <input className="field" value={goodreadsUserId}
                     placeholder="152185079 or your profile URL"
                     onChange={(e) => setGoodreadsUserId(e.target.value)} />
            </label>
            <GoodreadsUserIdHelp />

            <label>
              Goodreads RSS key <span className="hint">— only if your profile is private</span>
              <input className="field" value={goodreadsRssKey}
                     autoComplete="off" spellCheck={false}
                     placeholder="paste your RSS link, or leave empty"
                     onChange={(e) => setGoodreadsRssKey(e.target.value)} />
            </label>
            <GoodreadsRssHelp />
          </>
        )}

        <button className="btn" type="submit" disabled={busy}>
          {busy
            ? (mode === 'login' ? 'Signing in' : 'Creating your shelf')
            : (mode === 'login' ? 'Sign in' : 'Create my shelf')}
        </button>
      </form>

      {onCancel && (
        <p className="switch">
          <button onClick={onCancel}>Back to the sample shelf</button>
        </p>
      )}

      <p className="switch">
        {mode === 'login' ? (
          <>New here? <button onClick={() => setMode('register')}>Create an account</button></>
        ) : (
          <>Already have an account? <button onClick={() => setMode('login')}>Sign in</button></>
        )}
      </p>
    </div>
  );
}
