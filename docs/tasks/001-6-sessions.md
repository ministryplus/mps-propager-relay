# Task 001-6: Session hub (handshake, auth, replace, ping/idle, seq + resume)

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Complete
**Parallel group:** Wave 3 (parallel with [001-5](001-5-router.md), [001-7](001-7-outbound.md), [001-9](001-9-socket-mode.md) — disjoint files)
**Depends on:** [001-2](001-2-protocol.md), [001-3](001-3-config-keys.md)
**Blocks:** [001-10](001-10-relay-assembly.md)

## What

Build `src/core/session.ts`: the session hub that owns every client
connection (Spec 001 Decisions 9 and 10). `createSessionHub` implements the
protocol v1 state machine on top of a bare transport
(`{ send(text), close(code, reason) }`): `hello` within `handshakeTimeoutMs`
or `4004`; key verification per role (`4001`); protocol check (`error` then
`4002`); `welcome`; one live connection per site, where a new one replaces
the old with `4003`, and many per viewer; `ping` → `pong`; idle `4005`;
oversized or unparseable frames `4000`. It assigns each site a monotonic
`seq`, buffers routed messages for `resumeWindowMs` / `resumeMaxEvents`
(also while the site is disconnected), and replays them on a matching
`resume`. It sends `status` frames after `welcome` and on every change. It
forwards `reply` / `react` / `post` / `history` to a `RequestHandler` with
the caller's `Principal`, after checking the operation is allowed for the
role, and sends the result back. The hub also implements `Delivery` (from
001-5) so the router can call `toSite` / `toViewers`. All names and
signatures come from the plan's "Interfaces between tasks". It is tested with
fake transports, a fake `RequestHandler`, and `vi` fake timers; nothing is
wired until 001-10.

## Steps

1. **Exports** in `src/core/session.ts`, exactly as the plan:
   `Principal`, `RequestHandler`, and
   `createSessionHub(o: { config: ResolvedConfig; requests: RequestHandler; now(): number; logger: Logger; epoch?: string })`,
   returning `Delivery & { openConnection, setSlackStatus, health, closeAll }`.
   Import `Delivery` as a type from `./router.js` (001-5) or, if 001-5 has
   not landed in your worktree, declare the identical interface locally and
   switch to the import when merging.
2. **Hub state.**
   - `epoch = o.epoch ?? randomBytes(9).toString('base64url')` (Decision 10).
   - `slackStatus = { slack: 'disconnected', slackSharedApp: false }` until
     `setSlackStatus` is called.
   - Per site (one entry per `config.sites`, created up front):
     `{ seq: number (starts 0), buffer: Array<{ seq, at, msg }>, conn: Conn | null, lastSeenMs: number | null }`.
   - A `Set<Conn>` of authenticated viewer connections.
   - Constants come from `config.limits` (`handshakeTimeoutMs`,
     `idleTimeoutMs`, `maxFrameBytes`, `resumeWindowMs`, `resumeMaxEvents`).
3. **`openConnection(t)`** creates a `Conn` in state `awaiting-hello`, starts
   the handshake timer (`setTimeout`, `handshakeTimeoutMs`) → `fail(CLOSE.HANDSHAKE_TIMEOUT, 'no hello')`,
   and returns `{ receive, closed }`.
   - A private `fail(code, message)` sends an `error` frame
     `{ type: 'error', code, message }` (Spec: "sent before a fatal close"),
     then `t.close(code, message)`, clears the connection's timers, and
     marks it closed. Every later `receive` on a closed `Conn` is ignored.
     Use the `CLOSE` constants from `src/protocol/types.ts`.
4. **`receive(text)`**:
   1. If `Buffer.byteLength(text, 'utf8') > maxFrameBytes` →
      `fail(CLOSE.BAD_FRAME, 'frame too large')`.
   2. `parseClientFrame(text)`; on `ProtocolError` →
      `fail(CLOSE.BAD_FRAME, err.message)`.
   3. Reset the idle timer (`idleTimeoutMs` → `fail(CLOSE.IDLE, 'idle')`),
      and for an authenticated site record `lastSeenMs = now()`. Any valid
      frame counts, not only `ping`.
   4. In `awaiting-hello`, anything but `hello` → `fail(CLOSE.BAD_FRAME, 'expected hello')`.
      Once authenticated, a second `hello` → `fail(CLOSE.BAD_FRAME, 'unexpected hello')`.
