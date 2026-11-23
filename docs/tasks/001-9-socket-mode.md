# Task 001-9: Socket Mode ingress (ack, hello warning, handoff, liveness)

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Complete
**Parallel group:** Wave 3 (parallel with [001-5](001-5-router.md), [001-6](001-6-sessions.md), [001-7](001-7-outbound.md) — disjoint files)
**Depends on:** [001-4](001-4-slack-api.md)
**Blocks:** [001-10](001-10-relay-assembly.md)

## What

Add the Socket Mode ingress (Spec 001 Decision 4, Socket Mode half): a
client over `ws` that gets a `wss://` URL from `SlackApi.openSocketModeUrl`,
acks every envelope on the socket it arrived on before processing it, and
hands each `events_api` envelope's `event_id` and inner `event` to a
`SlackEventSink`. It ports the handoff and liveness logic that ProPager's
`SlackClient` already runs in production (`src/slackclient.cpp`:
`beginGracefulReconnect`, `promotePending`, `onSocketFrame`,
`onSocketDisconnected`; `src/connectionwatchdog.cpp`): on `disconnect` it
opens a replacement first, switches on the replacement's `hello`, then
closes the old socket; it pings every 10 s and reconnects after 30 s with no
frame or pong; it backs off 1 s doubling to 60 s and resets on `hello`. On
every `hello` it compares `num_connections` with its own live sockets and
reports a shared app (another client taking some of the events) through a
status callback whose shape matches `hub.setSlackStatus`, so 001-10 passes it
straight through. It is tested against a local `ws` server that stands in
for Slack. Nothing is wired into a relay yet (001-10).

## Steps

1. **Interface.** Create `src/core/ingress/socket-mode.ts` exporting:

   ```ts
   export interface SlackStatus { slack: 'connected' | 'disconnected'; slackSharedApp: boolean }
   export interface SocketModeTiming {     // test seam; defaults below
     pingIntervalMs: number;   // 10_000
     staleAfterMs: number;     // 30_000
     backoffBaseMs: number;    // 1_000
     backoffMaxMs: number;     // 60_000
   }
   export function createSocketMode(o: {
     appToken: string; slackApi: SlackApi; sink: SlackEventSink; logger: Logger;
     onStatus(s: SlackStatus): void; timing?: Partial<SocketModeTiming>;
   }): { start(): Promise<void>; stop(): Promise<void>; status(): SlackStatus };
   export function nextBackoffMs(currentMs: number, baseMs: number, maxMs: number): number;
   ```

   Import `SlackEventSink` from `src/core/ingress/events-api.ts`, where
   001-8 declares it exactly as the plan's Interfaces section, which also
   lists this `createSocketMode` signature (001-10 codes against it).
2. **Backoff helper.** `nextBackoffMs(0, base, max)` returns `base`; after
   that it doubles, capped at `max` (1, 2, 4, …, 32, 60, 60 s with the
   defaults). Port of ProPager's `nextBackoffMs`, with the cap raised from
   30 s to the spec's 60 s.
3. **Watchdog.** A small internal `createWatchdog({ pingIntervalMs,
   staleAfterMs, ping(), expire(reason) })` with `noteActivity()` and
   `stop()`, one per socket, armed when the socket is created. Every
   `pingIntervalMs` it checks the time since the last activity: at or past
   `staleAfterMs` it stops and calls `expire`; otherwise it calls `ping`
   (which sends a WebSocket ping only if the socket is open). Use
   `setInterval` and `Date.now()` so `vi.useFakeTimers()` drives it. Because
   it is armed at creation, a socket that opens but never says `hello`, or a
   TCP/TLS handshake that hangs, also expires after 30 s (see Notes).
4. **Socket state.** Keep `active: Socket | null`, `pending: Socket | null`,
   `opening: boolean` (an `openSocketModeUrl` call in flight), `backoffMs`,
   a reconnect timer, `stopped`, and the current `SlackStatus`. Each socket
   record holds its `ws` instance, its watchdog, and whether it has had its
   `hello`. Every handler checks which record fired (active, pending, or
   retired), as ProPager does, because two sockets are live during a
   handoff.
