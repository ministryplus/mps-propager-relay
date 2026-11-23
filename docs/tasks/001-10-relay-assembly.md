# Task 001-10: Relay assembly (createRelay, history, in-process viewers, core exports)

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Pending
**Parallel group:** Wave 4 (solo — wires every core module and owns `src/core/index.ts`)
**Depends on:** [001-5](001-5-router.md), [001-6](001-6-sessions.md), [001-7](001-7-outbound.md), [001-8](001-8-events-api.md), [001-9](001-9-socket-mode.md)
**Blocks:** [001-11](001-11-h3-standalone.md)

## What

Assemble the core into `createRelay` (Spec 001 Decision 12). After wave 3
each module passes its own tests against fakes, but nothing connects them.
This task adds the per-channel history ring with its startup backfill
(Decision 11), then `createRelay`, which validates the config, learns the
bot's identity with `auth.test` (Decision 6), and wires the modules exactly
as the plan's last Interfaces paragraph says: ingress → `router.ingest`;
`router` → `hub` (as `Delivery`); `hub` requests → `outbound.request`, or
the history ring for `history` frames; `outbound.onRelayPost` →
`router.route`. It implements the `Relay` interface: `start`/`stop`,
`handleSlackEvent` (Events API mode only), `openConnection`, the
in-process `viewer()` API, and `health()`, with the Slack status semantics
from the Decision 12 note. It fills in the public exports in
`src/core/index.ts`, keeping `@slack/types` out of the emitted `.d.ts`, and
adds an in-process integration test that runs the whole flow with
`FakeSlackApi` and fake transports, the "After 001-10" checkpoint in the
plan.

## Steps

1. **History ring.** Create `src/core/history.ts`:

   ```ts
   export function createHistory(o: { config: ResolvedConfig; slackApi: SlackApi; logger: Logger;
     toMessage(channel: string, m: SlackHistoryMessage): RelayMessage | null;
     timing?: { backoffBaseMs: number; backoffMaxMs: number } }): {
       add(msg: RelayMessage): void;
       get(channel: string, limit?: number): RelayMessage[];   // oldest first
       backfill(): Promise<void>;   // one attempt per channel; failures retry in the background
       stop(): void;
     };
   ```

   - One ring per channel in `config.channelOwner`, capacity
     `limits.historySize`. `add` ignores channels with no ring, ignores a
     message whose `ts` is already in that ring (backfill and live
     messages can overlap), keeps the ring sorted by `ts`, and drops the oldest past
     capacity. `fromSelf` messages are kept.
   - `get(channel, limit)` returns a copy, oldest first, of the last
     `min(limit ?? historySize, historySize)` messages, or `[]` for an
     unknown channel.
   - `backfill()` calls `slackApi.history({ channel, limit: historySize })`
     for every channel in parallel (001-4 returns Slack's newest-first
     order; the `ts` sort handles it), converts each result with `toMessage`
     (dropping `null`s), and merges it with `add` (live messages that
     arrived first are kept, duplicates by `ts` are skipped). A failed
     channel is logged at `warn` with the channel id and error code and
     retried on its own with backoff (base 1 s doubling to 60 s, reusing
     `nextBackoffMs` from 001-9) until it succeeds or `stop()` is called.
     The returned promise resolves after the first attempt for every channel
     and never rejects.