5. **Handshake** (Decision 9), on `hello`:
   1. `hello.protocol !== 1` → `fail(CLOSE.UNSUPPORTED_PROTOCOL, 'protocol 1 required')`.
   2. Find the principal for `hello.role`: the first of `config.sites` (role
      `site`) or `config.viewers` (role `viewer`) for which
      `verifyKey(hello.key, entry.keyHashes)` is true (task 3, timing-safe).
      None → `fail(CLOSE.UNAUTHORIZED, 'key rejected')`. Log the role and
      client name/version, never the key.
   3. Build the `Principal`: site → `{ role: 'site', name, channels, canPost: false }`;
      viewer → `{ role: 'viewer', name, channels, canPost }`, with `'*'`
      expanded to every channel in `config.channelOwner`.
   4. Clear the handshake timer and start the idle timer.
   5. **Site replace:** if the site already has a live `conn`, call
      `fail(CLOSE.REPLACED, 'replaced by a newer connection')` on the old one
      (log a warning naming the site), then set `conn` to the new one.
      Viewers are added to the viewer set, never replaced.
   6. **Resume** (site only, Decision 10): first prune the site buffer
      (step 7). `resumed` is `true` when `hello.resume` is present,
      `hello.resume.epoch === epoch`, and either the buffer holds
      `resume.seq + 1` or `resume.seq === site.seq` (nothing missed; Notes).
      Otherwise `false`. Viewers always get `resumed: false`.
   7. Send `welcome`: `{ type: 'welcome', protocol: 1, role, name, channels, epoch, resumed, relay: { version } }`
      (`version` per Notes).
   8. Send the current `status` frame.
   9. If `resumed`, send every buffered message with `seq > resume.seq`, in
      order. If not resumed, nothing buffered is sent; only new messages
      follow (the client logs a possible gap).
