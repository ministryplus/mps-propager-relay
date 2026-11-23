# Task 001-2: Protocol v1 artifacts (reference, schema, fixtures, types, parser)

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Pending
**Parallel group:** Wave 2 (parallel with [001-3](001-3-config-keys.md), [001-4](001-4-slack-api.md), [001-8](001-8-events-api.md) — disjoint files: `protocol/`, `src/protocol/`, `test/protocol/`)
**Depends on:** [001-1](001-1-scaffold.md)
**Blocks:** [001-5](001-5-router.md), [001-6](001-6-sessions.md), [001-7](001-7-outbound.md)

## What

Fix protocol 1 (Spec 001 Decisions 9 and 14) as files clients can copy and as
TypeScript the relay builds on. Write `protocol/README.md` (the frame
reference, versioned "protocol 1"), `protocol/VERSION`, a JSON Schema 2020-12
(`protocol/schema/frame.schema.json`, `oneOf` every frame, discriminated by
`type`), and `protocol/fixtures/valid|invalid`. In `src/protocol/types.ts`,
define `RelayMessage` (Decision 5), one interface per frame, the `ClientFrame`
/ `ServerFrame` unions, and the `CLOSE` constants, all with the exact names in
the plan's "Interfaces between tasks". In `src/protocol/parse.ts`, write the
hand-written runtime parser `parseClientFrame` / `parseServerFrame`, which
throws `ProtocolError` (the session turns that into close `4000`). A fixture
test keeps the schema and the parser in step: every valid fixture passes ajv
**and** the right parser; every invalid fixture fails both. Nothing consumes
these yet; waves 3+ code against them.

## Steps

1. **`src/protocol/types.ts`.**
   - `RelayMessage` exactly as the plan interface (`eventId`, `channel`, `ts`,
     `text`, `kind: 'channel' | 'thread'`, `threadTs?`, `user?`, `botId?`,
     `fromSelf`, `origin: 'slack' | 'relay'`).
   - One interface per frame, each with a literal `type`, fields from the
     Decision 9 table:
     - Client: `HelloFrame` (`protocol: number`, `role: 'site' | 'viewer'`,
       `key`, `client: { name: string; version: string }`,
       `resume?: { epoch: string; seq: number }`), `ReplyFrame` (`id`,
       `channel`, `threadTs`, `text`), `ReactFrame` (`id`, `channel`, `ts`,
       `emoji`), `PostFrame` (`id`, `channel`, `text`, `threadTs?`),
       `HistoryFrame` (`id`, `channel`, `limit?`), `PingFrame`.
     - Server: `WelcomeFrame` (`protocol: 1`, `role`, `name`, `channels`,
       `epoch`, `resumed`, `relay: { version: string }`), `MessageFrame`
       (`RelayMessage & { type: 'message'; seq: number }`), `ResultFrame`
       (`id`, `ok`, `ts?`, `error?`), `HistoryResultFrame` (`id`, `channel`,
       `messages: RelayMessage[]`), `StatusFrame` (`slack: 'connected' |
       'disconnected'`, `slackSharedApp: boolean`), `PongFrame`,
       `ErrorFrame` (`code: number`, `message: string`).
   - `export type ClientFrame = HelloFrame | ReplyFrame | ReactFrame | PostFrame | HistoryFrame | PingFrame;`
   - `export type ServerFrame = WelcomeFrame | MessageFrame | ResultFrame | HistoryResultFrame | StatusFrame | PongFrame | ErrorFrame;`
   - `export const PROTOCOL_VERSION = 1;`
   - `export const CLOSE = { GOING_AWAY: 1001, BAD_FRAME: 4000, UNAUTHORIZED: 4001, UNSUPPORTED_PROTOCOL: 4002, REPLACED: 4003, HANDSHAKE_TIMEOUT: 4004, IDLE: 4005 } as const;`
     (Decision 9 close-code table).
   - A `ResultError` type for `error`: `'not_allowed' | 'invalid' | 'rate_limited' | \`slack:${string}\`` (Decision 7).
2. **`src/protocol/parse.ts`.**
   - `export class ProtocolError extends Error {}` (message says what failed,
     e.g. `"reply.threadTs must be a string"`).
   - `parseClientFrame(text: string): ClientFrame` and
     `parseServerFrame(text: string): ServerFrame`: `JSON.parse` (a
     `SyntaxError` becomes `ProtocolError`), require a plain object with a
     string `type`, dispatch on `type` to a per-frame checker, and throw
     `ProtocolError` for an unknown type or a type from the other direction
     (`parseClientFrame` rejects `welcome`; `parseServerFrame` rejects `hello`).
   - Per-frame checks match the schema field for field: required fields
     present with the right JSON type; enums (`role`, `kind`, `origin`,
     `slack`); integers where the schema says integer (`protocol`, `seq`,
     `limit`, `code`); `kind: 'thread'` requires `threadTs`; `ok: false`
     requires `error`. Unknown extra fields are ignored and not copied
     (see Notes).
   - `hello.protocol` accepts any integer ≥ 1, so the session can tell an
     unsupported protocol (`4002`, Decision 9) from a malformed frame (`4000`).
     `welcome.protocol` must be `1`.
   - Return a new object containing only the known fields, typed as the frame.
   - The parser does **not** check `maxFrameBytes` or `limit ≤ historySize`;
     both depend on config, so the session (001-6) checks them.
