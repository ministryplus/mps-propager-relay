# Task 001-3: Config and keys (RelayConfig, validateConfig, key helpers)

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Complete
**Parallel group:** Wave 2 (parallel with [001-2](001-2-protocol.md), [001-4](001-4-slack-api.md), [001-8](001-8-events-api.md) — disjoint files: `src/core/config.ts`, `src/core/keys.ts`, their tests)
**Depends on:** [001-1](001-1-scaffold.md)
**Blocks:** [001-5](001-5-router.md), [001-6](001-6-sessions.md), [001-7](001-7-outbound.md)

## What

Define the relay's configuration and site/viewer keys (Spec 001 Decisions 2
and 3). `src/core/config.ts` holds the `RelayConfig`, `SiteConfig`,
`ViewerConfig`, and `RelayLimits` types exactly as Decision 2 writes them,
`DEFAULT_LIMITS` with Decision 2's values, and `validateConfig(config)`,
which checks every Decision 2 rule and returns a `ResolvedConfig` (limits
filled in, plus a `channelOwner` map from channel id to site name) or throws
one `ConfigError` that lists **every** problem, not just the first.
`src/core/keys.ts` generates `prk_` keys, hashes them to `sha256:<hex>`, and
verifies a presented key against a list of hashes with a timing-safe compare.
Both are pure (no I/O beyond `node:crypto`), so they're unit-tested directly.
`createRelay` (001-10) calls `validateConfig`; the session hub (001-6) calls
`verifyKey`; the standalone `keygen` command (001-11) calls `generateKey` and
`hashKey`.

## Steps

1. **Types in `src/core/config.ts`**, copied from Decision 2 with their
   comments: `RelayConfig` (`slack.botToken`, `slack.ingress` as the
   `events-api` / `socket-mode` union, `sites`, `viewers?`, `limits?:
   Partial<RelayLimits>`), `SiteConfig` (`name`, `channels`, `keyHashes`),
   `ViewerConfig` (`name`, `channels: string[] | '*'`, `keyHashes`,
   `canPost`), `RelayLimits` (the seven fields).
2. **`DEFAULT_LIMITS: RelayLimits`** with Decision 2's values:
   `resumeWindowMs: 120_000`, `resumeMaxEvents: 200`, `maxEventAgeMs: 300_000`,
   `historySize: 50`, `handshakeTimeoutMs: 10_000`, `idleTimeoutMs: 90_000`,
   `maxFrameBytes: 65_536`. Freeze it (`Object.freeze`) so no caller mutates
   the shared defaults.
3. **`ResolvedConfig`** (plan: "RelayConfig + limits filled in + channelOwner"):
   ```ts
   export interface ResolvedConfig {
     slack: RelayConfig['slack'];
     sites: SiteConfig[];
     viewers: ResolvedViewerConfig[];        // [] when config.viewers is absent
     limits: RelayLimits;                    // { ...DEFAULT_LIMITS, ...config.limits }
     channelOwner: Map<string, string>;      // channel id → site name
   }
   export interface ResolvedViewerConfig extends Omit<ViewerConfig, 'channels'> {
     channels: string[];                     // '*' expanded to every site channel
   }
   ```
   `'*'` is expanded here (Decision 2: "every channel any site owns"), sorted,
   so downstream code (`Principal.channels: string[]` in 001-6) never has to
   special-case it.
4. **`ConfigError extends Error`** with `readonly problems: string[]`. Its
   `message` is `"Invalid relay config:\n- <problem>\n- <problem>…"`, one line
   per problem, so a standalone startup log shows all of them at once.
5. **`validateConfig(config: RelayConfig): ResolvedConfig`.** Collect problems
   into an array, never stopping at the first, then throw `ConfigError` if any.
   Each problem names the entry it's about (`site "north"`, `viewer "portal"`).
   The rules, all from Decision 2:
   - **Names unique within sites and within viewers.** A site and a viewer
     may share a name. Report each duplicated name once.
   - **Every channel id matches `^[CG][A-Z0-9]+$`**, in sites and in
     viewers (when not `'*'`). Report the entry and the bad id.
   - **Each site has at least one channel** (Decision 2 `SiteConfig`
     comment: "at least one").
   - **Each channel belongs to exactly one site.** Report the channel and
     every site that lists it (e.g. `channel C0123ABC is listed by sites "north" and "south"`).
   - **Every key hash parses:** `^sha256:[0-9a-f]{64}$`.
   - **A key hash is used by at most one site or viewer**, counted across
     sites and viewers together. The same hash listed twice by one entry
     isn't a conflict.
   On success, build `channelOwner` from the sites, merge limits over
   `DEFAULT_LIMITS`, default `viewers` to `[]`, and expand `'*'`. Don't
   mutate the input.
6. **`src/core/keys.ts`** (Decision 3), plan signatures exactly:
   - `generateKey(): string` → `'prk_' + randomBytes(32).toString('base64url')`
     (47 characters, no padding).
   - `hashKey(key: string): string` → `'sha256:' + createHash('sha256').update(key, 'utf8').digest('hex')`.
   - `verifyKey(key: string, hashes: string[]): boolean`: compute the
     SHA-256 digest of `key` once; for each hash that parses
     (`sha256:` + 64 hex), decode its hex to a 32-byte buffer and compare
     with `crypto.timingSafeEqual`. Return `true` if any matches. Malformed
     hashes are skipped (never throw, never call `timingSafeEqual` on
     unequal lengths). Check every hash rather than returning on the first
     match, so timing doesn't reveal which entry matched.
   - Export the hash pattern (`KEY_HASH_PATTERN`) and use it in
     `validateConfig` so the two never disagree.