6. **`toSite(site, msg)`**: increment that site's `seq`, push
   `{ seq, at: now(), msg }`, prune, and if the site has a live
   authenticated `conn`, send `{ type: 'message', seq, ...msg }`. A site with
   no connection still buffers (Decision 10: "messages for a site that is
   disconnected are buffered too"). Unknown site names are logged and ignored.
7. **Buffer pruning:** drop entries with `now() - at > resumeWindowMs`, then
   drop the oldest while the length exceeds `resumeMaxEvents`.
8. **`toViewers(msg)`**: send to every authenticated viewer connection whose
   `Principal.channels` includes `msg.channel`. Each viewer connection keeps
   its own counter for the frame's `seq` field, starting at 1 (Notes).
9. **`ping`** → send `{ type: 'pong' }`.
10. **Requests.** For `reply` / `react` (allowed for sites) and `post` /
    `history` (allowed for viewers):
    - Wrong role → send `{ type: 'result', id, ok: false, error: 'not_allowed' }`
      without calling the handler. Channel and `canPost` checks belong to the
      handler (001-7 / 001-10), not the hub.
    - Otherwise call `o.requests(principal, frame)`. When it resolves, send
      the returned frame if the connection is still open (a result for a
      closed or replaced connection is dropped with a debug log). If it
      rejects, log the error and send `{ type: 'result', id, ok: false, error: 'invalid' }`
      (Notes). Requests run concurrently; ordering is the handler's job.
11. **`closed()`** (transport closed by the peer or by `fail`): clear the
    `Conn`'s timers, remove a viewer from the set, and for a site clear
    `conn` only if it is still this `Conn` (a replaced connection closing
    late must not disconnect its successor). The buffer is kept.
12. **`setSlackStatus(s)`**: if either field differs from the current value,
    store it and send `{ type: 'status', ...s }` to every authenticated
    connection. Same value → nothing sent.
13. **`health()`**: `{ sites: config.sites.map(s => ({ name, connected, lastSeenMs })), viewers: <authenticated viewer connection count> }`.
14. **`closeAll(code, reason)`**: close every connection, including ones
    still in handshake, with `t.close(code, reason)` (no `error` frame for
    `1001`), clear all timers, and mark them closed. Buffers stay.
15. **Fake transport** in `test/fakes/fake-transport.ts`:
    `createFakeTransport()` returning `{ transport, sent: unknown[] (parsed frames), closedWith: { code, reason } | null }`.
    001-10 reuses it.
16. **Tests** in `test/core/session.test.ts` with `vi.useFakeTimers()` and
    `now: () => Date.now()` (fake timers mock `Date`). Config via
    `validateConfig`: sites `north` (`C0NORTH`) and `south` (`C0SOUTH`), a
    viewer `portal` on `'*'` with `canPost: true`, a viewer `wall` on
    `['C0NORTH']`; keys from `generateKey`/`hashKey`. Fake `RequestHandler`:
    records `(principal, frame)` and resolves (or rejects / defers) as the
    test scripts. Cases under Verification.

## Acceptance Criteria

- [x] `createSessionHub`, `Principal`, and `RequestHandler` match the plan's
      signatures exactly, and the hub satisfies `Delivery`.
- [x] No `hello` within `handshakeTimeoutMs` → `4004`; a first frame other
      than `hello`, a second `hello`, a frame over `maxFrameBytes`, or an
      unparseable frame → `4000`.
- [x] A key matching no hash for the requested role → `4001` (a site key
      used with `role: 'viewer'` is rejected); `protocol !== 1` → `error`
      frame, then `4002`. Every relay-initiated `4xxx` close is preceded by
      an `error` frame.
- [x] `welcome` carries `protocol`, `role`, `name`, `channels` (viewer `'*'`
      expanded), `epoch`, `resumed`, `relay.version`, and is followed by a
      `status` frame.
- [x] A second site connection with the same key closes the first with
      `4003` and receives the site's messages from then on; the late
      `closed()` of the old one doesn't disconnect the new one. Several
      viewer connections coexist.
- [x] `ping` → `pong`; no frame for `idleTimeoutMs` → `4005`, and any frame
      resets the timer.
- [x] Each site's messages carry a monotonic `seq`; messages routed while the
      site is disconnected are buffered for `resumeWindowMs`, at most
      `resumeMaxEvents`.
- [x] `resume` with the current epoch and a `seq` whose successor is buffered
      replays every later message and answers `resumed: true`; a wrong
      epoch, an expired or evicted `seq + 1`, or no `resume` answers
      `resumed: false` and replays nothing.
- [x] Viewers get only messages in their channels; sites get only what
      `toSite` sends them.
- [x] `reply`/`react` from a viewer and `post`/`history` from a site get a
      `not_allowed` `result` and never reach the `RequestHandler`; allowed
      requests reach it with the right `Principal`, and its result is sent
      back on the same connection.
- [x] `setSlackStatus` sends a `status` frame to every authenticated
      connection only when the value changes.
- [x] `health()` reports each site's `connected` and `lastSeenMs` and the
      viewer count; `closeAll(1001, …)` closes every connection.
- [x] `src/core/session.ts` imports no HTTP or WebSocket library.
- [x] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.

## Files Changed

| File | Action |
|---|---|
| src/core/session.ts | Create |
| test/fakes/fake-transport.ts | Create |
| test/core/session.test.ts | Create |

## Verification

```
pnpm test test/core/session.test.ts
pnpm typecheck && pnpm build && pnpm test
grep -nE "from '(h3|crossws|ws|node:http)'" src/core/session.ts   # no output
```

`session.test.ts` covers:

1. **Handshake timeout:** open, advance `handshakeTimeoutMs` → `error` then
   close `4004`. A `hello` just before the deadline → `welcome`, no close.
2. **Bad frames:** `"not json"` → `4000`; first frame `ping` → `4000`; a
   frame of `maxFrameBytes + 1` bytes → `4000`; a second `hello` → `4000`.
3. **Auth:** wrong key → `4001`; `north`'s key with `role: 'viewer'` →
   `4001`; `protocol: 2` → `error` frame then `4002`.
4. **Welcome:** site `north` → `welcome` (`name: 'north'`,
   `channels: ['C0NORTH']`, the injected `epoch`, `resumed: false`,
   `relay.version` set) then `status` (`disconnected`, `false`). Viewer
   `portal` → `channels` lists both site channels.
5. **Replace:** connect `north` twice → the first gets `4003`; `toSite('north', m)`
   reaches only the second; calling the first's `closed()` afterward leaves
   `health()` showing `north` connected. Two `portal` connections both get
   `toViewers` messages.
6. **Ping / idle:** `ping` → `pong`. With a `ping` every 30 s for 5 min, no
   close; then silence for `idleTimeoutMs` → `4005`.
7. **Seq and delivery:** three `toSite('north', …)` → `message` frames with
   `seq` 1, 2, 3 and every `RelayMessage` field; `south` receives none.
   `toViewers` for a `C0SOUTH` message reaches `portal` but not `wall`.
8. **Resume:** connected `north` receives seq 1–2, disconnects;
   `toSite` twice more; reconnect with `resume: { epoch, seq: 2 }` →
   `resumed: true`, then seq 3 and 4 in order after `status`. Reconnect with
   `seq` equal to the latest → `resumed: true`, nothing replayed.
9. **Resume misses:** wrong epoch → `resumed: false`, nothing replayed;
   disconnect, `toSite`, advance `resumeWindowMs + 1` → `resumed: false`;
   `resumeMaxEvents + 5` messages while disconnected, resume from the first
   → `resumed: false`; a later `toSite` still arrives with the next `seq`.
10. **Requests:** `north` sends `reply` → handler called with
    `{ role: 'site', name: 'north', channels: ['C0NORTH'], canPost: false }`
    and the frame; its `result` comes back with the same `id`. `portal`
    sends `history` → its `history_result` comes back. `portal` sends
    `reply` and `north` sends `post` / `history` → `not_allowed` results,
    handler not called. A rejecting handler → one `result` with
    `ok: false`. A deferred result resolving after the connection closed →
    nothing sent, no throw.
11. **Status:** `setSlackStatus({ slack: 'connected', slackSharedApp: false })`
    → one `status` frame to each authenticated connection, none to a
    connection still in handshake; the same value again → nothing.
12. **Health and closeAll:** `health()` before and after connects
    (`lastSeenMs` equals `now()` at the last frame, `null` for a site never
    seen); `closeAll(1001, 'shutting down')` closes every fake transport with
    `1001`.

## Notes

- **Resume when nothing was missed.** Decision 10 resumes when "the buffer
  still holds `seq + 1`". A client that saw everything (`seq` equals the
  site's latest) has no `seq + 1` yet, which read literally would answer
  `resumed: false` and log a false gap. This task treats that case as
  `resumed: true` with nothing replayed.
- **`relay.version` in `welcome`** isn't in the plan's hub options. Read it
  from `package.json` with `createRequire(import.meta.url)('../../package.json').version`
  (the path is the same from `src/core` and `dist/core`, and `package.json`
  always ships). If 001-1 already exports a version constant, use that.
- **`error` frame `code`.** The spec sends `error` "before a fatal close" but
  doesn't define `code`. Use the close code (001-2 declares
  `ErrorFrame.code: number`). 001-2's parser accepts `hello` with any integer
  `protocol ≥ 1`, which is what lets the hub answer `4002` instead of `4000`.
