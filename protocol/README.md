# Protocol 1

The wire protocol between the ProPager relay and its clients: **sites**
(ProPager's `RelayClient`, mps-propager Spec 004) and **remote viewers** (for
example a portal channel view). This file is the reference; the
[schema](schema/frame.schema.json) and [fixtures](fixtures/) say the same thing
in machine-checkable form. The protocol version is in [`VERSION`](VERSION).

## Transport

- One WebSocket per client.
- Every frame is a **text** frame holding one JSON object with a string `type`.
- A frame is at most `maxFrameBytes` (default 65,536 bytes).
- A frame that doesn't parse or validate closes the connection with `4000`.
- **Unknown fields are ignored.** Readers on both sides must accept and
  ignore fields they don't know (see [Versioning](#versioning)).
- **Clients ignore unknown frame types** from the relay rather than treating
  them as errors. (The relay does not extend this courtesy to clients: an
  unknown client frame type is a bad frame, `4000`.)

## Handshake

The client's first frame is `hello`. If no `hello` arrives within
`handshakeTimeoutMs`, the relay closes with `4004`.

```jsonc
// client → relay
{ "type": "hello", "protocol": 1, "role": "site", "key": "prk_…",
  "client": { "name": "ProPager", "version": "0.6.0" },
  "resume": { "epoch": "k3v9…", "seq": 41 } }          // optional, see Resume

// relay → client
{ "type": "welcome", "protocol": 1, "role": "site", "name": "north",
  "channels": ["C0123ABC"], "epoch": "k3v9…", "resumed": true,
  "relay": { "version": "0.1.0" } }
```

- The relay matches `key` against every configured site's (or viewer's) key
  hashes for the requested `role`. No match: close `4001`.
- `protocol` must be an integer ≥ 1. If it isn't `1`, the relay sends an
  `error` frame (`code: 4002`) and closes with `4002`.
- After `welcome`, the relay sends a `status` frame.

## Frames

C→R is client to relay; R→C is relay to client. `?` marks an optional field.

