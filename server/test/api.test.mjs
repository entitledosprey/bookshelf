import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRssSink } from './rss-sink.mjs';

/**
 * Signups are rate limited per IP (5 per 10 minutes), which is right in
 * production and fatal here, where every test registers from 127.0.0.1. Reset
 * the counter between registration-heavy cases rather than weakening the limit.
 */
let resetThrottle = () => {};

const dir = mkdtempSync(join(tmpdir(), 'bookshelf-test-'));
let sink;
let base;
let server;

before(async () => {
  sink = await startRssSink();
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.COVER_DIR = join(dir, 'covers');
  process.env.ADMIN_API_KEY = 'test-admin-key';
  process.env.SECURE_COOKIES = 'false';
  process.env.ENRICH_ENABLED = 'false';
  process.env.GOODREADS_BASE_URL = sink.url;
  process.env.GOODREADS_MIN_DELAY_MS = '1';

  const { openDb } = await import('../src/db.js');
  openDb();
  const { seedDemo } = await import('../src/demo/seed.js');
  seedDemo();
  ({ _resetThrottle: resetThrottle } = await import('../src/auth/middleware.js'));
  const { createApp } = await import('../src/index.js');
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await sink?.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (path, init = {}) => fetch(`${base}${path}`, {
  ...init,
  headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
});
const json = async (path, init) => {
  const res = await call(path, init);
  return { status: res.status, body: await res.json().catch(() => null), res };
};

test('healthz works and never needs Goodreads', async () => {
  const { status, body } = await json('/healthz');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('unauthenticated book access is rejected', async () => {
  assert.equal((await json('/api/v1/books')).status, 401);
  assert.equal((await json('/api/v1/sync/status')).status, 401);
});

let token;

test('anyone can sign up with a username and password', async () => {
  resetThrottle();
  const { status, body } = await json('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'alice', password: 'a-good-passphrase', goodreadsUserId: '1' }),
  });
  assert.equal(status, 201);
  assert.ok(body.token);
  assert.equal(body.user.username, 'alice');
  // The first account on an instance runs it.
  assert.equal(body.user.isAdmin, true, 'the first account should be the administrator');
  token = body.token;
});

test('usernames are validated and unique', async () => {
  resetThrottle();
  const dupe = await json('/api/v1/auth/register', {
    method: 'POST', body: JSON.stringify({ username: 'alice', password: 'another-passphrase' }),
  });
  assert.equal(dupe.status, 409);

  for (const bad of ['ab', '-nope', 'has space', 'no!']) {
    const r = await json('/api/v1/auth/register', {
      method: 'POST', body: JSON.stringify({ username: bad, password: 'a-good-passphrase' }),
    });
    assert.equal(r.status, 400, `"${bad}" should be rejected`);
  }
});

test('Goodreads details are optional at signup', async () => {
  resetThrottle();
  const { status, body } = await json('/api/v1/auth/register', {
    method: 'POST', body: JSON.stringify({ username: 'bob', password: 'a-good-passphrase' }),
  });
  assert.equal(status, 201);
  assert.equal(body.user.goodreadsUserId, null);
  // ...and a later account is NOT an administrator.
  assert.equal(body.user.isAdmin, false);
});

test('a display name typed as a user id is rejected with a useful message', async () => {
  resetThrottle();
  // This is the mistake that otherwise produces a bare 404 from Goodreads.
  const { status, body } = await json('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'carol', password: 'a-good-passphrase', goodreadsUserId: 'Harrison Faulkner' }),
  });
  assert.equal(status, 400);
  assert.match(body.error, /NUMBER/);
});

test('login rejects a wrong password with the same message as an unknown user', async () => {
  const wrong = await json('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'alice', password: 'nope-nope-nope' }),
  });
  const missing = await json('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'ghost', password: 'nope-nope-nope' }),
  });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(wrong.body.error, missing.body.error, 'must not reveal which accounts exist');
});

