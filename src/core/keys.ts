// Default import (not named) so tests can spy on crypto.timingSafeEqual.
import crypto from 'node:crypto';

/** A stored key hash: "sha256:" + 64 lowercase hex characters (Spec 001 Decision 3). */
export const KEY_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

const HASH_PREFIX = 'sha256:';

/** A new site or viewer key: "prk_" + 32 random bytes as base64url (47 characters). */
export function generateKey(): string {
  return 'prk_' + crypto.randomBytes(32).toString('base64url');
}

/** The form a key is stored in: "sha256:<hex of SHA-256(key)>". */
export function hashKey(key: string): string {
  return HASH_PREFIX + digest(key).toString('hex');
}

/**
 * True when `key` hashes to any entry of `hashes`. Compares with
 * `crypto.timingSafeEqual` and checks every entry, so timing reveals neither
 * the key nor which entry matched. Malformed entries are skipped; never throws.
 */
export function verifyKey(key: string, hashes: string[]): boolean {
  const presented = digest(key);
  let matched = false;
  for (const hash of hashes) {
    if (typeof hash !== 'string' || !KEY_HASH_PATTERN.test(hash)) continue;
    const stored = Buffer.from(hash.slice(HASH_PREFIX.length), 'hex');
    if (crypto.timingSafeEqual(presented, stored)) matched = true;
  }
  return matched;
}

function digest(key: string): Buffer {
  return crypto.createHash('sha256').update(key, 'utf8').digest();
}