7. **`test/core/config.test.ts`**, with one valid two-site, one-viewer
   fixture built in the test (hashes from `hashKey`):
   - The valid config returns a `ResolvedConfig` whose `limits` equal
     `DEFAULT_LIMITS`, `channelOwner` maps each channel to its site, and
     `viewers` is `[]` when omitted.
   - A partial `limits` (`{ historySize: 20 }`) overrides only that field.
   - `channels: '*'` expands to every site channel, sorted.
   - One failing case per rule: duplicate site name, duplicate viewer name,
     bad channel id (`c0123`, `D0123ABC`, `C01-23`), site with no channels,
     channel on two sites, malformed hash (`sha256:abc`, `md5:<64 hex>`,
     uppercase hex), hash shared by a site and a viewer, hash shared by two sites.
   - **Every problem is listed:** one config breaking four rules at once
     throws a single `ConfigError` whose `problems` has four entries and
     whose `message` contains all four.
   - A site and a viewer with the same name is allowed.
   - The input object is unchanged after validation (deep-equal to a copy).
8. **`test/core/keys.test.ts`:**
   - `generateKey()` matches `^prk_[A-Za-z0-9_-]{43}$`; 100 calls give 100
     distinct keys.
   - `hashKey('prk_test')` equals a known vector computed independently in
     the test with `createHash('sha256')`, and matches `KEY_HASH_PATTERN`.
   - `verifyKey(key, [hashKey(key)])` is `true`; a different key is `false`;
     the matching hash second in the list (rotation, Decision 3) is `true`;
     an empty list is `false`; a list with a malformed hash and the right
     hash is `true`; a list with only malformed hashes is `false` and doesn't throw.
   - `timingSafeEqual` is used for the comparison: `keys.ts` imports
     `node:crypto` as a default import (`import crypto from 'node:crypto'`)
     and calls `crypto.timingSafeEqual`, so the test can
     `vi.spyOn(crypto, 'timingSafeEqual')` and assert it was called. (ESM
     named imports can't be spied on.)

## Acceptance Criteria

- [x] `RelayConfig`, `SiteConfig`, `ViewerConfig`, and `RelayLimits` match
      Decision 2 field for field.
- [x] `DEFAULT_LIMITS` holds Decision 2's seven values and is frozen.
- [x] `validateConfig` returns a `ResolvedConfig` with limits merged over the
      defaults, `viewers` defaulted to `[]`, `'*'` expanded, and a
      `channelOwner: Map<string, string>`.
- [x] `validateConfig` enforces every Decision 2 rule (unique names per kind,
      channel id pattern, one site per channel, hash format, one owner per
      hash) plus "at least one channel" per site.
- [x] Several problems in one config produce one `ConfigError` listing all of
      them in `problems` and in `message`.
- [x] `validateConfig` doesn't mutate its input.
- [x] `generateKey` returns `prk_` + 43 base64url characters from 32 random bytes.
- [x] `hashKey` returns `sha256:` + lowercase hex SHA-256 of the key.
- [x] `verifyKey` uses `crypto.timingSafeEqual`, accepts any matching hash in
      the list, skips malformed hashes, and never throws.
- [x] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.

## Files Changed

| File | Action |
|---|---|
| src/core/config.ts | Create |
| src/core/keys.ts | Create |
| test/core/config.test.ts | Create |
| test/core/keys.test.ts | Create |

## Verification

1. `pnpm test test/core/config test/core/keys` passes.
2. `pnpm typecheck` passes.
3. `pnpm build` passes; `dist/core/config.d.ts` and `dist/core/keys.d.ts` exist.
4. Quick manual check after the build:
   `node -e "import('./dist/core/keys.js').then(k=>{const x=k.generateKey();console.log(x,k.hashKey(x),k.verifyKey(x,[k.hashKey(x)]))})"`
   prints a `prk_` key, its `sha256:` hash, and `true`.

## Notes

- **`ResolvedConfig` shape.** The plan defines it only as "RelayConfig +
  limits filled in + channelOwner". This task also defaults `viewers` to
  `[]` and expands `'*'` (step 3), which is the simplest way to give 001-6's
  `Principal.channels: string[]` a concrete list. Per the plan's rule, the
  implementing commit updates the "Interfaces between tasks" section of
  `001-plan.md` with the final `ResolvedConfig` and tells the owners of
  001-5, 001-6, and 001-7.
- **Viewer channels outside every site.** The spec doesn't say whether a
  viewer may list a channel no site owns (Decision 5 only considers "a
  configured channel"). This task only checks the id pattern for viewer
  channels and doesn't require a site owner. Flagged for the spec owner.
- **Limits aren't range-checked.** Decision 2 lists no rule for `limits`
  values, so a bad value (e.g. `historySize: 0`) is accepted.
- **No structural checks** (missing `botToken`, wrong field types). The spec
  lists only the rules above, and TypeScript covers host-built configs. If
  001-11's JSON config loader needs shape checks, it adds them there.
- **Hash hex is lowercase only.** Decision 2 says "64 hex"; `hashKey` emits
  lowercase, so uppercase is rejected as malformed (simplest single form).
- **Zero sites** is accepted; the spec has no rule against it.
- **Implementation notes (filled in while building).** `ResolvedConfig`
  returns copies of `sites`, `viewers` and `slack`, so a caller mutating the
  resolved config can't reach back into the input (and vice versa). A
  duplicated channel inside one site isn't a conflict (de-duplicated before
  the one-site-per-channel check). Malformed hashes are reported once as
  malformed and left out of the shared-hash check. `001-plan.md`'s interface
  section already describes this `ResolvedConfig` (viewers `[]`, `'*'`
  expanded, `channelOwner`), so it was not edited; the exported names
  `ResolvedViewerConfig`, `ConfigError` and `KEY_HASH_PATTERN` are additions
  dependents may import.