test('the Bearer token authenticates', async () => {
  const { status, body } = await json('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(status, 200);
  assert.equal(body.username, 'alice');
});

test('the session cookie authenticates the same endpoints', async () => {
  const login = await call('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'alice', password: 'a-good-passphrase' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { status } = await json('/api/v1/auth/me', { headers: { Cookie: cookie } });
  assert.equal(status, 200, 'one session must work from either a header or a cookie');
});

test('the registration sync ingests the fixture feed', async () => {
  // Registration queues a sync; give the in-process scheduler a moment.
  for (let i = 0; i < 60; i += 1) {
    const { body } = await json('/api/v1/sync/status', { headers: { Authorization: `Bearer ${token}` } });
    if (body?.lastRun?.finishedAt) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const { body } = await json('/api/v1/sync/status', { headers: { Authorization: `Bearer ${token}` } });
  assert.ok(body.lastRun, 'a sync run should have been recorded');
  assert.equal(body.lastRun.booksNew, 5, 'the fixture has 5 parseable items');
  assert.equal(body.coverage.complete, true, 'every shelf walk ended on a short page');
});

test('books are returned with geometry and palette as pure data', async () => {
  const { status, body } = await json('/api/v1/books', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(status, 200);
  assert.equal(body.books.length, 5);

  const b = body.books[0];
  assert.equal(typeof b.geometry.heightMm, 'number');
  assert.equal(typeof b.geometry.thicknessMm, 'number');
  assert.match(b.palette.bg, /^#[0-9a-f]{6}$/);
  assert.ok(b.spineStyle);

  // The property that makes a native client cheap: no markup anywhere.
  const raw = JSON.stringify(body);
  assert.ok(!/<[a-z]/i.test(raw), 'the payload must contain no HTML');
  assert.ok(!/px"|rgba?\(/.test(raw), 'the payload must contain no CSS');
});

test('to-read books are sectioned separately', async () => {
  const { body } = await json('/api/v1/books', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(body.sections.library.length + body.sections.toRead.length, body.books.length);
  assert.ok(body.sections.toRead.length > 0, 'the sink serves the fixture on the to-read shelf too');
});

test('a second sync adds no new books', async () => {
  await json('/api/v1/sync/run', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  for (let i = 0; i < 60; i += 1) {
    const { body } = await json('/api/v1/sync/status', { headers: { Authorization: `Bearer ${token}` } });
    if (body?.lastRun?.trigger === 'manual' && body.lastRun.finishedAt) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const { body } = await json('/api/v1/sync/status', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(body.lastRun.booksNew, 0, 'append-only: a repeat sync must add nothing');
  assert.ok(body.lastRun.booksUpdated > 0);
});

test('preferences round-trip and are validated', async () => {
  const ok = await json('/api/v1/auth/prefs', {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ theme: 'academia', order: 'colour' }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.theme, 'academia');

  const bad = await json('/api/v1/auth/prefs', {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ theme: 'neon' }),
  });
  assert.equal(bad.status, 400);
});

test('a cover that was never fetched 404s rather than erroring', async () => {
  const { status } = await json('/api/v1/books', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(status, 200);
  const res = await call('/api/v1/covers/34', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 404);
});

test('one user cannot see another user\'s shelf', async () => {
  resetThrottle();
  const reg = await json('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'dave', password: 'a-good-passphrase' }),
  });
  const { body } = await json('/api/v1/books', { headers: { Authorization: `Bearer ${reg.body.token}` } });
  assert.equal(body.books.length, 0, 'a new account must start with an empty shelf');

  // ...and must not be able to pull the other account's cached cover.
  const res = await call('/api/v1/covers/34', { headers: { Authorization: `Bearer ${reg.body.token}` } });
  assert.equal(res.status, 404);
});

test('logout revokes the session', async () => {
  const login = await json('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'alice', password: 'a-good-passphrase' }),
  });
  const t = login.body.token;
  assert.equal((await json('/api/v1/auth/me', { headers: { Authorization: `Bearer ${t}` } })).status, 200);
  await json('/api/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${t}` } });
  assert.equal((await json('/api/v1/auth/me', { headers: { Authorization: `Bearer ${t}` } })).status, 401);
});

test('the demo shelf is public and needs no account', async () => {
  const { status, body } = await json('/api/v1/demo/books');
  assert.equal(status, 200);
  assert.equal(body.demo, true);
  assert.ok(body.books.length >= 12, 'the demo shelf should not be empty');
  assert.ok(body.totals.pool >= body.books.length);
});

test('demo books carry real data and no user state', async () => {
  const { body } = await json('/api/v1/demo/books');
  for (const b of body.books.slice(0, 10)) {
    assert.ok(b.title && b.author, 'demo books are real titles, not placeholders');
    assert.match(b.palette.bg, /^#[0-9a-f]{6}$/);
    assert.ok(b.geometry.thicknessMm > 0);
    assert.equal(b.userRating, null, 'the demo must not expose anyone\'s reading state');
    assert.deepEqual(b.shelves, []);
    assert.ok(b.id.startsWith('demo-'));
  }
});

test('the demo sample is randomised between visits', async () => {
  const ids = async () => (await json('/api/v1/demo/books')).body.books.map((b) => b.id).sort().join();
  // Two identical draws would be a 1-in-many coincidence; three would not happen.
  const draws = new Set([await ids(), await ids(), await ids()]);
  assert.ok(draws.size > 1, 'the demo shelf should differ between visits');
});

test('demo books never leak into a real account\'s shelf', async () => {
  const { body } = await json('/api/v1/books', { headers: { Authorization: `Bearer ${token}` } });
  assert.ok(!body.books.some((b) => b.id.startsWith('demo-')));
});

test('Goodreads details accept a pasted profile URL', async () => {
  const { status, body } = await json('/api/v1/auth/account', {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ goodreadsUserId: 'https://www.goodreads.com/user/show/152185079-someone' }),
  });
  assert.equal(status, 200);
  assert.equal(body.goodreadsUserId, '152185079', 'the id should be extracted from the URL');
});

test('Goodreads details reject nonsense and require auth', async () => {
  const bad = await json('/api/v1/auth/account', {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ goodreadsUserId: 'not-a-number' }),
  });
  assert.equal(bad.status, 400);
  const unauth = await json('/api/v1/auth/account', {
    method: 'PATCH', body: JSON.stringify({ goodreadsUserId: '1' }),
  });
  assert.equal(unauth.status, 401);
});

test('changing the password requires the current one and rotates sessions', async () => {
  resetThrottle();
  // Use a throwaway account so the rest of the suite keeps its session.
  const reg = await json('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'erin', password: 'first-passphrase' }),
  });
  const a = reg.body.token;
  // A second session that should be revoked by the change.
  const b = (await json('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'erin', password: 'first-passphrase' }),
  })).body.token;

  assert.equal((await json('/api/v1/auth/password', {
    method: 'POST', headers: { Authorization: `Bearer ${b}` },
    body: JSON.stringify({ currentPassword: 'wrong-passphrase', newPassword: 'second-passphrase' }),
  })).status, 401);

  assert.equal((await json('/api/v1/auth/password', {
    method: 'POST', headers: { Authorization: `Bearer ${b}` },
    body: JSON.stringify({ currentPassword: 'first-passphrase', newPassword: 'short' }),
  })).status, 400);

  assert.equal((await json('/api/v1/auth/password', {
    method: 'POST', headers: { Authorization: `Bearer ${b}` },
    body: JSON.stringify({ currentPassword: 'first-passphrase', newPassword: 'second-passphrase' }),
  })).status, 200);

  // The old password stops working, the new one works.
  assert.equal((await json('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'erin', password: 'first-passphrase' }),
  })).status, 401);
  assert.equal((await json('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'erin', password: 'second-passphrase' }),
  })).status, 200);

  // The session that made the change survives; the other one does not.
  assert.equal((await json('/api/v1/auth/me', { headers: { Authorization: `Bearer ${b}` } })).status, 200);
  assert.equal((await json('/api/v1/auth/me', { headers: { Authorization: `Bearer ${a}` } })).status, 401,
    'other sessions must be revoked when the password changes');
});

test('the admin surface is closed to anonymous and non-admin users', async () => {
  resetThrottle();
  // Anonymous.
  assert.equal((await json('/api/v1/admin/overview')).status, 401);
  assert.equal((await json('/api/v1/admin/users')).status, 401);

  // A signed-in ordinary account is forbidden, not merely unauthorised.
  const reg = await json('/api/v1/auth/register', {
    method: 'POST', body: JSON.stringify({ username: 'nosy', password: 'a-good-passphrase' }),
  });
  const plain = reg.body.token;
  assert.equal((await json('/api/v1/admin/overview', { headers: { Authorization: `Bearer ${plain}` } })).status, 403);
  assert.equal((await json('/api/v1/admin/users', { headers: { Authorization: `Bearer ${plain}` } })).status, 403);
});

test('an admin session can read the overview and the user list', async () => {
  // `token` belongs to alice, the first account, so she is the administrator.
  const o = await json('/api/v1/admin/overview', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(o.status, 200);
  assert.ok(o.body.users >= 1);
  assert.equal(typeof o.body.signupsEnabled, 'boolean');
  assert.ok(Array.isArray(o.body.cooldowns));

  const u = await json('/api/v1/admin/users', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(u.status, 200);
  assert.ok(u.body.some((x) => x.username === 'alice' && x.is_admin));
  // The stored RSS key must never be sent to the browser, only whether one exists.
  for (const row of u.body) {
    assert.ok(!('goodreads_rss_key' in row), 'the RSS key itself must not leave the server');
    assert.ok(!('password_hash' in row), 'password hashes must not leave the server');
  }
});

test('the ADMIN_API_KEY still works as break-glass', async () => {
  const { status } = await json('/api/v1/admin/overview', { headers: { 'X-Admin-Key': 'test-admin-key' } });
  assert.equal(status, 200);
  assert.equal((await json('/api/v1/admin/overview', { headers: { 'X-Admin-Key': 'wrong' } })).status, 401);
});

test('signups can be closed and reopened', async () => {
  resetThrottle();
  const A = { Authorization: `Bearer ${token}` };
  await json('/api/v1/admin/settings', { method: 'PATCH', headers: A, body: JSON.stringify({ signupsEnabled: false }) });

  assert.equal((await json('/api/v1/auth/config')).body.signupsEnabled, false);
  const blocked = await json('/api/v1/auth/register', {
    method: 'POST', body: JSON.stringify({ username: 'latecomer', password: 'a-good-passphrase' }),
  });
  assert.equal(blocked.status, 403);

  await json('/api/v1/admin/settings', { method: 'PATCH', headers: A, body: JSON.stringify({ signupsEnabled: true }) });
  resetThrottle();
  const allowed = await json('/api/v1/auth/register', {
    method: 'POST', body: JSON.stringify({ username: 'latecomer', password: 'a-good-passphrase' }),
  });
  assert.equal(allowed.status, 201);
});

test('the last administrator cannot be demoted or deleted', async () => {
  const A = { Authorization: `Bearer ${token}` };
  const users = (await json('/api/v1/admin/users', { headers: A })).body;
  const admins = users.filter((u) => u.is_admin);
  assert.equal(admins.length, 1, 'alice should be the only admin at this point');

  const demote = await json(`/api/v1/admin/users/${admins[0].id}`, {
    method: 'PATCH', headers: A, body: JSON.stringify({ isAdmin: false }),
  });
  assert.equal(demote.status, 400);

  const del = await json(`/api/v1/admin/users/${admins[0].id}`, { method: 'DELETE', headers: A });
  assert.equal(del.status, 400);
});

test('an admin can reset a password, which signs that user out everywhere', async () => {
  const A = { Authorization: `Bearer ${token}` };
  const users = (await json('/api/v1/admin/users', { headers: A })).body;
  const bob = users.find((u) => u.username === 'bob');

  const bobToken = (await json('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'bob', password: 'a-good-passphrase' }),
  })).body.token;
  assert.equal((await json('/api/v1/auth/me', { headers: { Authorization: `Bearer ${bobToken}` } })).status, 200);

  const reset = await json(`/api/v1/admin/users/${bob.id}/password`, {
    method: 'POST', headers: A, body: JSON.stringify({ newPassword: 'reset-by-the-admin' }),
  });
  assert.equal(reset.status, 200);

  assert.equal((await json('/api/v1/auth/me', { headers: { Authorization: `Bearer ${bobToken}` } })).status, 401,
    'an admin password reset must end that user\'s sessions');
  assert.equal((await json('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'bob', password: 'reset-by-the-admin' }),
  })).status, 200);
});

test('deleting a user removes their shelf but keeps shared book rows', async () => {
  const A = { Authorization: `Bearer ${token}` };
  const before = (await json('/api/v1/admin/overview', { headers: A })).body.books;
  const users = (await json('/api/v1/admin/users', { headers: A })).body;
  const victim = users.find((u) => u.username === 'latecomer');

  assert.equal((await json(`/api/v1/admin/users/${victim.id}`, { method: 'DELETE', headers: A })).status, 200);
  const after = (await json('/api/v1/admin/overview', { headers: A })).body;
  assert.equal(after.books, before, 'shared bibliographic rows must survive a user deletion');
  assert.ok(!(await json('/api/v1/admin/users', { headers: A })).body.some((u) => u.username === 'latecomer'));
});

test('unknown API endpoints 404 as JSON', async () => {
  const { status, body } = await json('/api/v1/nope');
  assert.equal(status, 404);
  assert.ok(body.error);
});