5. **Connect.** `requestConnection(graceful)`: set `opening`, call
   `slackApi.openSocketModeUrl(appToken)`, then `new WebSocket(url)`.
   - Non-graceful failure (the call rejects or the socket errors before
     opening): log it, schedule a reconnect with backoff.
   - Graceful failure: log "replacement handshake failed; keeping current
     connection" and do nothing else. Slack will force-close the old socket
     later, and that close drives the ordinary reconnect (ProPager's rule
     against reconnect storms).
   - Graceful success stores the socket in `pending`; otherwise in `active`.
   `start()` calls `requestConnection(false)` and resolves once that first
   attempt has opened a socket or scheduled a retry. It never rejects for a
   Slack failure.
6. **Frames** (`message` event on a socket):
   - Note activity on that socket's watchdog. Parse the JSON; on a parse
     error log at `warn` and return.
   - **Ack first:** if the envelope has an `envelope_id`, send
     `{"envelope_id": "<id>"}` on **the same socket** before anything else.
   - `type: "hello"`: mark the socket hello'd, reset `backoffMs` to 0, log
     `debug_info.approximate_connection_time` if present. Count own live
     sockets (active and pending records whose `ws` is open, including this
     one). If `num_connections` is greater, log a warning (name the counts
     and say another client on this app is taking some of the events) and set
     `slackSharedApp = true`; otherwise set it `false`. If the socket is
     `pending`, promote it (step 7). If it is `active`, set `slack =
     'connected'`. Call `onStatus` only when either field changed.
   - `type: "disconnect"`: only when the frame came from `active`, and no
     `pending` socket or `opening` call exists, call `requestConnection(true)`.
     Slack sends two (`warning`, then `refresh_requested`), so this guard
     opens exactly one replacement. Log the `reason`.
   - `type: "events_api"`: read `payload.event_id` and `payload.event`; if
     either is missing, log at `warn` and skip. Otherwise call
     `sink({ eventId, event })` inside `try/catch` (a throwing sink is logged
     and never breaks the socket).
   - Anything else (already acked): log at `debug` and ignore.
7. **Promote.** `promotePending()`: `old = active; active = pending; pending =
   null;` then retire `old` (stop its watchdog, detach its handlers so its
   close can't trigger a reconnect, close it with `1000`). No status change:
   the relay stayed connected throughout (make-before-break).
8. **Socket closed or expired.** On `close` (or watchdog expiry, which
   `terminate()`s the socket first and then runs the same path):
   - `pending` died: clear it. If there is no `active`, set `slack =
     'disconnected'` (notify) and schedule a reconnect.
   - `active` died: clear it. If a `pending` socket exists, let it promote on
     its `hello` and don't touch status. Otherwise set `slack =
     'disconnected'` (notify) and schedule a reconnect.
   - A retired socket: ignore.
   `scheduleReconnect()` advances `backoffMs` with `nextBackoffMs`, logs the
   delay, and sets the timer to `requestConnection(false)`. It does nothing
   once `stopped`.
9. **Stop.** `stop()` sets `stopped`, clears the reconnect timer, stops every
   watchdog, detaches handlers, and closes `active` and `pending` with
   `1000`. It resolves when both are closed (or immediately if none) and does
   not call `onStatus`; the relay is shutting down.
10. **Fake server.** Create `test/fakes/fake-socket-mode-server.ts`: a `ws`
    `WebSocketServer` on `127.0.0.1` port 0, with:
    - `url()` → `ws://127.0.0.1:<port>/` (each connection recorded in
      order);
    - options `autoHello` (default `true`, sending `{type:"hello",
      num_connections: <n>}` on connect, where `n` defaults to the server's
      open connection count and can be overridden) and `autoPong` (default
      `true`; `false` passes `autoPong: false` to the `ws` server so pings go
      unanswered, see Notes);
    - `connections: FakeConn[]` and `nextConnection(): Promise<FakeConn>`;
    - per `FakeConn`: `sendHello(numConnections?)`, `sendDisconnect(reason)`,
      `sendEvent({ eventId, event })` → the generated `envelope_id`,
      `sendRaw(obj)`, `acks: string[]`, `pings: number`, `waitForAck(id)`,
      `close(code?)`, `closed: Promise<{ code: number }>`;
    - `stop()`.
    Tests pass a `SlackApi` whose `openSocketModeUrl` returns `server.url()`
    (001-4's `FakeSlackApi` returns a placeholder URL, so override that one
    method; a call counter and a scriptable rejection live in the test).
