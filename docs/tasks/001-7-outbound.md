# Task 001-7: Outbound (per-thread FIFO, results, relay-originated posts)

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Complete
**Parallel group:** Wave 3 (parallel with [001-5](001-5-router.md), [001-6](001-6-sessions.md), [001-9](001-9-socket-mode.md) — disjoint files)
**Depends on:** [001-2](001-2-protocol.md), [001-3](001-3-config-keys.md), [001-4](001-4-slack-api.md)
**Blocks:** [001-10](001-10-relay-assembly.md)

## What

Build `src/core/outbound.ts`: the only path from a client's `reply`, `react`,
or `post` to Slack (Spec 001 Decisions 7 and 8). `createOutbound` checks that
the request is allowed for the caller's `Principal` (role, channel,
`canPost`) and answers `not_allowed` without touching Slack if not. It
serializes allowed requests per thread, ported from mps-propager Spec 003
Decision 9 and `SlackClient::postThreadReply`: one request in flight per key
(`channel` + `threadTs`, or `channel` alone for a top-level post), the next
starting when the previous settles, success or failure. It maps every
outcome to exactly one `ResultFrame` (`ok`, `ts?`, or `not_allowed` /
`invalid` / `rate_limited` / `slack:<code>`). When a viewer's `post`
succeeds, it builds a `RelayMessage` from the API response and calls
`onRelayPost`, so 001-10 can route it to the owning site as a page without
waiting for Slack's echo (Decision 8). The 429 / `Retry-After` retries live in
`SlackApi` (001-4); outbound only maps their outcome. Names and signatures
come from the plan's "Interfaces between tasks". It is tested against
`FakeSlackApi` from 001-4, including ordering with deferred responses.

## Steps

1. **Export** from `src/core/outbound.ts`, exactly as the plan:
   `createOutbound(o: { slackApi: SlackApi; config: ResolvedConfig; logger: Logger; onRelayPost(msg: RelayMessage): void })`
   returning `{ request(p: Principal, f: ReplyFrame | ReactFrame | PostFrame): Promise<ResultFrame> }`.
   Import `Principal` as a type from `./session.js` (001-6); if 001-6 has not
   landed in your worktree, declare the identical interface locally and
   switch to the import when merging.
2. **Permission check** (Decision 7 table), before anything else. Any failure
   resolves `{ type: 'result', id: f.id, ok: false, error: 'not_allowed' }`
   immediately, with a debug log, and never queues or calls Slack:
   - `reply` and `react` require `p.role === 'site'`.
   - `post` requires `p.role === 'viewer'` and `p.canPost`.
   - `f.channel` must be in `p.channels`.
3. **Validation:** after the permission check, an empty `text` (`reply`,
   `post`), or an empty `ts` or `emoji` (`react`), resolves
   `{ ok: false, error: 'invalid' }` without calling Slack (Notes).
4. **Queue key** (Decision 7):
   - `reply` → `` `${channel}:${threadTs}` ``.
   - `post` with `threadTs` → `` `${channel}:${threadTs}` ``; without →
     `channel`.
   - `react` → `` `${channel}:${ts}` `` (Notes).
5. **Per-key FIFO.** Keep `Map<string, Promise<void>>` of each key's tail.
   `request` chains the new job onto the tail (`tail.then(run, run)`), so it
   starts only after the previous job settles, and stores the new tail.
   Delete the map entry when the job that settles is still the tail, so the
   map doesn't grow forever. Different keys never wait on each other. A job
   never rejects the chain: every outcome is caught inside it.
6. **The Slack call** (inside the job):
   - `reply` → `slackApi.postMessage({ channel, text, threadTs })` → `{ ok: true, ts }`.
   - `post` → `slackApi.postMessage({ channel, text, threadTs? })` → `{ ok: true, ts }`.
   - `react` → `slackApi.addReaction({ channel, ts, emoji })` → `{ ok: true }`.
     `already_reacted` already resolves in `SlackApi` (001-4).
   `unfurl_links: false` is set by `SlackApi.postMessage` (001-4).
