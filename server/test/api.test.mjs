import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRssSink } from './rss-sink.mjs';

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

test('admin routes reject a missing or wrong key', async () => {
  assert.equal((await json('/api/v1/admin/invites', { method: 'POST' })).status, 401);
  assert.equal((await json('/api/v1/admin/invites', {
    method: 'POST', headers: { 'X-Admin-Key': 'wrong' },
  })).status, 401);
});

test('unauthenticated book access is rejected', async () => {
  assert.equal((await json('/api/v1/books')).status, 401);
  assert.equal((await json('/api/v1/sync/status')).status, 401);
});

let token;
let code;

test('an invite can be minted with the admin key', async () => {
  const { status, body } = await json('/api/v1/admin/invites', {
    method: 'POST', headers: { 'X-Admin-Key': 'test-admin-key' },
  });
  assert.equal(status, 201);
  assert.match(body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  code = body.code;
});

test('registration requires a valid invite', async () => {
  const bad = await json('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ inviteCode: 'NOPE-NOPE-NOPE', email: 'a@example.test', password: 'a-good-passphrase', goodreadsUserId: '1' }),
  });
  assert.equal(bad.status, 400);
});

test('a valid invite creates an account and returns a token', async () => {
  const { status, body } = await json('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ inviteCode: code, email: 'a@example.test', password: 'a-good-passphrase', goodreadsUserId: '1' }),
  });
  assert.equal(status, 201);
  assert.ok(body.token);
  assert.equal(body.user.email, 'a@example.test');
  token = body.token;
});

test('an invite cannot be reused', async () => {
  const again = await json('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ inviteCode: code, email: 'b@example.test', password: 'a-good-passphrase', goodreadsUserId: '2' }),
  });
  assert.equal(again.status, 400);
});

test('login rejects a wrong password with the same message as an unknown user', async () => {
  const wrong = await json('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ email: 'a@example.test', password: 'nope-nope-nope' }),
  });
  const missing = await json('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ email: 'ghost@example.test', password: 'nope-nope-nope' }),
  });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(wrong.body.error, missing.body.error, 'must not reveal which accounts exist');
});

test('the Bearer token authenticates', async () => {
  const { status, body } = await json('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(status, 200);
  assert.equal(body.email, 'a@example.test');
});

test('the session cookie authenticates the same endpoints', async () => {
  const login = await call('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ email: 'a@example.test', password: 'a-good-passphrase' }),
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
  const inv = await json('/api/v1/admin/invites', { method: 'POST', headers: { 'X-Admin-Key': 'test-admin-key' } });
  const reg = await json('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ inviteCode: inv.body.code, email: 'c@example.test', password: 'a-good-passphrase', goodreadsUserId: '' }),
  });
  const { body } = await json('/api/v1/books', { headers: { Authorization: `Bearer ${reg.body.token}` } });
  assert.equal(body.books.length, 0, 'a new account must start with an empty shelf');

  // ...and must not be able to pull the other account's cached cover.
  const res = await call('/api/v1/covers/34', { headers: { Authorization: `Bearer ${reg.body.token}` } });
  assert.equal(res.status, 404);
});

test('logout revokes the session', async () => {
  const login = await json('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ email: 'a@example.test', password: 'a-good-passphrase' }),
  });
  const t = login.body.token;
  assert.equal((await json('/api/v1/auth/me', { headers: { Authorization: `Bearer ${t}` } })).status, 200);
  await json('/api/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${t}` } });
  assert.equal((await json('/api/v1/auth/me', { headers: { Authorization: `Bearer ${t}` } })).status, 401);
});

test('unknown API endpoints 404 as JSON', async () => {
  const { status, body } = await json('/api/v1/nope');
  assert.equal(status, 404);
  assert.ok(body.error);
});
