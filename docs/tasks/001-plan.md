# Plan 001: Relay v1 — Core, Protocol v1, h3 Handlers, Standalone Server

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Complete
**Date:** 2026-11-22

## Overview

This plan breaks Spec 001 into 12 tasks. After a scaffold, the core is built as **independent modules with fixed interfaces** (below), so most of them can be built in parallel and tested in isolation with fakes and an injected clock. They meet in `createRelay` (task 10), which wires them together. The h3 handlers, the standalone server, and an end-to-end test sit on top (task 11), and the release work comes last (task 12).

Two ordering constraints carry the plan:

- **The protocol and config types come first** (tasks 2 and 3). Every session, router, and outbound test speaks in `RelayMessage`, frame types, and `RelayConfig`, so their shapes must be fixed before anything consumes them.
- **Nothing reaches Slack except through `SlackApi`** (task 4). Outbound, Socket Mode, and history all take a `SlackApi`, so their tests use `FakeSlackApi` and never touch the network.

## Interfaces between tasks

Parallel tasks code against these. A task that needs to change one updates this section in the same commit and tells the owners of the dependent tasks.

```ts
// src/protocol/types.ts (task 2): RelayMessage plus one type per frame (Spec Decision 9)
export interface RelayMessage {
  eventId: string; channel: string; ts: string; text: string;
  kind: 'channel' | 'thread'; threadTs?: string;
  user?: string; botId?: string; fromSelf: boolean; origin: 'slack' | 'relay';
}
export type ClientFrame = HelloFrame | ReplyFrame | ReactFrame | PostFrame | HistoryFrame | PingFrame;
export type ServerFrame = WelcomeFrame | MessageFrame | ResultFrame | HistoryResultFrame
                        | StatusFrame | PongFrame | ErrorFrame;

// src/protocol/parse.ts (task 2)
export function parseClientFrame(text: string): ClientFrame;   // throws ProtocolError (→ close 4000)
export function parseServerFrame(text: string): ServerFrame;   // for tests and dev:site
export const CLOSE = { GOING_AWAY: 1001, BAD_FRAME: 4000, UNAUTHORIZED: 4001,
  UNSUPPORTED_PROTOCOL: 4002, REPLACED: 4003, HANDSHAKE_TIMEOUT: 4004, IDLE: 4005 } as const;

// src/core/config.ts (task 3)
export interface RelayConfig { /* Spec Decision 2 */ }
export const DEFAULT_LIMITS: RelayLimits;
export function validateConfig(config: RelayConfig): ResolvedConfig; // throws ConfigError listing every problem
// ResolvedConfig = RelayConfig with: limits filled in from DEFAULT_LIMITS; viewers defaulted to [];
//   viewer channels '*' expanded to every site-owned channel; channelOwner: Map<channel, siteName>

// src/core/keys.ts (task 3)
export function generateKey(): string;                     // "prk_…"
export function hashKey(key: string): string;              // "sha256:<hex>"
export function verifyKey(key: string, hashes: string[]): boolean; // timing-safe

// src/core/slack-api.ts (task 4)
export interface SlackApi {
  authTest(): Promise<{ userId: string; botId: string }>;
  postMessage(a: { channel: string; text: string; threadTs?: string }): Promise<{ ts: string }>;
  addReaction(a: { channel: string; ts: string; emoji: string }): Promise<void>; // already_reacted → resolves
  history(a: { channel: string; limit: number }): Promise<SlackHistoryMessage[]>;
  openSocketModeUrl(appToken: string): Promise<string>;   // apps.connections.open
}
export function createSlackApi(o: { botToken: string; baseUrl?: string; sleep?(ms: number): Promise<void>;
  now?(): number; timeoutMs?: number }): SlackApi;
export class SlackApiError extends Error { code: string } // Slack's `error`, 'rate_limited', or 'network' (incl. 5xx/timeout)
// The relay's own shape, Slack's field names; newest first, as Slack returns it
export type SlackHistoryMessage = { ts: string; text?: string; user?: string; bot_id?: string;
  thread_ts?: string; subtype?: string; type?: string };
export interface BotIdentity { userId: string; botId: string }   // authTest()'s result

// src/core/ingress/events-api.ts (task 8); task 9 imports SlackEventSink from here
export type SlackEventSink = (e: { eventId: string; event: Record<string, unknown> }) => void;
export function createEventsApiIngress(o: { signingSecret: string; sink: SlackEventSink; now(): number; logger: Logger }):
  { handle(rawBody: string, headers: Record<string, string | undefined>):
      Promise<{ status: number; headers?: Record<string, string>; body?: string }> };

// src/core/ingress/socket-mode.ts (task 9)
export type SlackStatus = { slack: 'connected' | 'disconnected'; slackSharedApp: boolean }; // same shape as hub.setSlackStatus
export function createSocketMode(o: { appToken: string; slackApi: SlackApi; sink: SlackEventSink; logger: Logger;
  onStatus(s: SlackStatus): void; timing?: Partial<SocketModeTiming> }):
  { start(): Promise<void>; stop(): Promise<void>; status(): SlackStatus };

// src/core/router.ts (task 5)
export interface Delivery {               // implemented by the session hub (task 6)
  toSite(site: string, msg: RelayMessage): void;
  toViewers(msg: RelayMessage): void;
}
// router.ingest checks the configured channel first; normalize only shapes the message
export function normalize(e: { eventId: string; event: Record<string, unknown> },
                          botIdentity: BotIdentity | null): RelayMessage | null;
// route() sends origin:'relay' messages to the site only: viewers get the Slack echo (Spec Decision 8)
export function createRouter(o: { config: ResolvedConfig; delivery: Delivery; now(): number; logger: Logger }):
  { setBotIdentity(id: BotIdentity): void; ingest: SlackEventSink; route(msg: RelayMessage): void };

// src/core/session.ts (task 6)
export interface Principal { role: 'site' | 'viewer'; name: string; channels: string[]; canPost: boolean }
export type RequestHandler = (p: Principal, f: ReplyFrame | ReactFrame | PostFrame | HistoryFrame)
  => Promise<ResultFrame | HistoryResultFrame>;
export function createSessionHub(o: { config: ResolvedConfig; requests: RequestHandler; now(): number;
  logger: Logger; epoch?: string }): Delivery & {
    openConnection(t: { send(text: string): void; close(code: number, reason: string): void }):
      { receive(text: string): void; closed(): void };
    setSlackStatus(s: { slack: 'connected' | 'disconnected'; slackSharedApp: boolean }): void;
    health(): { sites: { name: string; connected: boolean; lastSeenMs: number | null }[]; viewers: number };
    closeAll(code: number, reason: string): void;
  };

// src/core/outbound.ts (task 7)
export function createOutbound(o: { slackApi: SlackApi; config: ResolvedConfig; logger: Logger;
  onRelayPost(msg: RelayMessage): void }):
  { request(p: Principal, f: ReplyFrame | ReactFrame | PostFrame): Promise<ResultFrame> };

// src/core/logger.ts (task 1)
export interface Logger { debug(...a: unknown[]): void; info(...a: unknown[]): void;
                          warn(...a: unknown[]): void; error(...a: unknown[]): void }
export const consoleLogger: Logger; // "[relay]" prefix
```