7. **Error mapping** (Decision 7 "Results"), on rejection:
   - `SlackApiError` with `code === 'rate_limited'` → `error: 'rate_limited'`
     (`SlackApi` already retried 3 times).
   - Any other `SlackApiError` → `` `slack:${code}` `` (e.g.
     `slack:channel_not_found`, `slack:network`).
   - Anything else → `slack:unknown`, logged at `error` with the stack.
   Log every failure at `warn` with the request type, channel, and code (not
   the text).
8. **Relay-originated post** (Decision 8): when a `post` succeeds, build
   ```ts
   {
     eventId: `relay:${ts}`, channel, ts, text,
     kind: threadTs ? 'thread' : 'channel',
     ...(threadTs ? { threadTs } : {}),
     fromSelf: false,
     origin: 'relay',
   }
   ```
   with no `user` and no `botId`, and call `o.onRelayPost(msg)` before
   resolving the result. If `onRelayPost` throws, log the error and still
   resolve `{ ok: true, ts }`. `reply` and `react` never call it.
9. **Tests** in `test/core/outbound.test.ts` with `FakeSlackApi` from 001-4
   (`test/fakes/`), using its recorded calls and its scripted / deferred
   responses. If the fake can't defer a response yet, add a small
   "resolve the next call to `<method>` later" hook to it in this task and
   note it in the commit. Config via `validateConfig`: site `north` on
   `C0NORTH`, site `south` on `C0SOUTH`, viewer `portal` on `'*'` with
   `canPost: true`, viewer `wall` on `['C0NORTH']` with `canPost: false`.
   Principals are built by hand. Cases under Verification.

## Acceptance Criteria

- [x] `createOutbound` matches the plan's signature exactly.
- [x] `reply`/`react` from a viewer, `post` from a site, `post` from a viewer
      without `canPost`, and any request for a channel outside
      `principal.channels` resolve `not_allowed` and make no `SlackApi` call.
- [x] `reply` calls `postMessage` with `threadTs`; `post` calls it with
      `threadTs` only when given; `react` calls `addReaction`; successful
      posts resolve `{ ok: true, ts }` and reactions `{ ok: true }`.
- [x] Requests with the same key run one at a time in request order; the next
      starts only after the previous resolves or rejects. Requests with
      different keys run concurrently.
- [x] `SlackApiError('rate_limited')` → `rate_limited`; any other
      `SlackApiError` → `slack:<code>`; a non-`SlackApiError` →
      `slack:unknown`. A failure doesn't block the next request on that key.
- [x] Every request resolves exactly one `ResultFrame` with its `id`;
      `request` never rejects.
- [x] A successful viewer `post` calls `onRelayPost` once with
      `origin: 'relay'`, `eventId: 'relay:<ts>'`, `fromSelf: false`, no
      `user`/`botId`, and `kind`/`threadTs` matching the request. A failed
      post, a `reply`, or a `react` never calls it.
- [x] `src/core/outbound.ts` imports no HTTP or WebSocket library and never
      calls `fetch` directly.
- [x] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.

## Files Changed

| File | Action |
|---|---|
| src/core/outbound.ts | Create |
| test/core/outbound.test.ts | Create |
| test/fakes/fake-slack-api.ts | Modify, only if 001-4's deferred-response hook doesn't cover these tests |

## Verification

```
pnpm test test/core/outbound.test.ts
pnpm typecheck && pnpm build && pnpm test
grep -nE "fetch\(|from '(h3|crossws|ws|node:http)'" src/core/outbound.ts   # no output
```

`outbound.test.ts` covers:

1. **Reply:** `north` replies in `C0NORTH` thread `1.0` → one `postMessage`
   `{ channel: 'C0NORTH', text, threadTs: '1.0' }`; result
   `{ id, ok: true, ts }` with the fake's `ts`.
2. **React:** `north` reacts `eyes` on `1.0` → one `addReaction`; result
   `{ ok: true }` with no `ts`.
