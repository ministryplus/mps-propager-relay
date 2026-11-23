# Task 001-5: Router (normalize, dedupe, age, echo filter, routing)

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Pending
**Parallel group:** Wave 3 (parallel with [001-6](001-6-sessions.md), [001-7](001-7-outbound.md), [001-9](001-9-socket-mode.md) — disjoint files)
**Depends on:** [001-2](001-2-protocol.md), [001-3](001-3-config-keys.md)
**Blocks:** [001-10](001-10-relay-assembly.md)

## What

Build the path every inbound Slack message takes before it reaches a client
(Spec 001 Decisions 5 and 6). `src/core/normalize.ts` turns a Slack `message`
event into a `RelayMessage`: it keeps only the allowed subtypes, applies the
thread rule ported from ProPager's `SlackClient::onSocketFrame`
(`thread_ts` present and different from `ts`, which deliberately includes
`thread_broadcast`), and sets `fromSelf` from the bot identity, ported from
`SlackClient::isOwnMessage`. `src/core/router.ts` adds `createRouter`, which
drops messages outside the configured channels, drops Slack's retries with an
`event_id` LRU, sends stale messages to viewers only, applies the echo filter
for sites (including "drop every `bot_id` message until `setBotIdentity`"),
and hands each message to the owning site and to viewers through the
`Delivery` interface. Both files use the exact names and signatures from the
plan's "Interfaces between tasks". The router knows nothing about sockets or
sessions: it is tested with a recording fake `Delivery` and an injected
clock. Nothing is wired yet; `createRelay` (001-10) connects ingress →
`router.ingest`, `router` → session hub, and `outbound.onRelayPost` →
`router.route`.

## Steps

1. **`BotIdentity`.** Import it as a type from `src/core/slack-api.ts`, where
   task 4 defines it as what `SlackApi.authTest()` resolves to
   (`{ userId: string; botId: string }`). `normalize.ts` and `router.ts` both
   import it from there.
2. **`normalize(e, botIdentity)`** in `src/core/normalize.ts`, with the plan's
   signature
   `normalize(e: { eventId: string; event: Record<string, unknown> }, botIdentity: BotIdentity | null): RelayMessage | null`.
   Port `SlackClient::extractMessageEvent` minus the channel check (Notes):
   - Return `null` unless `event.type === 'message'`.
   - Return `null` unless `subtype` is absent or one of `thread_broadcast`,
     `file_share`, `bot_message` (Decision 5 table). Everything else
     (`message_changed`, `message_deleted`, `channel_join`, …) is `null`.
   - Return `null` if `channel` or `ts` is not a non-empty string.
   - `text`: `event.text` if a string, else `''` (a `file_share` can lack it).
   - **Thread rule:** read `thread_ts`. If it is a non-empty string and
     differs from `ts`, `kind = 'thread'` and `threadTs = thread_ts`.
     Otherwise `kind = 'channel'` and `threadTs` is left unset (a thread
     parent carrying `thread_ts === ts` is a channel message). Add a comment
     that `thread_broadcast` routes as a thread reply on purpose (mps-propager
     Spec 003 Decision 6).
   - `user` from `event.user`, `botId` from `event.bot_id`, each only when a
     non-empty string.
   - **`fromSelf`** (port of `isOwnMessage`, Decision 6): `true` when
     `botIdentity` is non-null and either `botIdentity.userId` is non-empty
     and equals `user`, or `botIdentity.botId` is non-empty and equals
     `botId`. Guard each id so an empty id never "matches" a missing field.
     With `botIdentity === null`, `fromSelf` is `false`.
   - `eventId` from `e.eventId`, `origin: 'slack'`.
3. **`createRouter(o)`** with the plan's signature
   `createRouter(o: { config: ResolvedConfig; delivery: Delivery; now(): number; logger: Logger })`
   returning `{ setBotIdentity, ingest, route }`. Export the `Delivery`
   interface exactly as in the plan. `ingest` is typed as `SlackEventSink`,
   imported as a type from `./ingress/events-api.js` (001-8, wave 2).