11. **Tests** in `test/core/ingress/socket-mode.test.ts` (cases under
    Verification). Pure units (`nextBackoffMs`, the watchdog) use
    `vi.useFakeTimers()`. Socket tests use real timers and a shortened
    `timing` (for example ping 40 ms, stale 120 ms, backoff 20 → 160 ms),
    because fake timers stall `ws` I/O; keep each test well under a second.

## Acceptance Criteria

- [x] `createSocketMode` gets its URL only through
      `SlackApi.openSocketModeUrl(appToken)` and connects with `ws`.
- [x] Every envelope with an `envelope_id` is acked with `{"envelope_id"}`
      on the socket it arrived on, before the sink runs; a throwing sink
      doesn't prevent the ack or break the socket.
- [x] `events_api` envelopes reach the sink as `{ eventId, event }`; other
      envelope types are acked and ignored.
- [x] On `hello`, `num_connections` greater than the client's own open
      sockets logs a warning and reports `slackSharedApp: true`; a later
      `hello` without the excess reports `false`. During a handoff the two
      own sockets don't count as a shared app.
- [x] `onStatus` reports `connected` after the first `hello`, `disconnected`
      only when no socket is left serving, and nothing during a graceful
      handoff; it fires only on changes.
- [x] A `disconnect` from the active socket opens exactly one replacement;
      the old socket closes only after the replacement's `hello`; a failed
      replacement leaves the active socket serving.
- [x] A ping goes out every `pingIntervalMs`; `staleAfterMs` with no frame
      or pong (or no `hello` after connecting) drops the socket and
      reconnects.
- [x] Reconnect delays are 1 s doubling to 60 s and reset after a `hello`.
- [x] After `stop()`, no socket is open and no reconnect is attempted.
- [x] The signature is recorded in the plan's Interfaces section. (Already
      there and matched exactly, so the plan was not edited; `SocketModeTiming`,
      `nextBackoffMs`, and `createWatchdog` are extra exports not listed there.)
- [x] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.

## Files Changed

| File | Action |
|---|---|
| src/core/ingress/socket-mode.ts | Create |
| test/fakes/fake-socket-mode-server.ts | Create |
| test/core/ingress/socket-mode.test.ts | Create |
| docs/tasks/001-plan.md | Modify (Interfaces section only) |

## Verification

```
pnpm exec vitest run test/core/ingress/socket-mode.test.ts && pnpm test && pnpm typecheck && pnpm build
```

`socket-mode.test.ts` covers:

1. **Backoff:** `nextBackoffMs` from 0 gives 1000,
   2000, 4000, …, 32000, 60000, 60000.
2. **Watchdog (fake timers):** pings at 10 s and 20 s while activity is
   noted; with no activity, `expire` fires at the first check at or past
   30 s and no ping follows; `stop()` silences it.
3. **Connect and hello:** `openSocketModeUrl` is called once with the app
   token; no `connected` status before `hello`; after `hello`
   (`num_connections: 1`) `onStatus({ slack: 'connected', slackSharedApp:
   false })` fires once.
4. **Ack and sink:** `sendEvent` → the fake records the ack with that
   `envelope_id`, and the sink gets `{ eventId, event }` with the inner
   event. An `events_api` envelope missing `payload.event` is acked, not
   sunk. A `slash_commands` envelope is acked, not sunk. A sink that throws
   still gets the next event.