| Direction | `type` | Fields | Notes |
|---|---|---|---|
| C→R | `hello` | `protocol` (integer ≥ 1), `role` (`"site"` \| `"viewer"`), `key`, `client: { name, version }`, `resume?: { epoch, seq }` | First frame only |
| R→C | `welcome` | `protocol` (`1`), `role`, `name`, `channels` (string[]), `epoch`, `resumed` (boolean), `relay: { version }` | Answers `hello` |
| R→C | `message` | `seq` (integer ≥ 1), plus every [message field](#message-fields) | To sites: their channels, minus the relay's own bot. To viewers: everything in their channels |
| C→R | `reply` | `id`, `channel`, `threadTs`, `text` | Sites, in their own channels |
| C→R | `react` | `id`, `channel`, `ts`, `emoji` | Sites, in their own channels. `emoji` is a name without colons |
| C→R | `post` | `id`, `channel`, `text`, `threadTs?` | Viewers with `canPost` |
| C→R | `history` | `id`, `channel`, `limit?` (integer ≥ 1, ≤ `historySize`) | Viewers |
| R→C | `result` | `id`, `ok` (boolean), `ts?`, `error?` | Exactly one per `reply` / `react` / `post`. `error` is required when `ok` is `false` |
| R→C | `history_result` | `id`, `channel`, `messages` (message fields, oldest first) | Answers `history` |
| R→C | `status` | `slack` (`"connected"` \| `"disconnected"`), `slackSharedApp` (boolean) | After `welcome` and on every change. ProPager shows it as its Slack status |
| C→R | `ping` | — | At least every 30 s |
| R→C | `pong` | — | Answers `ping` |
| R→C | `error` | `code` (integer), `message` | Sent before a fatal close; `code` is the close code that follows |

Unless stated otherwise every field is a string. Slack timestamps (`ts`,
`threadTs`) are Slack's strings, e.g. `"1732291200.000100"`.

### Message fields

The fields of a `message` frame (besides `type` and `seq`) and of each entry in
`history_result.messages`:

| Field | Type | Meaning |
|---|---|---|
| `eventId` | string | Slack's `event_id`; `"relay:<ts>"` for a post the relay made itself |
| `channel` | string | Channel id, e.g. `C0123ABC` |
| `ts` | string | The message's Slack timestamp |
| `text` | string | Message text |
| `kind` | `"channel"` \| `"thread"` | `"thread"` when the message is a reply in a thread |
| `threadTs?` | string | The thread parent's `ts`; **required** when `kind` is `"thread"` |
| `user?` | string | Slack user id of the author |
| `botId?` | string | Slack bot id, for bot messages |
| `fromSelf` | boolean | Posted by the relay's own bot (only viewers see these) |
| `origin` | `"slack"` \| `"relay"` | `"relay"`: built from the relay's own `post` response, delivered before Slack echoes it |

### `id`

`id` is chosen by the client, unique per connection, and echoed in the
matching `result` or `history_result`, so a client can match answers to
requests. Requests may be answered out of order across threads; within a
thread (`channel` + `threadTs`) the relay sends to Slack one at a time, in
order.

### `result` errors

| `error` | Meaning |
|---|---|
| `not_allowed` | The client may not make this request in this channel. Never reached Slack |
| `invalid` | The relay rejected the request as invalid |
| `rate_limited` | Slack rate-limited the call and retries ran out |
| `slack:<code>` | Slack refused; `<code>` is Slack's `error`, e.g. `slack:channel_not_found` |

A `react` that Slack answers with `already_reacted` is `ok: true`. A
successful `react` has no `ts`.

## Close codes

| Code | Meaning | Client should |
|---|---|---|
| `1001` | Relay shutting down | Reconnect with backoff |
| `4000` | Bad frame | Report a bug; reconnect with backoff |
| `4001` | Unauthorized key | Stop; show "site key rejected" |
| `4002` | Unsupported protocol | Stop; show "update ProPager" (or the relay) |
| `4003` | Replaced by a newer connection with the same key | Stop auto-reconnecting; show "another ProPager is using this site key" |
| `4004` | No `hello` in time | Reconnect with backoff |
| `4005` | Idle: no frame for `idleTimeoutMs` | Reconnect with backoff |

### One live connection per site

A new authenticated site connection replaces the old one: the old connection
is closed with `4003`. Two ProPagers on one site key would otherwise split
pages between them. Viewers may hold several connections.

### Keepalive

The client sends an application-level `ping` frame at least every 30 seconds;
the relay answers `pong`. A connection that sends no frame for
`idleTimeoutMs` is closed with `4005`. (WebSocket-level ping frames aren't
used: not every host exposes them the same way.)

## Resume

Sites can catch up on messages missed across a short disconnect.

- Each relay process has a random `epoch`, sent in `welcome`.
- Each site has a monotonic `seq`: every `message` routed to it gets the next
  one. The relay keeps a site's recent messages for `resumeWindowMs`
  (default 2 minutes, up to `resumeMaxEvents`), including while it is
  disconnected.
- On reconnect, the client sends `hello.resume = { epoch, seq }`, where `seq`
  is the last `seq` it processed (`0` if none).
- If `epoch` matches and the relay still holds `seq + 1`, it answers
  `resumed: true` and replays every message after `seq`, then continues.
- Otherwise it answers `resumed: false` and delivers only new messages. The
  client should log that a gap was possible.
- A relay restart has a new `epoch`, so it never resumes; Slack's own
  redelivery covers events that arrive during a short restart.

Viewers don't resume; they send `history` instead.

## Schema and fixtures

```
protocol/
  README.md                       this reference
  VERSION                         1
  schema/
    frame.schema.json             JSON Schema 2020-12: oneOf every frame, by "type"
  fixtures/
    valid/<type>[-variant].json   frames that must be accepted
    invalid/<case>.json           frames that must be rejected
```

- `frame.schema.json` has a `$defs` entry per frame, `relayMessage`, and
  `clientFrame` / `serverFrame` (`oneOf` each direction's frames). The root
  accepts any frame of either direction. It never forbids additional
  properties.
- Each fixture file holds one frame. `invalid/not-json.json` is deliberately
  not JSON.
- The relay's tests check that every valid fixture passes the schema and the
  relay's parser, and every invalid fixture fails both.
- Clients copy `protocol/fixtures` at a release tag and run them against their
  own parser. **Any change to a fixture is called out in the release notes.**

## Versioning

- Adding an **optional field**, or a **frame type clients may ignore**, keeps
  protocol 1. That is why readers ignore unknown fields, and clients ignore
  unknown relay frame types.
- Any other change (a new required field, a changed meaning, a removed frame)
  is protocol 2. The relay will then accept both protocols for at least one
  release.