4. **Configured channels.** At creation, build a `Set` of every channel in
   `config.channelOwner` (all site channels) plus every channel listed
   explicitly by a viewer (Notes). `ingest(e)`: if `e.event.channel` is not
   in the set, drop it (debug log with the channel, so a wrong channel id or
   a bot missing from a channel is diagnosable, as ProPager logs today).
   Otherwise call `normalize(e, identity)`; on `null`, drop with a debug log
   naming the type/subtype; else call `route(msg)`.
5. **`setBotIdentity(id)`** stores the identity used by later `ingest` calls.
   Messages already routed are not revisited.
6. **`route(msg)`**, in this order:
   1. **Dedupe** (Decision 5): an LRU keyed by `msg.eventId`, holding ids
      seen in the last 10 minutes, bounded at 5,000. Use a `Map` (insertion
      order). On each call, first evict entries older than 10 min (by
      `now()`) from the front, then: if the id is present, drop the message
      (debug log `duplicate event_id`) and return; else insert it with
      `now()`, evicting the oldest while size > 5,000. A duplicate does not
      refresh its entry. Use named constants `DEDUPE_TTL_MS = 600_000` and
      `DEDUPE_MAX = 5_000`.
   2. **Viewers:** call `delivery.toViewers(msg)` for every message, stale or
      not, `fromSelf` or not (Decision 6 "for viewers: deliver everything").
      Exception: a message with `origin === 'relay'` is not sent to viewers;
      viewers get the Slack echo instead (Decision 8, see Notes). The hub
      (001-6) decides which viewers subscribe to the channel.
   3. **Age** (Decision 5): `ageMs = now() - Number(msg.ts) * 1000`. If
      `ageMs > config.limits.maxEventAgeMs`, stop here (viewers only) and
      debug-log `stale`.
   4. **Echo filter for sites** (Decision 6): stop if `msg.fromSelf`. Also
      stop if no identity has been set yet and `msg.botId` is present ("until
      `auth.test` has succeeded, drop every message that carries a
      `bot_id`"; it can't loop). Debug-log which rule dropped it, like
      ProPager's `ignoring own message` / `ignoring bot message (bot ids
      unknown)`.
   5. **Owning site:** `const site = config.channelOwner.get(msg.channel)`. If
      there is one, `delivery.toSite(site, msg)`. A viewer-only channel has no
      site.
7. **Tests** in `test/core/normalize.test.ts` and `test/core/router.test.ts`.
   Build a `ResolvedConfig` with `validateConfig` (task 3): site `north` on
   `C0NORTH`, site `south` on `C0SOUTH`, viewer `portal` on `'*'`. Use a
   recording fake `Delivery` (`calls: Array<{ to: 'site', site, msg } | { to: 'viewers', msg }>`)
   and an injected clock (`let t = …; now: () => t`). A small helper builds a
   Slack event with `ts` derived from the clock so messages are fresh unless a
   test ages them. Cases under Verification.

## Acceptance Criteria

- [ ] `normalize` and `createRouter` match the plan's signatures exactly;
      `Delivery` is exported from `src/core/router.ts`; `BotIdentity` is imported from `src/core/slack-api.ts`.
- [ ] Only `type: 'message'` with no subtype or `thread_broadcast`,
      `file_share`, `bot_message` produces a `RelayMessage`; every other
      subtype returns `null`.
- [ ] `kind: 'thread'` with `threadTs` exactly when `thread_ts` is present and
      differs from `ts`, including `thread_broadcast`; a parent with
      `thread_ts === ts` is `kind: 'channel'` with no `threadTs`.
- [ ] `fromSelf` is `true` when `user` matches the bot user id or `bot_id`
      matches the bot id, never on an empty id, and `false` with no identity.
- [ ] Messages from channels no site or viewer is configured for never reach
      `Delivery`.
- [ ] A repeated `eventId` within 10 minutes is dropped; after 10 minutes (or
      after 5,000 newer ids) it is accepted again.
- [ ] A message older than `maxEventAgeMs` reaches viewers but not the site.
- [ ] The bot's own messages reach viewers (with `fromSelf: true`) but never
      a site. Before `setBotIdentity`, any message with a `botId` reaches
      viewers but not a site; after it, another bot's message reaches its site.
- [ ] Each message goes to exactly the site that owns its channel and never to
      another site.
- [ ] A `route()`d message with `origin: 'relay'`, `fromSelf: false` and no
      `user`/`botId` reaches the owning site, not viewers, and is subject to
      dedupe and age.
- [ ] `src/core/normalize.ts` and `src/core/router.ts` import no HTTP or
      WebSocket library.
- [ ] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.

## Files Changed

| File | Action |
|---|---|
| src/core/normalize.ts | Create |
| src/core/router.ts | Create |
| test/core/normalize.test.ts | Create |
| test/core/router.test.ts | Create |

## Verification

```
pnpm test test/core/normalize.test.ts test/core/router.test.ts
pnpm typecheck && pnpm build && pnpm test
grep -nE "from '(h3|crossws|ws|node:http)'" src/core/normalize.ts src/core/router.ts   # no output
```

`normalize.test.ts` covers:

1. **Subtypes:** none, `thread_broadcast`, `file_share`, `bot_message` →
   message; `message_changed`, `message_deleted`, `channel_join` → `null`;
   a non-`message` type (`reaction_added`) → `null`.
2. **Thread rule:** no `thread_ts` → `channel`; `thread_ts: "1.0"`,
   `ts: "2.0"` → `thread`, `threadTs: "1.0"`; same plus
   `subtype: thread_broadcast` → `thread`; `thread_ts === ts` → `channel`, no
   `threadTs`.
3. **Fields:** `text`, `ts`, `channel`, `user`, `botId`, `eventId`,
   `origin: 'slack'`; missing `text` → `''`; missing `ts` or `channel` →
   `null`.
4. **`fromSelf`:** user match, bot id match, another bot, identity `null`
   (false), identity with an empty `botId` vs a human message without
   `bot_id` (false).

`router.test.ts` covers:

1. **Routing:** a fresh human message in `C0NORTH` → one `toSite('north')`
   and one `toViewers`; nothing for `south`. Same for `C0SOUTH` → `south`.
2. **Unconfigured channel:** `C0OTHER` → no calls.
3. **Dedupe:** the same `eventId` twice → delivered once. Advance the clock
   by 10 min + 1 ms and send it again (with a fresh `ts`) → delivered. Send
   5,001 distinct ids, then the first again → delivered.
4. **Age:** `ts` 5 min + 1 s before `now()` → `toViewers` only; exactly
   `maxEventAgeMs` old → site too.
5. **Echo filter:** after `setBotIdentity({ userId: 'UBOT', botId: 'BBOT' })`,
   a message from `UBOT` and one with `bot_id: 'BBOT'` → `toViewers` only,
   with `fromSelf: true`; a message with `bot_id: 'BOTHER'` → site and viewers.
6. **Before identity:** with no `setBotIdentity`, a `bot_id: 'BOTHER'`
   message → `toViewers` only; a human message → site and viewers.
7. **Relay-originated:** `route({ origin: 'relay', eventId: 'relay:<ts>', fromSelf: false, … })`
   → `toSite('north')` only; routed twice → once; with an old `ts` → nothing.

## Notes

- **Channel check lives in the router, not `normalize`.** The plan's
  `normalize(e, botIdentity)` has no config parameter, so it cannot know the
  configured channels. `ingest` checks the channel before calling it. Net
  behavior matches Decision 5.
- **"Configured channel"** = every site channel plus every channel a viewer
  lists explicitly. `'*'` viewers add nothing (they mean "every site
  channel"). The spec doesn't say whether a viewer may list a channel no site
  owns; if task 3's `validateConfig` forbids it, the set is just the site
  channels.
- **`BotIdentity`** is defined by task 4 in `slack-api.ts` (the plan's interfaces section lists it there).
- **Relay-originated posts and viewers.** Decision 8 says the echo of a
  viewer's post reaches viewers normally (`fromSelf: true`). If `route()` also
  sent the relay-built message to viewers, every viewer (and the history ring
  in 001-10) would see the post twice. So `route()` sends `origin: 'relay'`
  messages to the site only. The site is not echo-filtered because 001-7
  builds them with `fromSelf: false` and no `user`/`botId`.
- **Age uses Slack's `ts`** (seconds since the epoch, as a decimal string), not
  the time of arrival, as Decision 5 says.
