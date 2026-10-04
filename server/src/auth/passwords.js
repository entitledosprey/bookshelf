import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * scrypt from node:crypto rather than bcrypt.
 *
 * bcrypt is a native module, and the Dockerfile builds dependencies in a
 * --platform=$BUILDPLATFORM stage then copies node_modules into the target-arch
 * runtime stage -- a native binary would be the wrong architecture on arm64.
 * scrypt is built in, memory-hard, and needs no compilation.
 */

const N = 16384; // CPU/memory cost
const r = 8;
const p = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

export function scryptHash(password, { cost = N } = {}) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEYLEN, { N: cost, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${cost}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function scryptVerify(password, stored) {
  try {
    const parts = String(stored ?? '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, cost, rr, pp, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(String(password ?? ''), salt, expected.length, {
      N: Number(cost), r: Number(rr), p: Number(pp), maxmem: 256 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Constant-time compare, used for the admin break-glass key. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
