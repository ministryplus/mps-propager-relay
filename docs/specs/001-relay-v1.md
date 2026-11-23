# Spec 001: Relay v1 — Core, Protocol v1, h3 Handlers, Standalone Server

**Date:** 2026-11-22
**Status:** Draft
**Branch:** `feat/relay-v1`

## Goals / Objective

Build the first release of `@ministryplus/propager-relay` (`v0.1.0`): a relay that holds one Slack app's only inbound connection and gives each ProPager site exactly the messages for its channel(s), posts the sites' thread replies and reactions with the bot token, and serves read-and-post **viewers** such as a church portal. It ships as a framework-free core, ready-made h3 handlers, and a standalone server, as decided in [ADR 001](../adr/001-founding-propager-relay.md).

**Success criteria:**

1. Two sites connected to one relay each receive every top-level message and thread reply posted in their own channel, and nothing from the other site's channel.
2. A site's `reply` and `react` requests reach Slack through the relay, in order per thread, and each gets a `result`.
3. The bot's own messages never reach a site, so a site's replies can't page.
4. A viewer sees every message in its channels (including the bot's), can load recent history, and can post. A top-level post reaches the owning site as a page.
5. A site that drops and reconnects within 2 minutes receives the messages it missed. A second connection with the same site key replaces the first and says so.
6. The same core runs behind the Events API (portal style) and Socket Mode (standalone without a public URL).
7. `pnpm add github:ministryplus/mps-propager-relay#v0.1.0` builds through `prepare` in a scratch consumer with a commit-pinned `allowBuilds` entry, and the standalone server starts from `node_modules/.bin/propager-relay`.

## Architecture Overview

```
                    ┌──────────────────────────── core (src/core) ─────────────────────────────┐
 Slack Events API ─▶│ ingress/events-api ─┐                                                     │
  (POST, signed)    │                     ├─▶ normalize ─▶ dedupe ─▶ router ─┬─▶ site session ──┼─▶ site (WSS)
 Slack Socket Mode ◀┤ ingress/socket-mode ┘   (message      (event_id)  echo │   (seq, resume)  │
  (wss, app token)  │                          events only)       filter    └─▶ viewer sessions ─┼─▶ viewer (WSS / in-process)
                    │                                                              │            │
                    │ outbound: per-thread FIFO ─▶ SlackApi (fetch) ◀── reply/react/post ◀──────┤
                    │ history: per-channel ring ◀─ conversations.history (startup backfill)     │
                    └───────────────────────────────────────────────────────────────────────────┘
                         ▲ RelayConfig (sites, viewers, Slack credentials)
     ./h3:         createRelayHandlers(relay) → { slackEvents, socket, health }   (h3 v1 + crossws 0.3)
     ./standalone: `propager-relay serve` = h3 app + node:http + config file + env vars
```

The core never touches HTTP or WebSocket libraries. It exposes `relay.handleSlackEvent(rawBody, headers)` for the Events API, `relay.openConnection(transport)` for a socket peer, and an in-process viewer API. `./h3` adapts those to h3/crossws; a host app (Nitro) and `./standalone` mount the same handlers.

## Decisions

### 1. Toolchain and package

| | |
|---|---|
| **Runtime** | Node 24 LTS (`"engines": { "node": ">=24" }`); church-portal runs Node 24 |
| **Package manager** | pnpm, pinned with `packageManager` (`pnpm@12.9.1`). Dependencies pinned exactly. `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`, so no dependency version younger than 7 days is installed (church-portal's supply-chain rule). |
| **Language** | TypeScript, `strict`, ESM only (`"type": "module"`) |
| **Build** | `tsc -p tsconfig.build.json` → `dist/` (JS + `.d.ts`). No bundler. |
| **Scripts** | `build`; `prepare` → `pnpm run build` (git-dependency installs, [ADR 001](../adr/001-founding-propager-relay.md) Decision 4); `test` → `vitest run`; `typecheck`; `dev:site` (Decision 13) |
| **Tests** | Vitest |
| **Runtime dependencies** | `ws` (Socket Mode client, Decision 4). Nothing else in the core. |
| **Peer dependencies** | `h3` `^1.15.0`, `crossws` `^0.3.5` (for `./h3` and `./standalone`; the same copies the host's Nitro uses, so handlers never mix two h3 instances) |
| **Dev dependencies** | `typescript`, `vitest`, `@types/node`, `@types/ws`, `@slack/types` (type-only imports), `ajv` (fixture schema checks), `h3`, `crossws` |

The pin governs only pnpm commands run in this repo. Consumers install with their own pnpm: a spike on 2026-11-22 showed a church-portal-style consumer on pnpm 10.34.9 builds a relay whose lockfile was written by pnpm 12.9.1 (both write `lockfileVersion: '9.0'`). Implementation step 10 re-checks this against a real `github:` tag, which catches any future lockfile-format change.

**Slack's own types, not its SDK.** ProPager is hand-rolled because there is no official C++ SDK; the relay is TypeScript, so the SDKs were re-checked on their merits (2026-11-22, latest versions):

| Package | Verdict |
|---|---|
| `@slack/types` 3.3.1 | **Used.** Zero dependencies, type-only. Imported with `import type` for Slack event and Web API payload shapes, so it adds nothing to a host's install. Slack types stay internal: the public API exposes only the relay's own types (`RelayMessage`, `RelayConfig`, …), so the emitted `.d.ts` never references `@slack/types`. If that ever changes, it moves to `dependencies`. |
| `@slack/bolt` 5.1.0 | **Not used.** Depends on Express 5 and owns the HTTP server, which conflicts with mounting `./h3` inside a host's h3/Nitro server. Its request-signing helper is the only part the relay needs, and that check is ~15 lines. |
| `@slack/socket-mode` 3.2.0 | **Not used.** Its reconnect, refresh handoff, and ping/pong handling are sound, but it consumes `hello` and emits `Connected` with the `apps.connections.open` response, so `num_connections` never reaches the caller, and the shared-app warning (Decision 4) depends on it. It also pulls in all of `@slack/web-api` and needs `undici` as a peer. The hand-rolled client ports ProPager's `SlackClient` handoff and liveness logic, already hardened in production, and is tested against a fake Slack server. Revisit if the SDK starts exposing `hello`. |
| `@slack/web-api` 8.5.0 | **Not used.** Fetch-based with five small dependencies, but ~8.5 MB unpacked in every host, and its default retry policy (ten retries over about thirty minutes) is wrong for paging and would have to be overridden. The relay calls four methods; a fetch client with 429 handling is ~150 lines. |

Every runtime dependency lands in a host's supply chain, so the relay keeps them to `ws`, which is needed because Node's built-in `WebSocket` exposes no ping/pong, and Socket Mode liveness depends on them.

```jsonc
// package.json (abridged)
{
  "name": "@ministryplus/propager-relay",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".":            { "types": "./dist/core/index.d.ts",       "default": "./dist/core/index.js" },
    "./h3":         { "types": "./dist/h3/index.d.ts",         "default": "./dist/h3/index.js" },
    "./standalone": { "types": "./dist/standalone/index.d.ts", "default": "./dist/standalone/index.js" }
  },
  "bin": { "propager-relay": "./dist/standalone/cli.js" },
  "files": ["dist", "protocol"],
  "packageManager": "pnpm@12.9.1",
  "engines": { "node": ">=24" }
}
```

`protocol/` ships in the package so clients can read schemas and fixtures from an installed copy as well as from a tag.

### 2. Configuration

The core takes a resolved `RelayConfig`. Where it comes from is the host's business (a file for standalone, runtime config or Directus for a host app). That type is the config-source interface from ADR 001 Decision 3.

```ts
export interface RelayConfig {
  slack: {
    botToken: string;              // xoxb-…; Web API and auth.test
    ingress:
      | { mode: 'events-api'; signingSecret: string }
      | { mode: 'socket-mode'; appToken: string };  // xapp-…, connections:write
  };
  sites: SiteConfig[];
  viewers?: ViewerConfig[];
  limits?: Partial<RelayLimits>;
}

export interface SiteConfig {
  name: string;          // "north", unique; shown in logs and welcome
  channels: string[];    // Slack channel ids ("C…"/"G…"); at least one
  keyHashes: string[];   // "sha256:<hex>"; more than one during rotation (Decision 3)
}

export interface ViewerConfig {
  name: string;          // "portal"
  channels: string[] | '*';  // '*' = every channel any site owns
  keyHashes: string[];   // unused by in-process viewers
  canPost: boolean;
}

export interface RelayLimits {
  resumeWindowMs: number;     // 120_000 (Decision 10)
  resumeMaxEvents: number;    // 200 per site
  maxEventAgeMs: number;      // 300_000: older messages never reach a site (Decision 5)
  historySize: number;        // 50 per channel (Decision 11)
  handshakeTimeoutMs: number; // 10_000
  idleTimeoutMs: number;      // 90_000 (Decision 9)
  maxFrameBytes: number;      // 65_536
}
```

`validateConfig(config)` runs in `createRelay` and throws a single error listing every problem:

- names unique within sites and within viewers;
- every channel id matches `^[CG][A-Z0-9]+$`;
- **each channel belongs to exactly one site.** Two sites on one channel would both page and both reply in every thread;
- every key hash parses (`sha256:` + 64 hex);
- a key hash is used by at most one site or viewer.

Config changes need a restart in v1 (see Not Doing).

### 3. Site and viewer keys

- **Format:** `prk_` + 32 random bytes, base64url (≈47 characters). The prefix makes a leaked key easy to recognize in logs and secret scanners.
- **Stored as a hash:** `sha256:<hex of SHA-256(key)>`. A 256-bit random key needs no slow hash, and config files and Directus never hold usable keys. Comparison uses `crypto.timingSafeEqual`.
- **Rotation:** list a new hash next to the old one, update the site's ProPager, then remove the old hash and restart.
- **`propager-relay keygen`** prints a new key once and its hash, for example:

  ```
  key:  prk_9fJ2…   (give this to the site's ProPager; it is not stored anywhere)
  hash: sha256:3b1f…  (put this in the site's keyHashes)
  ```

### 4. Slack ingress: one mode per relay

**Events API** (`relay.handleSlackEvent(rawBody, headers)` → `{ status, headers?, body? }`):

- Verify `X-Slack-Signature` = `v0=` + HMAC-SHA256(signing secret, `` `v0:${X-Slack-Request-Timestamp}:${rawBody}` ``), using a timing-safe compare, and reject a timestamp more than 300 s from now. Failure → 401, logged without the body.
- `type: url_verification` → 200 with the `challenge`.
- `type: event_callback` → **respond 200 immediately**, then process asynchronously. Slack retries a delivery that isn't acknowledged within 3 s, and dedupe (Decision 5) absorbs those retries.
- Anything else → 200 and ignore, so Slack doesn't retry.

**Socket Mode** (started by `relay.start()`):

- `apps.connections.open` with the app token gives a `wss://` URL, opened with `ws`.
- Ack every envelope that has an `envelope_id` before processing it, on the socket it arrived on.
- **`hello`:** if `num_connections` > the relay's own live sockets, log a warning and report `slackSharedApp: true` in health and in `status` frames. Another client on this app is taking some of the events, the failure this relay exists to prevent.
- **`disconnect`:** open a replacement socket first, switch over on its `hello`, then close the old one. That's the same graceful handoff ProPager does.
- **Liveness:** ping every 10 s; if nothing (frame or pong) arrives for 30 s, reconnect.
- **Backoff:** 1 s doubling to 60 s, reset after a `hello`.

Both modes hand the inner Slack `event` plus its `event_id` to the same `normalize → dedupe → route` path.

### 5. Normalizing and routing messages

Only `event.type === 'message'` in a configured channel is considered, with `subtype` absent or one of:

| `subtype` | Why kept |
|---|---|
| *(none)* | An ordinary message |
| `thread_broadcast` | "Also send to channel": still a thread reply (mps-propager Spec 003 Decision 6) |
| `file_share` | A message with an attachment can still carry a number |
| `bot_message` | Other integrations' messages still page (Spec 003 Decision 2) |

Everything else (`message_changed`, `message_deleted`, `channel_join`, …) is dropped: an edit doesn't re-page, matching ProPager today.

A message becomes:

```ts
interface RelayMessage {
  eventId: string;        // Slack event_id; "relay:<ts>" for relay-originated posts (Decision 8)
  channel: string;
  ts: string;
  text: string;
  kind: 'channel' | 'thread';
  threadTs?: string;      // set when kind === 'thread'
  user?: string;
  botId?: string;
  fromSelf: boolean;      // the relay's own bot (Decision 6)
  origin: 'slack' | 'relay';
}
```

- **Thread rule (ported from ProPager's `SlackClient`):** `kind = 'thread'` when `thread_ts` is present and differs from `ts`; otherwise `'channel'`. A thread's parent carrying `thread_ts === ts` is a channel message.
- **Dedupe:** an LRU of `event_id`s seen in the last 10 minutes (bounded at 5,000) drops Slack's retries and redeliveries.
- **Age:** a message whose `ts` is more than `maxEventAgeMs` (5 min) old goes to viewers only. A page that late is stale, and matches ProPager's 5-minute hold limit (mps-propager Spec 003 Decision 11).
- **Routing:** the message goes to the one site that owns the channel (if it isn't filtered by Decision 6) and to every viewer subscribed to the channel.

### 6. The echo filter

- At `start()`, the relay calls `auth.test` and keeps `user_id` and `bot_id`.
- **For sites:** drop a message whose `user` equals the bot user id or whose `bot_id` equals the bot id. **Until `auth.test` has succeeded**, drop every message that carries a `bot_id`. That can't loop, and `auth.test` is retried with backoff. Ported from ProPager's `isOwnMessage` and its fallback.
- **For viewers:** deliver everything, with `fromSelf` set, so a channel view shows ProPager's replies.

### 7. Outbound requests: reply, react, post

| Request | Slack call | Allowed for |
|---|---|---|
| `reply` | `chat.postMessage` `{ channel, thread_ts, text, unfurl_links: false }` | a site, in its own channels |
| `react` | `reactions.add` `{ channel, timestamp, name }` | a site, in its own channels |
| `post` | `chat.postMessage` `{ channel, text, thread_ts?, unfurl_links: false }` | a viewer with `canPost`, in its channels |

- **Per-thread FIFO** (keyed by `channel` + `thread_ts`; top-level posts by `channel`): one request in flight per key, and the next starts when the previous finishes, whether it succeeded or failed. Ported from Spec 003 Decision 9 so a fast "on screen" can't overtake "Got it".
- **Rate limits:** on HTTP 429, pause that Web API method for `Retry-After` seconds and retry the same request, up to 3 times. There's no proactive limiter: Slack allows short bursts, and a batch of three replies fits easily.
- **Results:** every request gets exactly one `result`: `{ ok: true, ts? }`, or `{ ok: false, error }` where `error` is `not_allowed`, `invalid`, `rate_limited` (retries exhausted), or `slack:<code>` (Slack's `error` field). `reactions.add` answering `already_reacted` counts as `ok: true`.
- A request for a channel the sender doesn't own gets `not_allowed` and never reaches Slack.

### 8. Relay-originated posts page from the API response

ADR 001 said the relay would recognize the *echo* of its own post. That races: Slack's echo event can arrive before the `chat.postMessage` response that tells the relay which `ts` it was. So instead:

- When a viewer's `post` succeeds, the relay builds a `RelayMessage` from the response (`ts`, `channel`, the posted `text`, `threadTs` if given, `origin: 'relay'`, `eventId: "relay:<ts>"`) and routes it to the owning site **immediately**, exactly like a Slack message (age and dedupe apply).
- The echo, when it arrives, is the bot's own message. The echo filter drops it for sites, and viewers receive it normally (`fromSelf: true`).

So the site pages once, without waiting for an echo and without a race. This refines ADR 001 Decision 6; the behavior the portal needs is unchanged.

### 9. Protocol v1

Transport: one WebSocket per client; text frames, each a JSON object with a `type`; at most `maxFrameBytes`. A frame that doesn't parse or validate closes the connection with `4000`.

**Handshake.** The client's first frame is `hello`. Without one within `handshakeTimeoutMs`, the relay closes with `4004`.

```jsonc
// client → relay
{ "type": "hello", "protocol": 1, "role": "site", "key": "prk_…",
  "client": { "name": "ProPager", "version": "0.6.0" },
  "resume": { "epoch": "k3v9…", "seq": 41 } }          // optional (Decision 10)

// relay → client
{ "type": "welcome", "protocol": 1, "role": "site", "name": "north",
  "channels": ["C0123ABC"], "epoch": "k3v9…", "resumed": true,
  "relay": { "version": "0.1.0" } }
```

The relay matches the key against every site's or viewer's hashes for the requested `role`. It closes with `4001` if none match, or `4002` (sending `error` first) if `protocol` isn't `1`.

**Frames:**

| Direction | `type` | Fields | Notes |
|---|---|---|---|
| C→R | `hello` | `protocol`, `role`, `key`, `client`, `resume?` | first frame only |
| R→C | `welcome` | `protocol`, `role`, `name`, `channels`, `epoch`, `resumed`, `relay` | |
| R→C | `message` | `seq`, plus every `RelayMessage` field | to sites: filtered (Decisions 5–6); to viewers: everything in their channels |
| C→R | `reply` | `id`, `channel`, `threadTs`, `text` | sites |
| C→R | `react` | `id`, `channel`, `ts`, `emoji` | sites |
| C→R | `post` | `id`, `channel`, `text`, `threadTs?` | viewers with `canPost` |
| C→R | `history` | `id`, `channel`, `limit?` (≤ `historySize`) | viewers |
| R→C | `result` | `id`, `ok`, `ts?`, `error?` | one per `reply`/`react`/`post` |
| R→C | `history_result` | `id`, `channel`, `messages` (oldest first) | |
| R→C | `status` | `slack`: `"connected"` \| `"disconnected"`, `slackSharedApp` | after `welcome` and on every change; ProPager shows it as its Slack status |
| C→R | `ping` | — | at least every 30 s |
| R→C | `pong` | — | reply to `ping` |
| R→C | `error` | `code`, `message` | sent before a fatal close |

`id` is a client-chosen string, unique per connection, echoed in `result`/`history_result`.

**Close codes:**

| Code | Meaning | Client should |
|---|---|---|
| `1001` | Relay shutting down | Reconnect with backoff |
| `4000` | Bad frame | Report a bug; reconnect with backoff |
| `4001` | Unauthorized key | Stop; show "site key rejected" |
| `4002` | Unsupported protocol | Stop; show "update ProPager" (or the relay) |
| `4003` | Replaced by a newer connection with the same key | Stop auto-reconnecting; show "another ProPager is using this site key" |
| `4004` | No `hello` in time | Reconnect with backoff |
| `4005` | Idle: no frame for `idleTimeoutMs` | Reconnect with backoff |

**One live connection per site.** A new authenticated site connection replaces the old one (`4003` to the old). This is the relay-side version of the shared-app bug that started this work: two ProPagers on one key would otherwise split pages again. Viewers may hold several connections.

Application-level `ping`/`pong` instead of WebSocket ping frames: crossws's adapters don't expose ping control the same way on every host, and app frames work everywhere.

### 10. Missed messages across a reconnect

- Each relay process has a random `epoch`. Each site has a monotonic `seq`, assigned to every `message` routed to it, kept in a buffer for `resumeWindowMs` (2 min), up to `resumeMaxEvents`.
- Messages for a site that is disconnected are buffered too.
- On reconnect, `hello.resume = { epoch, seq }` with the last `seq` the client processed. If the epoch matches and the buffer still holds `seq + 1`, the relay replays everything after it and answers `resumed: true`. Otherwise it answers `resumed: false` and delivers only new messages; the client logs that a gap was possible.
- **A relay restart** loses the buffer (a new epoch). Events that arrived *during* the restart are covered by Slack's own retries: both ingress modes redeliver unacknowledged events, and dedupe drops duplicates. A restart longer than Slack's retry schedule loses messages; deploys should avoid service times (church-portal draft ADR).

Viewers don't resume; they reload history.

### 11. Viewers and history

- **History:** a ring buffer per channel of the last `historySize` (50) messages, every message routed for that channel including `fromSelf`. At `start()`, each configured channel is backfilled from `conversations.history` (`limit` = `historySize`), retried with backoff and logged on failure. This needs `channels:history` / `groups:history`, which the app already has.
- **In-process viewers** (a host app such as the portal):

  ```ts
  const view = relay.viewer({ name: 'portal', channels: ['C0123ABC'] }, (msg) => push(msg));
  view.history('C0123ABC', 20);       // RelayMessage[], oldest first
  await view.post('C0123ABC', '1234'); // { ok, ts?, error? }, same rules as the post frame
  view.close();
  ```

  In-process viewers are named from `config.viewers` (for `canPost` and channels) but skip keys: the host has already authorized its user.
- **Remote viewers** use the same frames over WSS (Decision 9).

### 12. Core API, h3 handlers, standalone server

```ts
// @ministryplus/propager-relay
export function createRelay(options: {
  config: RelayConfig;
  logger?: Logger;          // { debug, info, warn, error }; default console with "[relay]" prefix
  slackApi?: SlackApi;      // test seam; default fetch-based client
  now?: () => number;       // test seam
}): Relay;

export interface Relay {
  start(): Promise<void>;   // auth.test, history backfill, Socket Mode connect (if configured)
  stop(): Promise<void>;    // close every connection with 1001, stop ingress
  handleSlackEvent(rawBody: string, headers: Record<string, string | undefined>):
    Promise<{ status: number; headers?: Record<string, string>; body?: string }>;
  openConnection(transport: { send(text: string): void; close(code: number, reason: string): void }):
    { receive(text: string): void; closed(): void };
  viewer(opts: { name: string; channels?: string[] }, listener: (m: RelayMessage) => void): ViewerHandle;
  health(): HealthReport;   // { slack, slackSharedApp, ingress, sites: { name, connected, lastSeenMs }[], viewers }
}
```

`slack` is `"connected"` when the relay can receive events: for Socket Mode, a socket has had its `hello`; for the Events API (no socket), `auth.test` has succeeded. The same value drives `status` frames.

```ts
// @ministryplus/propager-relay/h3 (h3 v1, crossws 0.3)
export function createRelayHandlers(relay: Relay): {
  slackEvents: EventHandler;   // reads the raw body (readRawBody) — signatures cover raw bytes
  socket: EventHandler;        // defineWebSocketHandler: open/message/close → openConnection
  health: EventHandler;        // JSON HealthReport; 200 if Slack connected, else 503
};
```

A Nitro host mounts these as route files (church-portal draft ADR Decision 1).

**`./standalone`:**

```
propager-relay serve --config ./propager-relay.json   # sites and viewers (no secrets)
propager-relay keygen
```

| Setting | Source | Default |
|---|---|---|
| `SLACK_BOT_TOKEN` | env | required |
| `SLACK_SIGNING_SECRET` | env | required for `events-api` |
| `SLACK_APP_TOKEN` | env | required for `socket-mode` |
| ingress mode | config `ingress` | `socket-mode` if `SLACK_APP_TOKEN` is set, else `events-api` |
| `HOST` / `PORT` | env | `0.0.0.0` / `8787` |

Routes: `POST /slack/events`, `GET /ws`, `GET /healthz`. The server speaks plain HTTP. TLS comes from a reverse proxy or `tailscale serve` in front of it. The relay never handles certificates. `SIGTERM`/`SIGINT` → `relay.stop()` then exit.

Secrets come only from env vars, so a config file can be committed or shared without leaking tokens.

### 13. `dev:site`: a stand-in site for verification

`scripts/dev-site.ts` (`pnpm dev:site --url ws://localhost:8787/ws --key prk_…`) connects as a site, prints every frame, and answers each top-level message with a thread reply `"relay saw <text>"` and a 👀 reaction. Options: `--resume <epoch>:<seq>` sends a `resume` in `hello` (it prints `epoch` and each `seq` as it goes); `--role viewer` connects as a viewer instead, prints everything, and reads `history <channel>` / `post <channel> <text>` commands from stdin. It lets the relay be verified end to end against Slack before ProPager's `RelayClient` exists (mps-propager Spec 004). It is not part of the package.

### 14. Protocol artifacts and fixtures

```
protocol/
  README.md                 the frame reference (Decision 9), versioned "protocol 1"
  VERSION                   1
  schema/
    frame.schema.json       JSON Schema 2020-12: oneOf every frame, discriminated by "type"
  fixtures/
    valid/<type>[-variant].json     one or more per frame type, e.g. message-thread.json
    invalid/<case>.json             e.g. hello-missing-key.json, message-bad-kind.json
```

- **Tests:** every `valid/` fixture passes the schema (ajv) **and** the relay's runtime parser; every `invalid/` fixture fails both. The runtime parser is hand-written (`src/protocol/parse.ts`), so ajv stays a dev dependency, and these tests keep the parser and the schema in step.
- **Clients** copy `protocol/fixtures` at a release tag (mps-propager ADR 001 Decision 4). A change to any fixture is called out in the release notes.
- **Bumping the protocol:** adding an optional field, or a frame type clients may ignore, keeps protocol 1. Anything else is protocol 2, and the relay then accepts both for at least one release.

## Implementation Sequence

1. **Scaffold.** `package.json` (Decision 1), `pnpm-workspace.yaml` (`minimumReleaseAge`), `tsconfig*.json`, `vitest.config.ts`, `.gitignore` (`dist`, `node_modules`), empty entry points for the three exports, `pnpm build`/`test`/`typecheck` passing.
2. **Protocol v1 artifacts.** `protocol/README.md`, `schema/frame.schema.json`, `fixtures/valid|invalid`, `src/protocol/` (types + parser), and the fixture tests.
3. **Config and keys.** `RelayConfig` types, `validateConfig`, key generation/hashing/verification, and their tests.
4. **Slack Web API client.** `SlackApi` over `fetch` (`auth.test`, `chat.postMessage`, `reactions.add`, `conversations.history`), with 429/`Retry-After` handling, and a `FakeSlackApi` for the tests.
5. **Router and sessions.** Normalize, dedupe, age, echo filter, channel→site routing; the connection state machine (handshake, auth, replace, ping/idle, close codes); seq buffers and resume, all tested with fake transports and an injected clock.
6. **Outbound and viewers.** Per-thread FIFO and results; `not_allowed` checks; relay-originated posts (Decision 8); history rings and backfill; the in-process viewer API.
7. **Events API ingress.** Signature verification (computed test vectors, stale timestamp, bad signature), `url_verification`, asynchronous processing after a 200.
8. **Socket Mode ingress.** `apps.connections.open`, ack, `hello` with `num_connections`, graceful `disconnect` handoff, liveness, backoff, tested against a local `ws` server standing in for Slack.
9. **h3 handlers and standalone.** `createRelayHandlers`, the CLI (`serve`, `keygen`), env and config loading, `/healthz`, shutdown; one end-to-end test: standalone on an ephemeral port, a `ws` client as a site, a signed Events API post in, a `message` frame out, a `reply` out to a fake Slack.
10. **`dev:site`, README usage, `v0.1.0`.** The dev site script; README sections for running standalone and mounting in h3/Nitro; tag `v0.1.0`, then install it with `github:ministryplus/mps-propager-relay#v0.1.0` in a scratch consumer to confirm `prepare` and the `allowBuilds` entry for the `github:` form (untested so far, ADR 001 Decision 4).

## File Plan

### New Files

| File | Purpose |
|---|---|
| `package.json`, `pnpm-lock.yaml` | Package definition (Decision 1) |
| `pnpm-workspace.yaml` | pnpm settings: `minimumReleaseAge: 10080` (Decision 1) |
| `tsconfig.json`, `tsconfig.build.json` | Type-checking (src + tests) / build (src → dist) |
| `vitest.config.ts` | Test config |
| `.gitignore` | `dist`, `node_modules` |
| `protocol/README.md`, `protocol/VERSION` | Protocol 1 reference |
| `protocol/schema/frame.schema.json` | JSON Schema for every frame |
| `protocol/fixtures/valid/*.json`, `protocol/fixtures/invalid/*.json` | Example frames shared with clients |
| `src/protocol/types.ts`, `src/protocol/parse.ts` | Frame types; runtime parser/validator |
| `src/core/index.ts` | Public core exports (`createRelay`, types, `validateConfig`, key helpers) |
| `src/core/config.ts` | `RelayConfig`, `RelayLimits` defaults, `validateConfig` |
| `src/core/keys.ts` | `generateKey`, `hashKey`, `verifyKey` |
| `src/core/slack-api.ts` | Fetch-based `SlackApi` with 429 handling |
| `src/core/normalize.ts` | Slack event → `RelayMessage` (subtypes, thread rule) |
| `src/core/router.ts` | Dedupe, age, echo filter, routing to sessions |
| `src/core/session.ts` | Connection state machine, seq buffer, resume |
| `src/core/outbound.ts` | Per-thread FIFO, results, relay-originated posts |
| `src/core/history.ts` | Per-channel ring buffers, backfill |
| `src/core/relay.ts` | `createRelay`, `Relay` implementation, health |
| `src/core/ingress/events-api.ts` | Signature check, `url_verification`, `event_callback` |
| `src/core/ingress/socket-mode.ts` | Socket Mode client over `ws` |
| `src/h3/index.ts` | `createRelayHandlers` |
| `src/standalone/index.ts`, `src/standalone/cli.ts` | Config/env loading, server, `serve`/`keygen` |
| `scripts/dev-site.ts` | Stand-in site (Decision 13) |
| `test/**/*.test.ts` | Unit, ingress, and end-to-end tests; `test/fakes/` for `FakeSlackApi`, fake transports, fake Socket Mode server |

### Modified Files

| File | Change |
|---|---|
| `README.md` | "Status" → v0.1.0; running standalone; mounting in h3/Nitro; keygen; Slack app setup (scopes, events, Socket Mode vs Events API) |
| `docs/adr/001-founding-propager-relay.md` | Note Decision 8's refinement in an addendum: relay-originated posts page from the API response, not the echo |

## Not Doing (and Why)

- **Multi-workspace / OAuth installs.** One relay serves one workspace (ADR 001 Decision 6 / mps-propager ADR 001 Decision 7). Serving many churches from one relay is a later product decision.
- **Persistence.** Buffers, dedupe, and history live in memory. Slack's retries cover short restarts, and history backfills from Slack. A database would make every host stateful.
- **Live config reload.** Changing sites, viewers, or keys needs a restart. A Directus-backed host can add reload later through a `relay.updateConfig`; v1 doesn't need it.
- **TLS in the standalone server.** A reverse proxy or `tailscale serve` already does this well, and certificates are a support burden.
- **A Docker image.** Useful for other churches, but it's packaging, not behavior. It can come after v0.1.0.
- **npm publishing.** A git dependency until the API settles (ADR 001 Decision 4).
- **h3 v2 / Nitro 3.** h3 v2 is still a release candidate, and church-portal runs h3 1.15. `./h3` targets v1; a v2 adapter comes when hosts move.
- **Message edits and deletes.** Edits never re-page today; forwarding `message_changed` would invite double pages.
- **Slash commands, interactivity, Home tab.** ProPager is message-driven.
- **A proactive rate limiter.** Bursts fit Slack's allowance; 429 handling covers the rest.
- **Metrics/observability beyond logs and `/healthz`.** Enough for a church deployment; revisit if hosted for many churches.
- **Viewer resume.** Viewers reload history on reconnect; a missed live message in a channel view is harmless.

## Verification

Against a test Slack workspace with a test app. ProPager isn't needed; `dev:site` stands in.

1. **Socket Mode standalone:** `SLACK_BOT_TOKEN=… SLACK_APP_TOKEN=… propager-relay serve --config test.json` with two sites on two channels. `/healthz` shows Slack connected.
2. Start two `dev:site` processes with the two keys. Post `1234` in channel A: only site A prints it, replies "relay saw 1234" in the thread, and adds 👀. Channel B's site prints nothing.
3. Reply in that thread: site A gets `kind: "thread"` with the right `threadTs`. Reply with "Also send to channel": still `kind: "thread"`.
4. The relay's own "relay saw…" replies never reach either site (the log shows the echo filtered).
5. Start a third `dev:site` with site A's key: the first gets `4003` and stops; the new one receives channel A's messages.
6. Stop site A's `dev:site`, post two messages, restart it within 2 minutes with `--resume` from its last `seq`: both are replayed, `resumed: true`.
7. Start a second Socket Mode client on the same app (e.g. a ProPager in Direct mode): the relay logs the shared-app warning and `/healthz` shows `slackSharedApp: true`.
8. **Events API standalone:** run with `SLACK_SIGNING_SECRET` behind a tunnel or `tailscale funnel`, point the app's Request URL at `/slack/events`, and repeat steps 2–4.
9. **Viewer:** connect a remote viewer (a `dev:site --role viewer` mode): it sees every message, including the relay's replies with `fromSelf: true`. `history` returns the latest messages. `post` `5678` → site A pages it (prints the message with `origin: "relay"`).
10. **Install as a git dependency:** in a scratch pnpm 12 project, `pnpm add github:ministryplus/mps-propager-relay#v0.1.0` fails with the allowlist error; adding the entry pnpm prints makes it build; `pnpm exec propager-relay keygen` works.

## Related

- [ADR 001: Founding the ProPager Relay](../adr/001-founding-propager-relay.md): identity, package shape, consumption, protocol ownership, responsibilities (Decision 8 refines its Decision 6)
- [mps-propager ADR 001: Slack relay architecture](https://github.com/ministryplus/mps-propager/blob/master/docs/adr/001-slack-relay-architecture.md): the problem and the Direct/Relay split
- [mps-propager Spec 003](https://github.com/ministryplus/mps-propager/blob/master/docs/specs/003-threaded-slack-feedback.md): the own-message filter (Decision 2), thread routing (Decision 6), per-thread reply order (Decision 9), and the 5-minute hold limit (Decision 11) ported here
- [Draft church-portal ADR](../drafts/church-portal-adr-propager-relay.md): how a Nitro host mounts `./h3` and uses the in-process viewer
- mps-propager Spec 004 (next): ProPager's `RelayClient` against protocol 1 and these fixtures
- Slack API: Events API (request signing, `url_verification`, retries), Socket Mode (`apps.connections.open`, envelopes, `hello.num_connections`, `disconnect`), `auth.test`, `chat.postMessage`, `reactions.add`, `conversations.history`, rate limits (`Retry-After`)
