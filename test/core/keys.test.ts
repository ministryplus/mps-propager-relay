import crypto, { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKey, hashKey, KEY_HASH_PATTERN, verifyKey } from '../../src/core/keys.js';

describe('generateKey', () => {
  it('returns prk_ followed by 43 base64url characters', () => {
    expect(generateKey()).toMatch(/^prk_[A-Za-z0-9_-]{43}$/);
  });

  it('returns a different key every call', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateKey()));
    expect(keys.size).toBe(100);
  });
});

describe('hashKey', () => {
  it('returns sha256: plus the lowercase hex digest of the key', () => {
    const expected = 'sha256:' + createHash('sha256').update('prk_test', 'utf8').digest('hex');
    expect(hashKey('prk_test')).toBe(expected);
  });

  it('matches KEY_HASH_PATTERN', () => {
    expect(hashKey('prk_test')).toMatch(KEY_HASH_PATTERN);
    expect(hashKey(generateKey())).toMatch(KEY_HASH_PATTERN);
  });
});

describe('KEY_HASH_PATTERN', () => {
  it('rejects malformed hashes', () => {
    const hex = 'a'.repeat(64);
    expect(KEY_HASH_PATTERN.test(`sha256:${hex}`)).toBe(true);
    expect(KEY_HASH_PATTERN.test('sha256:abc')).toBe(false);
    expect(KEY_HASH_PATTERN.test(`md5:${hex}`)).toBe(false);
    expect(KEY_HASH_PATTERN.test(`sha256:${'A'.repeat(64)}`)).toBe(false);
    expect(KEY_HASH_PATTERN.test(`sha256:${hex}0`)).toBe(false);
    expect(KEY_HASH_PATTERN.test(` sha256:${hex}`)).toBe(false);
  });
});

describe('verifyKey', () => {
  afterEach(() => vi.restoreAllMocks());

  const key = generateKey();
  const other = generateKey();

  it('accepts a key whose hash is listed', () => {
    expect(verifyKey(key, [hashKey(key)])).toBe(true);
  });

  it('rejects a different key', () => {
    expect(verifyKey(other, [hashKey(key)])).toBe(false);
  });

  it('accepts a match that is not first in the list (rotation)', () => {
    expect(verifyKey(key, [hashKey(other), hashKey(key)])).toBe(true);
  });

  it('rejects against an empty list', () => {
    expect(verifyKey(key, [])).toBe(false);
  });

  it('skips malformed hashes and still finds a match', () => {
    expect(verifyKey(key, ['sha256:abc', 'nonsense', hashKey(key)])).toBe(true);
  });

  it('returns false without throwing when every hash is malformed', () => {
    const malformed = ['sha256:abc', `md5:${'a'.repeat(64)}`, `sha256:${'A'.repeat(64)}`, ''];
    expect(() => verifyKey(key, malformed)).not.toThrow();
    expect(verifyKey(key, malformed)).toBe(false);
  });

  it('compares with crypto.timingSafeEqual', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    verifyKey(key, [hashKey(other), hashKey(key)]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('checks every hash rather than stopping at the first match', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    expect(verifyKey(key, [hashKey(key), hashKey(other), 'sha256:bad'])).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