2. **Backfill conversion.** In `relay.ts`, `toMessage(channel, m)` calls
   001-5's `normalize({ eventId: 'history:' + channel + ':' + m.ts, event:
   { ...m, type: 'message', channel } }, botIdentity)`, so the subtype filter,
   the thread rule, and `fromSelf` come from one place. Backfill runs after
   `auth.test` succeeds (step 4), so `botIdentity` is known.
3. **Wiring** in `src/core/relay.ts`, inside `createRelay({ config, logger =
   consoleLogger, slackApi, now = Date.now })`:
   - `const resolved = validateConfig(config)` (throws `ConfigError` before
     anything starts).
   - `slackApi ??= createSlackApi({ botToken: config.slack.botToken })`
     (001-4).
   - `history = createHistory(...)`.
   - `hub = createSessionHub({ config: resolved, requests, now, logger })`.
   - `delivery: Delivery = { toSite: (s, m) => hub.toSite(s, m), toViewers: (m)
     => { history.add(m); hub.toViewers(m); inProcess.deliver(m); } }`.
     History taps `toViewers` because it must hold every routed message in
     a channel, including `fromSelf`. 001-5 calls `toViewers` for every
     accepted message, stale or not, except `origin: 'relay'` copies
     (viewers get Slack's echo instead).
   - The ring is keyed by `channel` + `ts`: `history.add` replaces an entry
     with the same `ts` instead of appending, so a post is never listed twice.
   - `router = createRouter({ config: resolved, delivery, now, logger })`.
   - `outbound = createOutbound({ slackApi, config: resolved, logger,
     onRelayPost: (m) => { history.add(m); router.route(m); } })`. A
     viewer's post is in history at once, even if Slack never echoes it; the
     echo (same `ts`, `fromSelf: true`) replaces that entry.
   - `requests: RequestHandler = (p, f) => f.type === 'history' ?
     Promise.resolve(historyResult(p, f)) : outbound.request(p, f)`.
     `historyResult` returns `{ type: 'history_result', id: f.id, channel:
     f.channel, messages }`, where `messages` is `history.get(f.channel,
     f.limit)` if `p.role === 'viewer'` and `p.channels` includes the
     channel, else `[]` (logged at `debug`; see Notes).
   - Ingress: for `mode: 'events-api'`, `createEventsApiIngress({
     signingSecret, sink: router.ingest, now, logger })` from 001-8. For
     `mode: 'socket-mode'`, `createSocketMode({ appToken, slackApi, sink:
     router.ingest, logger, onStatus })` from 001-9, where `onStatus(s)`
     stores the status and calls `hub.setSlackStatus(s)`.
4. **`start()`** (Decision 12): runs once (a second call returns the same
   promise).
   - `auth.test`: on success, `router.setBotIdentity(...)`, log the ids, and
     for `events-api` set the status to `{ slack: 'connected',
     slackSharedApp: false }` via `hub.setSlackStatus`. On failure, log at
     `error` and retry in the background with backoff (1 s doubling to 60 s)
     until it succeeds or `stop()` runs. Until then the router's
     no-identity fallback drops every `bot_id` message for sites
     (Decision 6).
   - After `auth.test` succeeds, `history.backfill()`.
   - For `socket-mode`, `socketMode.start()` in parallel with the above.
   - `start()` resolves after the first `auth.test` attempt, the first
     backfill attempt (if `auth.test` succeeded), and `socketMode.start()`.
     It doesn't reject for a Slack failure; retries carry on in the
     background and are logged.
5. **Slack status** (Decision 12 note): `events-api` → `connected` once
   `auth.test` has succeeded, `slackSharedApp` always `false`;
   `socket-mode` → exactly what 001-9's `onStatus` reports. Before either,
   `{ slack: 'disconnected', slackSharedApp: false }`. Set it on the hub
   at construction so the first `status` frame after `welcome` is right.
6. **`handleSlackEvent(rawBody, headers)`:** in `events-api` mode, return
   `eventsApi.handle(rawBody, headers)` (001-8) unchanged. In
   `socket-mode`, return `{ status: 404 }` and log at `debug` (see Notes).
7. **`openConnection(transport)`:** `hub.openConnection(transport)`.
8. **In-process viewers** (`viewer(opts, listener)`, Decision 11):
   - Look up `opts.name` in `config.viewers`; unknown → throw an `Error`
     naming it. Expand `'*'` to every channel in `resolved.channelOwner`.
   - `opts.channels`, if given, must be a subset of the configured viewer's
     channels; otherwise throw, naming the extra channels. If absent, use
     all of the configured viewer's channels.
   - Register `{ channels: Set, listener }` in `inProcess`; `deliver(m)`
     calls each listener whose set holds `m.channel`, inside `try/catch` (a
     throwing listener is logged and doesn't affect others). No key is
     checked: the host has already authorized its user.
   - Return `ViewerHandle`: `history(channel, limit?)` →
     `history.get(...)` for a subscribed channel, else `[]`;
     `post(channel, text, threadTs?)` → `outbound.request(principal, { type:
     'post', id: 'inproc:' + n, channel, text, threadTs })` mapped to `{ ok,
     ts?, error? }`, where `principal = { role: 'viewer', name, channels,
     canPost }` so 001-7's `not_allowed` rules apply unchanged; `close()`
     unregisters (idempotent).
9. **`health()`:** `{ slack, slackSharedApp, ingress: config.slack.ingress.mode,
   sites: hub.health().sites, viewers: hub.health().viewers +
   inProcess.size }` (`HealthReport`, Decision 12).
10. **`stop()`:** idempotent. Cancel the `auth.test` retry, `history.stop()`,
    `await socketMode?.stop()`, then `hub.closeAll(CLOSE.GOING_AWAY, 'relay
    shutting down')`. In-process viewers stay registered but receive nothing
    more.
11. **Public exports.** Fill in `src/core/index.ts`:
    - values: `createRelay`, `validateConfig`, `DEFAULT_LIMITS`,
      `ConfigError`, `generateKey`, `hashKey`, `verifyKey`;
    - types: `Relay`, `ViewerHandle`, `HealthReport`, `RelayMessage`,
      `RelayConfig`, `SiteConfig`, `ViewerConfig`, `RelayLimits`,
      `SlackApi`, `SlackHistoryMessage`, `Logger`.
    `SlackApi` is public because `createRelay` takes it as a test seam, so
    `SlackHistoryMessage` must stay the relay-owned type 001-4 defines, not
    an `@slack/types` alias. Every other `@slack/types` use stays
    `import type` in non-exported positions; the `grep` under Verification
    checks it.
12. **Integration test** `test/core/relay.test.ts`: `createRelay` with a
    two-site, one-viewer config, `FakeSlackApi`, an injected `now`, and
    fake transports (`test/fakes/fake-transport.ts`, from 001-6). Sign
    Events API bodies with the test signing secret the same way 001-8's
    tests do. Cases under Verification.

## Acceptance Criteria

- [ ] `createRelay` throws `ConfigError` for an invalid config before any
      Slack call.
- [ ] `start()` calls `auth.test` once, passes the ids to
      `router.setBotIdentity`, retries with backoff on failure, and never
      rejects for a Slack failure.
- [ ] History holds the last `historySize` messages per channel, including
      `fromSelf`, oldest first; backfill fills it from
      `SlackApi.history` after `auth.test`, retries a failed channel with
      backoff, and logs the failure.
- [ ] `history` frames and `view.history` return at most `historySize`
      messages, oldest first, and only for the viewer's channels.
- [ ] The wiring matches the plan: ingress → `router.ingest`, router → hub
      as `Delivery`, hub requests → outbound or history, `onRelayPost` →
      `router.route`.
- [ ] Slack status follows the Decision 12 note in both modes, reaches the
      hub, and appears in `health()`.
- [ ] `handleSlackEvent` is handled by the Events API ingress in
      `events-api` mode and answers 404 in `socket-mode`.
- [ ] `relay.viewer()` uses `config.viewers` for channels and `canPost`,
      takes no key, delivers every message in its channels (including
      `fromSelf`), and its `post` follows the same rules as a `post` frame.
- [ ] `stop()` closes every connection with `1001`, stops Socket Mode and
      all retries, and is safe to call twice.
- [ ] `src/core/index.ts` exports the values and types in step 11, and no
      file under `dist/` that ends in `.d.ts` mentions `@slack/types`.
- [ ] The integration test passes; `pnpm test`, `pnpm typecheck`, and
      `pnpm build` pass.

## Files Changed

| File | Action |
|---|---|
| src/core/history.ts | Create |
| src/core/relay.ts | Create |
| src/core/index.ts | Modify |
| test/core/history.test.ts | Create |
| test/core/relay.test.ts | Create |

## Verification

```
pnpm exec vitest run test/core/history.test.ts test/core/relay.test.ts
pnpm test && pnpm typecheck && pnpm build
grep -rl "@slack/types" dist --include='*.d.ts'   # prints nothing
```

`history.test.ts` covers: capacity and oldest-first order; `limit` clamped
to `historySize`; duplicate `ts` ignored; unknown channel → `[]`; backfill
merges with live messages; a channel whose `history` call fails is logged,
retried after the backoff (fake timers), and filled when it succeeds; `stop()`
cancels retries.

`relay.test.ts` covers:

1. **Invalid config:** two sites on one channel → `createRelay` throws
   `ConfigError`, and `FakeSlackApi` saw no call.
2. **Page round trip (events-api):** after `start()`, connect site A's fake
   transport with a valid `hello` → `welcome` and a `status` frame with
   `slack: 'connected'`. `handleSlackEvent` with a signed `event_callback`
   for `1234` in A's channel → 200, then a `message` frame (`kind:
   'channel'`, `seq: 1`) on A's transport and nothing on B's. A `reply`
   frame → `FakeSlackApi` records `postMessage` with that `threadTs` → a
   `result` frame `{ ok: true, ts }`.
3. **Echo filter:** a signed event from the bot's own `user` → no frame to
   A; the remote viewer gets it with `fromSelf: true`, and it is in
   history.
4. **Viewer post pages the site:** `relay.viewer({ name: 'portal' }, spy)`;
   `await view.post(A's channel, '5678')` → `{ ok: true, ts }`; A gets a
   `message` frame with `origin: 'relay'` and `eventId: 'relay:<ts>'`. A
   later signed echo event with that `ts` and the bot's `bot_id` does not
   reach A; the in-process viewer's listener got only the echo
   (`fromSelf: true`), and history holds one entry for that `ts`.
5. **Viewer rules:** a viewer configured with `canPost: false` gets `{ ok:
   false, error: 'not_allowed' }` and `FakeSlackApi` records nothing;
   `relay.viewer({ name: 'nope' })` throws; `channels` outside the configured
   set throws; `view.history` returns oldest first and respects `limit`.
6. **History frame:** a remote viewer's `history` frame gets a
   `history_result` with the backfilled messages (from `FakeSlackApi`'s
   scripted history) plus live ones, oldest first.
7. **Resume across a fake reconnect:** A's transport closes; two signed
   events arrive; a new transport sends `hello` with `resume: { epoch,
   seq: 1 }` → `welcome` with `resumed: true`, then both messages with
   `seq` 2 and 3.
8. **auth.test retry:** `FakeSlackApi.authTest` fails once → status stays
   `disconnected` and a `bot_id` message doesn't reach A; after the retry
   succeeds, status becomes `connected` on A's transport and backfill runs.
9. **Socket Mode mode:** with `mode: 'socket-mode'` and a stubbed
   `createSocketMode` (or 001-9's fake server), `handleSlackEvent` → 404;
   an `onStatus({ slack: 'connected', slackSharedApp: true })` reaches A as
   a `status` frame and `health()` shows `slackSharedApp: true`.
10. **Health and stop:** `health()` lists both sites with `connected` and
    `lastSeenMs`, the viewer count includes in-process viewers, and
    `ingress` is the mode. `stop()` → every fake transport closed with
    `1001`; a second `stop()` is a no-op.

## Notes

- **Router contract relied on:** history taps `Delivery.toViewers`, which
  works because 001-5 calls it for every accepted message regardless of
  subscribers. A viewer post is also recorded from `onRelayPost`, and the
  ring's `channel` + `ts` key keeps it to one entry once the echo arrives,
  so history holds the post even if Slack never echoes it. Live viewers
  still see only the echo (001-5's choice); a dropped echo means a live
  viewer misses it until it reloads history.
- **`history` errors:** `history_result` has no `error` field (Decision 9),
  so a `history` frame for a channel the viewer doesn't subscribe to, or one
  from a site, gets `messages: []`. A `limit` above `historySize` is
  clamped rather than rejected with `4000`, since the parser can't know
  `historySize`.
- **`handleSlackEvent` in Socket Mode:** the spec doesn't say; 404 is the
  simplest answer that tells a misconfigured Slack Request URL "not here".
- **Retry schedules:** the spec says `auth.test` and backfill are "retried
  with backoff" without numbers; this task reuses Decision 4's 1 s doubling
  to 60 s and retries until success or `stop()`.
- **Backfill sees only top-level messages** (and thread broadcasts):
  `conversations.history` doesn't return thread replies. That matches "the
  latest message on load" in ADR 001 Decision 6.
- **In-process `post` with `threadTs`:** Decision 11's example shows `post(channel,
  text)`; the optional third argument mirrors the `post` frame's `threadTs?`.
