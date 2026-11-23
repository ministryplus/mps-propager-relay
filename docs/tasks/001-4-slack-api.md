# Task 001-4: Slack Web API client (fetch, 429 handling, FakeSlackApi)

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Complete
**Parallel group:** Wave 2 (parallel with [001-2](001-2-protocol.md), [001-3](001-3-config-keys.md), [001-8](001-8-events-api.md) — disjoint files: `src/core/slack-api.ts`, `test/fakes/fake-slack-api.ts`, its tests)
**Depends on:** [001-1](001-1-scaffold.md)
**Blocks:** [001-7](001-7-outbound.md), [001-9](001-9-socket-mode.md)

## What

Give the relay its only path to Slack's Web API (plan: "Nothing reaches Slack
except through `SlackApi`"). `src/core/slack-api.ts` defines the `SlackApi`
interface and `SlackApiError` exactly as in the plan's "Interfaces between
tasks", and a fetch-based implementation, `createSlackApi`, for the five
calls the relay makes: `auth.test` (Decision 6), `chat.postMessage` and
`reactions.add` (Decision 7), `conversations.history` (Decision 11), and
`apps.connections.open` (Decision 4). It sends the bot token as a bearer
token (the app token only for `apps.connections.open`), always sets
`unfurl_links: false` on `chat.postMessage`, treats `already_reacted` as
success, and on HTTP 429 pauses that method for `Retry-After` seconds and
retries the same request, up to 3 times, before failing with
`SlackApiError('rate_limited')` (Decision 7). The base URL is injectable so
the real client is tested against a local `node:http` server.
`test/fakes/fake-slack-api.ts` adds `FakeSlackApi`, an in-memory `SlackApi`
that records calls and can be scripted to answer, fail, or hold, for 001-7,
001-9, 001-10, and 001-11. Slack's own types come from `@slack/types` with
`import type` only, and never appear in the public types (Decision 1).

## Steps

1. **Interface and error**, plan signatures exactly:
   ```ts
   export interface SlackApi {
     authTest(): Promise<BotIdentity>;   // export interface BotIdentity { userId: string; botId: string }
     postMessage(a: { channel: string; text: string; threadTs?: string }): Promise<{ ts: string }>;
     addReaction(a: { channel: string; ts: string; emoji: string }): Promise<void>;
     history(a: { channel: string; limit: number }): Promise<SlackHistoryMessage[]>;
     openSocketModeUrl(appToken: string): Promise<string>;
   }
   export class SlackApiError extends Error {
     constructor(readonly code: string, message?: string) { … }  // name = 'SlackApiError'
   }
   ```
   `code` is Slack's `error` field (`channel_not_found`, `invalid_auth`, …),
   `'rate_limited'`, or `'network'`.
2. **`SlackHistoryMessage`**, the relay's own type (the plan names it but
   doesn't define it). It keeps Slack's field names so 001-10 can hand a
   history message to `normalize` as an `event`:
   ```ts
   export type SlackHistoryMessage = {
     type?: string; subtype?: string; ts: string; text?: string;
     user?: string; bot_id?: string; thread_ts?: string;
   };
   ```
   A `type` alias (not an `interface`) so it's assignable to
   `Record<string, unknown>`. `history()` returns the messages in Slack's
   order (newest first); 001-10 reverses them for the ring.
3. **`createSlackApi(options): SlackApi`** with
   `options = { botToken: string; baseUrl?: string; sleep?: (ms: number) => Promise<void>; now?: () => number; timeoutMs?: number }`.
   Defaults: `baseUrl` `https://slack.com/api/`, `sleep` a `setTimeout`
   promise, `now` `Date.now`, `timeoutMs` `10_000`. `sleep` and `now` are
   test seams for the rate-limit pause.