`createRelay` (task 10) wires them together: ingress → `router.ingest`; `router` → `hub` (as `Delivery`); `hub` requests → `outbound.request`, or the history ring for `history` frames; `outbound.onRelayPost` → `router.route` **and** the history ring. The ring is keyed by `channel` + `ts`, so a relay post is recorded at once and Slack's later echo of it (same `ts`) replaces that entry instead of adding a second one. History therefore holds a viewer's post even if Slack never echoes it.

## Dependency Graph

```
                              001-1 scaffold
                     (package.json, pnpm pins, tsconfig,
                      vitest, logger, empty entry points)
                                    │
        ┌──────────────────┬────────┴─────────┬──────────────────┐
        ▼                  ▼                  ▼                  ▼
  001-2 protocol      001-3 config-keys   001-4 slack-api    001-8 events-api
  (protocol/ docs,    (RelayConfig,       (fetch client,     (signature check,
   schema, fixtures,   validateConfig,     429/Retry-After,   url_verification,
   types + parser)     key helpers)        FakeSlackApi)      200 then sink)
        │                  │                  │                  │
        ├─────────┬────────┤        ┌─────────┤                  │
        │         │        │        │         │                  │
        ▼         ▼        ▼        ▼         ▼                  │
  001-5 router  001-6 sessions   001-7 outbound  001-9 socket-mode │
  (normalize,   (handshake, keys, (per-thread    (ws client, ack,  │
   dedupe, age,  replace, ping,    FIFO, results, hello warning,   │
   echo filter,  close codes,      not_allowed,   handoff,         │
   routing)      seq + resume)     relay posts)   liveness)        │
        │            │                 │              │            │
        └────────────┴────────┬────────┴──────────────┴────────────┘
                              ▼
                   001-10 relay-assembly
                   (createRelay, history rings + backfill,
                    in-process viewer, health, core exports)
                              ▼
                   001-11 h3-standalone
                   (createRelayHandlers, CLI serve/keygen,
                    env + config file, /healthz, e2e test)
                              ▼
                   001-12 release
                   (dev:site, README, ADR addendum,
                    v0.1.0 tag + git-dependency install check)
```