3. **not_allowed:** `north` replies in `C0SOUTH`; `portal` sends `reply`;
   `north` sends `post`; `wall` posts in `C0NORTH`; `portal` posts in
   `C0OTHER` → all `not_allowed`, the fake records no calls.
4. **invalid:** `reply` with `text: ''` → `invalid`, no call.
5. **Order per thread:** defer the first `postMessage`; send replies A1, A2,
   A3 to thread `1.0`. While A1 is pending, the fake has recorded one call.
   Resolve it → A2 is called, then A3. Recorded texts are A1, A2, A3 and the
   results resolve in that order.
6. **Failure doesn't block:** the first call rejects with
   `SlackApiError('channel_not_found')` → result `slack:channel_not_found`;
   the second reply in that thread is still sent, and the first isn't resent.
7. **Threads independent:** defer thread `1.0`'s first reply, send `1.0`-A1,
   `1.0`-A2, then `2.0`-B1 → B1 is recorded before A2.
8. **Reaction after a reply:** defer a reply in thread `1.0`, then react on
   `1.0` → the reaction waits for the reply (same key).
9. **Top-level posts:** two `portal` posts to `C0NORTH` without `threadTs`
   share a queue; a post with `threadTs: '1.0'` shares the reply queue for
   that thread.
10. **Error mapping:** `SlackApiError('rate_limited')` → `rate_limited`;
    `SlackApiError('network')` → `slack:network`; a plain `Error` →
    `slack:unknown`.
11. **Relay post:** `portal` posts `5678` to `C0NORTH` → `onRelayPost` gets
    `{ eventId: 'relay:<ts>', channel: 'C0NORTH', ts, text: '5678', kind: 'channel', fromSelf: false, origin: 'relay' }`
    with no `threadTs`/`user`/`botId`; with `threadTs: '1.0'` →
    `kind: 'thread'`, `threadTs: '1.0'`. A failed post and a `north` reply
    → no call. An `onRelayPost` that throws → result still `ok: true`.

## Notes

- **`fromSelf: false` on relay-originated posts.** The post was made with the
  bot token, but Decision 8 routes it to the site as a page. 001-5's echo
  filter drops `fromSelf` messages and, before `auth.test`, any message with
  a `botId`. So the message is built with `fromSelf: false` and without
  `user`/`botId`, and both rules let it through. `origin: 'relay'` is what
  marks it. Slack's later echo has the bot's ids, so the echo filter drops it
  for sites, and viewers see it with `fromSelf: true` (001-5 sends
  `origin: 'relay'` messages to the site only, so viewers don't see the post
  twice).
- **`react` queue key.** Decision 7 keys the FIFO by `channel` +
  `thread_ts`, but a `react` frame carries only the message `ts`. Keying it
  by `` `${channel}:${ts}` `` puts a reaction on a thread's parent (what
  ProPager does: ✅ / ⚠️ on the requesting message) in the same queue as that
  thread's replies, so it can't overtake an earlier reply.
- **`invalid`.** The spec lists the code but not when to use it. Here it means
  a frame that parsed but can't be sent: empty `text`, `ts`, or `emoji`. If
  001-2's parser already rejects empty strings, this check is a backstop.
- **`slack:network` and `slack:unknown`.** `SlackApiError.code` can be
  `'network'` (001-4), and the spec's error list has no separate code for
  it, so it maps to `slack:network`. A non-`SlackApiError` exception (a bug)
  becomes `slack:unknown`, so every request still gets one result.
- **Implementation notes (001-7).** `session.ts` (001-6) hadn't landed in this
  worktree, so `outbound.ts` declares an identical, unexported `Principal`
  with a `TODO(001-6)` to switch to `import type { Principal } from
  './session.js'` at merge. The test derives `Principal` from
  `createOutbound`'s signature, so it needs no change either way.
  `FakeSlackApi` was not modified: its scripted async-function responses
  already let a test hold a call open. `config` is accepted (plan signature)
  but unused: permissions come from the `Principal`.