4. **One private `call(method, params, { token, encoding })`** used by every method:
   - `POST ${baseUrl}${method}` with `Authorization: Bearer <token>`.
   - Body encoding: JSON (`application/json; charset=utf-8`) for
     `chat.postMessage` and `reactions.add`;
     `application/x-www-form-urlencoded` for `auth.test`,
     `conversations.history`, and `apps.connections.open` (Slack's read
     methods don't all accept JSON bodies).
   - `signal: AbortSignal.timeout(timeoutMs)`.
   - **Rate-limit pause per method.** Keep `pausedUntil: Map<method, number>`.
     Before each attempt, if `now() < pausedUntil(method)`, `await
     sleep(pausedUntil - now())`, so other calls to the same method wait
     too while the pause lasts. Other methods aren't paused.
   - **HTTP 429:** read `Retry-After` (seconds; missing or unparseable → 1),
     set `pausedUntil(method) = now() + seconds * 1000`, and retry the same
     request. After the 3rd retry (4 attempts in total) also answers 429,
     throw `SlackApiError('rate_limited')`.
   - Fetch rejection (connection refused, DNS, timeout/abort), any other
     non-2xx status, or a body that isn't JSON → `SlackApiError('network')`
     with the cause in the message. Not retried.
   - JSON `ok: false` → `SlackApiError(body.error ?? 'unknown_error')`. Not retried.
   - JSON `ok: true` → return the body to the method.
5. **The five methods:**
   - `authTest()`: `auth.test` with the bot token → `{ userId: user_id, botId: bot_id }`.
     A response missing `user_id` or `bot_id` → `SlackApiError('network')`.
   - `postMessage({ channel, text, threadTs })`: `chat.postMessage` with the
     bot token, body `{ channel, text, unfurl_links: false }` plus
     `thread_ts: threadTs` when given (Decision 7 table) → `{ ts }`.
   - `addReaction({ channel, ts, emoji })`: `reactions.add` with the bot
     token, body `{ channel, timestamp: ts, name: emoji }`. `ok: false` with
     `error: 'already_reacted'` resolves (Decision 7).
   - `history({ channel, limit })`: `conversations.history` with the bot
     token, `channel` and `limit` → `messages`, each mapped to
     `SlackHistoryMessage` (only the listed fields copied).
   - `openSocketModeUrl(appToken)`: `apps.connections.open` with
     `Authorization: Bearer <appToken>` (not the bot token) → `url`.
6. **Slack types stay internal (Decision 1).** Use `@slack/types` only with
   `import type`, and only where it has a fitting shape (e.g. a message
   event type). `@slack/types` is mostly event and Block Kit types; Web API
   *response* shapes live in `@slack/web-api`, which isn't used, so declare
   small non-exported response interfaces (`{ ok: boolean; error?: string; ts?: string; … }`)
   in this file where needed. No exported type (`SlackApi`,
   `SlackHistoryMessage`, `SlackApiError`, the options type) may reference
   an `@slack/types` type, because `SlackApi` becomes public through
   `createRelay({ slackApi })` (Decision 12).
7. **`test/fakes/fake-slack-api.ts`**: `class FakeSlackApi implements SlackApi`.
   - `calls: { method: keyof SlackApi; args: unknown }[]`, appended in call order
     before the response is produced, plus `callsTo(method)` to filter.
   - Default answers: `authTest` → `{ userId: 'U_BOT', botId: 'B_BOT' }`;
     `postMessage` → `{ ts }` with an increasing fake ts
     (`'1700000000.000001'`, `…002`, …); `addReaction` → resolves;
     `history` → `[]`; `openSocketModeUrl` → `'ws://127.0.0.1:0/fake'`.
   - Scripting: `script(method, ...responses)` queues one-shot responses
     used in order before falling back to the default. A response is a
     value, an `Error` (rejected, e.g. `new SlackApiError('channel_not_found')`),
     or a function `(args) => Promise<…>` so a test can hold a call open
     with a deferred promise (001-7's per-thread FIFO tests need that).
   - `setHistory(channel, messages)` for 001-10's backfill tests.
   - No timers, no network.
8. **`test/core/slack-api.test.ts`** against a local fake Slack:
   - `beforeAll` starts a `node:http` server on port 0 (`127.0.0.1`) that
     records each request (path, headers, raw body) and answers from a
     per-path queue of scripted responses (status, headers, JSON body),
     defaulting to `{ ok: true }`. Tests pass
     `baseUrl: \`http://127.0.0.1:${port}/api/\``. `afterAll` closes it.
   - **Auth:** `postMessage` sends `Authorization: Bearer xoxb-test`;
     `openSocketModeUrl('xapp-test')` sends `Bearer xapp-test` and returns
     the scripted `url`.
   - **postMessage body:** JSON with `channel`, `text`, `unfurl_links: false`,
     and `thread_ts` only when `threadTs` was given; returns `ts`.
   - **addReaction:** body has `channel`, `timestamp`, `name`;
     `{ ok: false, error: 'already_reacted' }` resolves;
     `{ ok: false, error: 'channel_not_found' }` rejects with
     `SlackApiError` whose `code` is `channel_not_found`.
   - **authTest:** maps `user_id`/`bot_id` to `userId`/`botId`.
   - **history:** sends `channel` and `limit` form-encoded; returns the
     messages in Slack's order with only the listed fields.
   - **429 then success:** first answer 429 with `Retry-After: 2`, second
     `ok: true`. The call resolves; the server saw two identical requests;
     the injected `sleep` was called with `2000`.
   - **429 exhausted:** four 429s → `SlackApiError('rate_limited')` after
     exactly 4 requests.
   - **Missing `Retry-After`:** pauses 1000 ms.
   - **Pause is per method:** while `chat.postMessage` is paused (injected
     `sleep` held open by a deferred promise), a second `postMessage` waits
     (no request reaches the server) but an `addReaction` goes through.
   - **Network errors:** a closed port → `SlackApiError('network')`; HTTP
     500 → `'network'`; a non-JSON body → `'network'`; a server that never
     answers with `timeoutMs: 50` → `'network'`.
9. **`test/fakes/fake-slack-api.test.ts`** (short): default answers, scripted
   values and errors used once and in order, a held function response, and
   `calls` recorded in order.

## Acceptance Criteria

- [x] `SlackApi`, `SlackApiError` (`code`), and `SlackHistoryMessage` are
      exported from `src/core/slack-api.ts` with the plan's signatures;
      `createSlackApi` returns a `SlackApi`.
- [x] Every call uses `Authorization: Bearer <bot token>`, except
      `apps.connections.open`, which uses the app token passed in.
- [x] `chat.postMessage` always sends `unfurl_links: false`, and
      `thread_ts` only when given.
- [x] `reactions.add` answering `already_reacted` resolves; other
      `ok: false` answers reject with `SlackApiError(<Slack error>)`.
- [x] HTTP 429 pauses that method for `Retry-After` seconds and retries the
      same request up to 3 times, then rejects with
      `SlackApiError('rate_limited')`; other methods aren't paused.
- [x] Transport failures, non-2xx (non-429) statuses, non-JSON bodies, and
      timeouts reject with `SlackApiError('network')` and aren't retried.
- [x] The base URL, `sleep`, `now`, and timeout are injectable; the tests use
      a local `node:http` server and never reach slack.com.
- [x] `@slack/types` is imported only with `import type`, and no file in
      `dist/` references `@slack/types` after `pnpm build`.
- [x] `FakeSlackApi` implements `SlackApi`, records every call in order, and
      supports scripted values, errors, and held (deferred) responses.
- [x] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.

## Files Changed

| File | Action |
|---|---|
| src/core/slack-api.ts | Create |
| test/fakes/fake-slack-api.ts | Create |
| test/fakes/fake-slack-api.test.ts | Create |
| test/core/slack-api.test.ts | Create |

## Verification

1. `pnpm test test/core/slack-api test/fakes` passes.
2. `pnpm typecheck` passes.
3. `pnpm build`, then `grep -rn "@slack/types" dist/` returns nothing
   (Decision 1: the emitted `.d.ts` never references it).
4. `grep -rn "@slack/types" src/ | grep -v "import type"` returns nothing.
5. Run the tests with networking off (or confirm no request goes to
   `slack.com`): every request in `test/core/slack-api.test.ts` hits `127.0.0.1`.

## Notes

- **`SlackHistoryMessage` was undefined in the plan.** This task defines it
  as the relay's own type with Slack's field names (step 2), returned newest
  first as Slack sends them. The implementing commit adds it to the plan's
  "Interfaces between tasks" section.
- **Errors outside Slack's `error` field.** The plan allows only Slack's
  `error`, `'rate_limited'`, or `'network'` as codes, so non-429 HTTP errors,
  non-JSON bodies, and malformed `auth.test` responses all map to
  `'network'`. 001-7 turns `'network'` into `slack:network` in a `result`
  (Decision 7's `slack:<code>`); flag if a separate code is wanted.
- **Request timeout (10 s) isn't in the spec.** Without one, a hung request
  would stall its per-thread FIFO forever (Decision 7); ProPager's
  `SlackClient` uses a transfer timeout for the same reason.
- **Missing `Retry-After` → 1 s.** The spec doesn't say what to do without
  the header; 1 s is the smallest sensible pause.
- **Retry count.** "Retry the same request, up to 3 times" is read as 3
  retries after the first attempt (4 requests in total).
- **Body encoding.** Form encoding for the read methods and
  `apps.connections.open` is the safe choice; JSON for the two write methods
  keeps `unfurl_links: false` a real boolean.
- **Implementation notes (001-4).**
  - `@slack/types` turned out not to be needed: no event or Block Kit shape
    fits a Web API response, so `slack-api.ts` uses a small internal
    `SlackResponse` interface and imports nothing from it. The `import type`
    criterion holds trivially; `grep -rn "@slack/types" dist/ src/` is empty.
  - The plan already listed `SlackHistoryMessage` and `BotIdentity` in
    "Interfaces between tasks", so the plan wasn't edited.
  - Gaps filled: `chat.postMessage` without a `ts` and
    `apps.connections.open` without a `url` reject with `'network'` (same
    rule as a malformed `auth.test`). `history` treats a missing `messages`
    as `[]` and drops non-object entries.
  - The options type is exported as `SlackApiOptions`.
  - `FakeSlackApi.history` returns `setHistory`'s messages sliced to
    `limit`. `script()` and `setHistory()` return `this` so calls can be chained.