Exact edges: 5 ← 2, 3. 6 ← 2, 3. 7 ← 2, 3, 4. 9 ← 4. 8 ← 1 only (its sink type is defined in the interfaces above). 10 ← 5, 6, 7, 8, 9. 11 ← 10. 12 ← 11.

## Waves (parallelism)

| Wave | Tasks | Parallel? | Rationale |
|---|---|---|---|
| 1 | `001-1` scaffold | — (solo) | Every later task needs the package, toolchain, and `Logger`. |
| 2 | `001-2` protocol, `001-3` config-keys, `001-4` slack-api, `001-8` events-api | **Yes** | Disjoint files (`protocol/` + `src/protocol/` / `src/core/config.ts`, `keys.ts` / `src/core/slack-api.ts` + its fake / `src/core/ingress/events-api.ts`), each with its own tests. Only shared file is `pnpm-lock.yaml` if a task adds a dev dependency; task 1 installs them all up front so none needs to. |
| 3 | `001-5` router, `001-6` sessions, `001-7` outbound, `001-9` socket-mode | **Yes** | Disjoint files. They meet only through the interfaces above, so each is tested with fakes (`Delivery`, `RequestHandler`, `FakeSlackApi`, a fake Socket Mode server). |
| 4 | `001-10` relay-assembly | — (solo) | Wires every core module and owns `src/core/index.ts`. |
| 5 | `001-11` h3-standalone | — (solo) | Needs a working `Relay`. |
| 6 | `001-12` release | — (solo) | Tagging and pushing `v0.1.0` is outward-facing: **needs the user's go-ahead**. |

Run parallel tasks in separate worktrees, each starting from the tip of `feat/relay-v1` after the previous wave lands. Merge each wave before starting the next.

## Checkpoints (system stays working after each task)

