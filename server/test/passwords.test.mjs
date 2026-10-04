import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptHash, scryptVerify, safeEqual } from '../src/auth/passwords.js';

const CHEAP = { cost: 1024 }; // keep the suite fast

test('a hash verifies against its own password', () => {
  const h = scryptHash('correct horse battery staple', CHEAP);
  assert.ok(scryptVerify('correct horse battery staple', h));
});

test('a wrong password does not verify', () => {
  const h = scryptHash('correct horse battery staple', CHEAP);
  assert.equal(scryptVerify('wrong', h), false);
  assert.equal(scryptVerify('', h), false);
});

test('the stored format records its own parameters', () => {
  const h = scryptHash('a-good-passphrase', CHEAP);
  const parts = h.split('$');
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts.length, 6);
  assert.equal(Number(parts[1]), 1024);
});

test('the same password hashes differently every time (random salt)', () => {
  assert.notEqual(scryptHash('a-good-passphrase', CHEAP), scryptHash('a-good-passphrase', CHEAP));
});

test('malformed stored hashes return false rather than throwing', () => {
  for (const bad of ['', 'not-a-hash', 'scrypt$x', null, undefined, 'bcrypt$1$2$3$4$5']) {
    assert.equal(scryptVerify('anything', bad), false);
  }
});

test('short passwords are rejected at hash time', () => {
  assert.throws(() => scryptHash('short', CHEAP));
  assert.throws(() => scryptHash(null, CHEAP));
});

test('safeEqual compares correctly including length mismatches', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'ab'), false);
  assert.equal(safeEqual('', ''), true);
});