3. **`protocol/schema/frame.schema.json`**, JSON Schema 2020-12
   (`"$schema": "https://json-schema.org/draft/2020-12/schema"`):
   - `$defs` for each frame, `relayMessage`, `clientFrame` (`oneOf` the six
     client frames), and `serverFrame` (`oneOf` the seven server frames).
     The root is `oneOf: [clientFrame, serverFrame]`.
   - Each frame def has `type: object`, `type` as a `const`, `required`
     listing its required fields, and matching JSON types. Integers:
     `protocol` (hello: `minimum: 1`; welcome: `const: 1`), `seq`
     (`minimum: 0` in `resume`, `minimum: 1` in `message`), `limit`
     (`minimum: 1`), `error.code`.
   - `message` and `relayMessage`: `if kind = thread then required threadTs`.
     `result`: `if ok = false then required error`; `error` matches
     `^(not_allowed|invalid|rate_limited|slack:.+)$`.
   - No `additionalProperties: false` (Decision 14: adding an optional field
     stays protocol 1, so readers must tolerate unknown fields).
4. **Fixtures** under `protocol/fixtures/`, one JSON frame per file, using
   realistic values from the Decision 9 examples (`C0123ABC`, `prk_…` keys,
   `"1732291200.000100"`-style ts):
   - `valid/`:
     `hello.json` (no resume), `hello-resume.json`, `hello-viewer.json`,
     `welcome.json` (`resumed: true`), `welcome-not-resumed.json`,
     `message-channel.json`, `message-thread.json`,
     `message-bot.json` (`botId`, no `user`, `fromSelf: true`),
     `message-relay-origin.json` (`origin: "relay"`, `eventId: "relay:<ts>"`, Decision 8),
     `reply.json`, `react.json`, `post.json`, `post-thread.json`,
     `history.json` (with `limit`), `history-no-limit.json`,
     `result-ok.json` (with `ts`), `result-ok-no-ts.json` (a `react`'s result),
     `result-error.json` (`"error": "not_allowed"`),
     `result-error-slack.json` (`"error": "slack:channel_not_found"`),
     `history-result.json` (two messages, oldest first),
     `history-result-empty.json`,
     `status.json`, `status-shared-app.json` (`slackSharedApp: true`),
     `ping.json`, `pong.json`, `error.json` (`code: 4002`).
   - `invalid/`:
     `not-json.json` (deliberately malformed text), `not-object.json` (`[]`),
     `missing-type.json`, `unknown-type.json` (`"type": "subscribe"`),
     `hello-missing-key.json`, `hello-bad-role.json` (`"role": "admin"`),
     `wrong-protocol-type.json` (hello with `"protocol": "1"`),
     `hello-resume-bad-seq.json` (`"seq": "41"`),
     `welcome-wrong-protocol.json` (`"protocol": 2`),
     `message-bad-kind.json` (`"kind": "dm"`),
     `message-thread-missing-threadts.json`, `message-missing-seq.json`,
     `message-bad-origin.json`, `reply-missing-threadts.json`,
     `react-missing-emoji.json`, `post-missing-text.json`,
     `history-bad-limit.json` (`"limit": 0`),
     `result-error-missing-error.json` (`ok: false`, no `error`),
     `result-bad-error.json` (`"error": "boom"`),
     `status-bad-slack.json` (`"slack": "maybe"`),
     `error-missing-code.json`.
5. **`protocol/VERSION`**: the single line `1`.
6. **`protocol/README.md`**, the reference for client authors (ProPager's
   `RelayClient`, mps-propager Spec 004), headed "Protocol 1":
   transport (one WebSocket, JSON text frames, `maxFrameBytes` default
   65,536, bad frame → `4000`); handshake (`hello` first, `handshakeTimeoutMs`
   → `4004`, key match → `4001`, protocol ≠ 1 → `error` then `4002`, with the
   two Decision 9 examples); the frame table; `id` semantics (client-chosen,
   unique per connection, echoed in `result`/`history_result`); `result`
   error values (Decision 7); the close-code table with "Client should";
   one live connection per site (`4003`); app-level `ping`/`pong` at least
   every 30 s and idle close `4005`; resume (Decision 10: `epoch`, `seq`,
   `resumed`); the schema and fixtures layout; and the versioning rule from
   Decision 14 (optional fields / ignorable frames stay protocol 1, fixture
   changes are called out in release notes). State that clients ignore
   unknown fields.
7. **`test/protocol/fixtures.test.ts`.**
   - Load the schema with `ajv/dist/2020` (`new Ajv2020({ allErrors: true })`)
     and compile it once.
   - Read every file in `protocol/fixtures/valid/` (generated `it.each`).
     The direction comes from the frame's `type` field, not the file name.
     For each: `JSON.parse` succeeds; ajv validates; the parser for its
     direction returns a frame with the same `type` (client types →
     `parseClientFrame`, server types → `parseServerFrame`); and the
     **other** parser throws `ProtocolError`.
   - For every file in `protocol/fixtures/invalid/`: ajv rejects it (or
     `JSON.parse` fails), and **both** parsers throw `ProtocolError`.
   - Coverage check: the set of `type`s across `valid/` equals every member
     of `ClientFrame` and `ServerFrame` (13 types), so a new frame type can't
     ship without a fixture.
   - `protocol/VERSION` trimmed equals `String(PROTOCOL_VERSION)`.
8. **`test/protocol/parse.test.ts`** (small, direct cases the fixtures don't cover):
   - `parseClientFrame('{"type":"hello","protocol":2,...}')` succeeds with
     `protocol === 2` (the session decides `4002`).
   - Unknown extra fields are accepted and absent from the returned object.
   - Text that isn't JSON (`'{'`) → `ProtocolError`, not `SyntaxError`.
   - `CLOSE` values match Decision 9's table.

## Acceptance Criteria

- [ ] `src/protocol/types.ts` exports `RelayMessage`, every frame interface,
      `ClientFrame`, `ServerFrame`, `PROTOCOL_VERSION`, and `CLOSE` with the
      plan's exact names and values.
- [ ] `src/protocol/parse.ts` exports `parseClientFrame`, `parseServerFrame`,
      and `ProtocolError`; both parsers throw only `ProtocolError` for any
      bad input (bad JSON, non-object, unknown or wrong-direction type,
      missing/mistyped field).
- [ ] `hello` with any integer `protocol ≥ 1` parses; `welcome` requires `protocol: 1`.
- [ ] `frame.schema.json` is JSON Schema 2020-12, `oneOf` every frame by
      `type`, and does not forbid additional properties.
- [ ] `protocol/fixtures/valid/` has at least one fixture per frame type
      (13 types), including `message-channel`, `message-thread`,
      `result-ok`, and `result-error`.
- [ ] `protocol/fixtures/invalid/` includes at least `hello-missing-key`,
      `message-bad-kind`, `unknown-type`, and `wrong-protocol-type`.
- [ ] Every valid fixture passes ajv and its direction's parser, and fails
      the other direction's parser; every invalid fixture fails ajv (or
      JSON parsing) and both parsers.
- [ ] `protocol/VERSION` is `1`; `protocol/README.md` documents every frame,
      every close code, resume, and the Decision 14 versioning rule.
- [ ] `ajv` is used only in tests; nothing under `src/` imports it.
- [ ] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.

## Files Changed

| File | Action |
|---|---|
| protocol/README.md | Create |
| protocol/VERSION | Create |
| protocol/schema/frame.schema.json | Create |
| protocol/fixtures/valid/*.json (26 files listed in step 4) | Create |
| protocol/fixtures/invalid/*.json (21 files listed in step 4) | Create |
| src/protocol/types.ts | Create |
| src/protocol/parse.ts | Create |
| test/protocol/fixtures.test.ts | Create |
| test/protocol/parse.test.ts | Create |

## Verification

1. `pnpm test test/protocol` passes, with one generated case per fixture file.
2. `pnpm typecheck` passes.
3. `pnpm build` passes; `dist/protocol/types.d.ts` and `dist/protocol/parse.d.ts` exist.
4. `grep -rn "ajv" src/` returns nothing.
5. Break a fixture by hand (e.g. delete `threadTs` from
   `valid/message-thread.json`): the test fails for both ajv and the parser.
   Revert.
## Notes

- **`error.code` type.** Decision 9 lists `code` and `message` for `error`
  without a type. This task makes `code` an integer: the close code that
  follows (e.g. `4002`). That's the simplest choice and gives clients one
  vocabulary.
- **Unknown fields are tolerated; unknown types are not.** Decision 14 says
  an optional field keeps protocol 1, so the schema and parser accept extra
  fields. The relay's `parseClientFrame` rejects an unknown `type` (Decision 9:
  a frame that doesn't validate closes with `4000`), and `unknown-type.json`
  is invalid. Decision 14 also says a new frame type "clients may ignore"
  stays protocol 1, so the README tells **clients** to ignore unknown server
  frame types rather than treat them as errors, even though `parseServerFrame`
  (used only by tests and `dev:site`) rejects them.
- **Numeric bounds** (`seq ≥ 1` in `message`, `seq ≥ 0` in `resume`,
  `limit ≥ 1`) aren't in the spec; they're the simplest bounds consistent
  with "monotonic `seq`" and "last `seq` the client processed". The upper
  bound on `limit` (`≤ historySize`) is config-dependent and left to 001-6.
- **File placement.** The plan's interface block lists the parse functions
  under the `src/protocol/types.ts` heading; the Spec File Plan puts them in
  `src/protocol/parse.ts`. This task follows the File Plan: types and `CLOSE`
  in `types.ts`, parsers and `ProtocolError` in `parse.ts`.
- **`kind: 'channel'` with a `threadTs`** is not rejected (the spec only says
  `threadTs` is set when `kind === 'thread'`). Normalizing never produces it.