- **After 001-1:** `pnpm install`, `pnpm build`, `pnpm test` (one smoke test), and `pnpm typecheck` pass. `dist/` has the three entry points (empty). `consoleLogger` exists.
- **After wave 2:** protocol 1 is fixed. `protocol/` has its reference, schema, and fixtures, and the parser accepts every valid fixture and rejects every invalid one. Configs validate, with every problem listed. Keys generate, hash, and verify. `SlackApi` talks to a local fake HTTP server, including a 429 → `Retry-After` → retry. The Events API ingress verifies signatures and answers `url_verification`. Nothing is wired together yet.
- **After wave 3:** each core module passes its own tests against fakes. The router routes a message to the owning site and to viewers, filters the bot's own messages, and drops duplicates and stale pages. The hub handles every close code, one connection per site, and resume. Outbound keeps per-thread order and turns a viewer post into a site page. Socket Mode connects, acks, hands off, and warns on a shared app against a fake server.
- **After 001-10:** `createRelay(config)` with `FakeSlackApi` and fake transports runs the whole flow in process: a signed event in → a `message` frame to the site → `reply` → `postMessage` on the fake → `result`. `relay.viewer()` gets history and posts. `relay.health()` reports everything.
- **After 001-11:** `propager-relay serve` runs on a real port. The end-to-end test passes over real HTTP and WebSocket. `propager-relay keygen` prints a key and its hash. The package can be mounted in an h3 app.
- **After 001-12:** `v0.1.0` is tagged and pushed (with approval). A scratch pnpm 12 consumer installs it as `github:ministryplus/mps-propager-relay#v0.1.0` with the `allowBuilds` entry pnpm prints. `dev:site` verifies against a real test workspace (Spec Verification 1–10). ProPager's Spec 004 can start.

## Task Files

| # | File | Wave | Depends on | Blocks |
|---|---|---|---|---|
| 1 | [001-1-scaffold.md](001-1-scaffold.md) ✅ | 1 | — | 2, 3, 4, 8 |
| 2 | [001-2-protocol.md](001-2-protocol.md) ✅ | 2 | 1 | 5, 6, 7 |
| 3 | [001-3-config-keys.md](001-3-config-keys.md) ✅ | 2 | 1 | 5, 6, 7 |
| 4 | [001-4-slack-api.md](001-4-slack-api.md) ✅ | 2 | 1 | 7, 9 |
| 5 | [001-5-router.md](001-5-router.md) ✅ | 3 | 2, 3 | 10 |
| 6 | [001-6-sessions.md](001-6-sessions.md) ✅ | 3 | 2, 3 | 10 |
| 7 | [001-7-outbound.md](001-7-outbound.md) ✅ | 3 | 2, 3, 4 | 10 |
| 8 | [001-8-events-api.md](001-8-events-api.md) ✅ | 2 | 1 | 10 |
| 9 | [001-9-socket-mode.md](001-9-socket-mode.md) ✅ | 3 | 4 | 10 |
| 10 | [001-10-relay-assembly.md](001-10-relay-assembly.md) ✅ | 4 | 5, 6, 7, 8, 9 | 11 |
| 11 | [001-11-h3-standalone.md](001-11-h3-standalone.md) ✅ | 5 | 10 | 12 |
| 12 | [001-12-release.md](001-12-release.md) ✅ | 6 | 11 | — |

## Notes

- **Task 1 installs every dependency** listed in Spec Decision 1, so later parallel tasks never edit `package.json` or `pnpm-lock.yaml` at the same time. A task that truly needs a new dependency stops and asks, as the repo conventions require.
- **Tests use fakes, never Slack.** `FakeSlackApi` (task 4) for the Web API, fake transports for sockets (task 6), a local `ws` server for Socket Mode (task 9), and a real ephemeral-port server only in task 11's end-to-end test.
- **The clock is injected everywhere** (`now()`), so age limits, resume windows, idle timeouts, and dedupe expiry are tested without sleeping. Timers use the injected clock where a test needs control; `vi.useFakeTimers()` covers `setTimeout`/`setInterval`.
- **Relay-originated posts page from the API response** (Spec Decision 8), which refines founding ADR 001 Decision 6; task 12 adds the addendum.
- **Out of scope (Spec "Not Doing"):** multi-workspace/OAuth, persistence, live config reload, TLS in standalone, Docker, npm publishing, h3 v2, edits/deletes, slash commands, a proactive rate limiter, metrics, viewer resume.