5. **Shared app:** `hello` with `num_connections: 2` and one own socket →
   one warning logged and `slackSharedApp: true`; a later `hello` with 1 →
   `false`.
6. **Graceful handoff:** `sendDisconnect('warning')` then
   `sendDisconnect('refresh_requested')` on the active connection → exactly
   one more `openSocketModeUrl` call and one new connection. An event sent
   on the old connection before the new `hello` is acked on the old one.
   After the new connection's `hello` (`num_connections: 2`), the old
   connection's `closed` resolves, `slackSharedApp` stays `false`, and
   `onStatus` was never called with `disconnected`.
7. **Failed replacement:** the second `openSocketModeUrl` call rejects → the
   active connection stays open, still delivers events, and no further
   `openSocketModeUrl` call is made until it closes.
8. **Active dies mid-handoff:** close the active connection after the
   replacement opens but before its `hello` → no `disconnected` status; the
   replacement's `hello` makes it active.
9. **Liveness:** with `autoPong: false` and a silent server, the fake counts
   pings at the ping interval, then the client drops the connection and
   opens a new one after the stale period; status goes `disconnected` then
   `connected` on the new `hello`.
10. **No hello:** with `autoHello: false`, the client reconnects after the
    stale period.
11. **Backoff with sockets:** `openSocketModeUrl` rejects four times → the
    gaps between calls grow 1×, 2×, 4×, 8× `backoffBaseMs`; after a
    successful `hello`, a server-side close reconnects after 1×
    `backoffBaseMs` again.
12. **Server close without `disconnect`:** status `disconnected`, then a
    reconnect.
13. **Stop:** after `stop()`, every fake connection is closed and no new
    connection arrives over several backoff periods.

## Notes

- **Hello deadline:** ProPager has a separate 15 s `hello` deadline
  (`ConnectionWatchdog::Timing::helloDeadlineMs`). The spec names only the
  30 s liveness rule, so this task arms the 30 s watchdog at socket creation
  and lets it cover a missing `hello` too. Add a separate deadline only if
  the spec is amended.
- **Pinging before `hello`:** ProPager doesn't ping before `hello`; here a
  ping is sent whenever the socket is open. Slack answers pings on an open
  socket either way, and it keeps the code to one rule.
- **`autoPong: false`** on the fake server needs `ws` 8.14 or later. If task
  1 pinned an older `ws`, the fake can instead stop reading (`ws._socket.pause()`)
  to simulate a dead link; say which in the test.
- **`disconnect` reason `link_disabled`** (Socket Mode turned off for the
  app) is handled like any other `disconnect`: the replacement fails and
  backoff takes over, with each failure logged. The spec doesn't ask for
  special handling.
- `SlackStatus` deliberately matches the argument of `hub.setSlackStatus`
  (plan, 001-6), so 001-10 passes `onStatus` through unchanged.
- **Implementation notes (gaps filled):**
  - `SlackStatus` is a `type` alias (as the plan's Interfaces section writes
    it) rather than the `interface` in step 1; same shape.
  - `createWatchdog` is exported (not only internal) so the fake-timer unit
    test can drive it directly.
  - A pong refreshes the watchdog only after that socket's `hello`. Otherwise
    the server's automatic pongs would keep a socket that never says `hello`
    alive forever, and the "no `hello` → reconnect after 30 s" rule would never
    fire. Any frame (including `hello`) always counts.
  - If the active socket dies while a graceful `openSocketModeUrl` call is in
    flight, the replacement becomes the active socket when it arrives (and
    cancels the scheduled reconnect); if that call fails, a reconnect is
    scheduled as for a non-graceful failure.
  - Reconnect delays are logged as `socket mode: reconnecting in <n> ms`; the
    backoff tests assert on those values (deterministic) plus loose real-time
    lower bounds on the gaps.
  - `stop()` mid-handoff may close the replacement while it is still in its
    client-side handshake, so that socket's close code can be 1006 rather than
    1000; the test only asserts that it closed.