- **Check order:** protocol before key, because a hello for another protocol
  may not be laid out the way protocol 1 expects.
- **Viewer `seq`.** `message` frames always carry `seq` (Decision 9), but
  viewers don't resume. Each viewer connection numbers its own frames from 1.
- **Handler rejection.** `RequestHandler` should resolve every request
  (001-7 maps all failures), but "every request gets exactly one `result`"
  (Decision 7), so a rejection still produces one. The spec's error list has
  no internal-error code; `invalid` is the closest. Revisit if 001-7 defines
  one.
- **`lastSeenMs`** is the `now()` timestamp of the last frame received from
  the site's live connection, kept after it disconnects, `null` if never
  connected. The plan doesn't define its meaning; 001-10 passes it through to
  `HealthReport`.
- **Implementation notes (001-6).** `Delivery` is declared locally in
  `session.ts` with a `TODO(001-5)` because `router.ts` had not landed in
  this worktree; switch to `import type { Delivery } from './router.js'` when
  merging. `fail()` releases the connection the same way `closed()` does
  (timers, viewer set, site slot if still held), so an idle or bad-frame
  close shows the site disconnected in `health()` without waiting for the
  transport's `closed()`. The `hello` itself sets the site's `lastSeenMs`.
  A rejected key is logged at `warn` with the role and client name/version.
