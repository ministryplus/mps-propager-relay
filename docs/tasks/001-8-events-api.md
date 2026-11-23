# Task 001-8: Events API ingress (signature check, url_verification, 200 then sink)

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Complete
**Parallel group:** Wave 2 (parallel with [001-2](001-2-protocol.md), [001-3](001-3-config-keys.md), [001-4](001-4-slack-api.md) — disjoint files)
**Depends on:** [001-1](001-1-scaffold.md)
**Blocks:** [001-10](001-10-relay-assembly.md)

## What

Build `src/core/ingress/events-api.ts`: the Events API half of Slack ingress
(Spec 001 Decision 4). It takes a raw request body and its headers and
returns `{ status, headers?, body? }`, with no HTTP library, so
`relay.handleSlackEvent` (001-10) and the h3 handler (001-11) are thin
wrappers. It verifies `X-Slack-Signature` (`v0=` + HMAC-SHA256 over
`` `v0:${timestamp}:${rawBody}` `` with the signing secret, compared in
constant time), rejects a timestamp more than 300 s from now, and answers
401 on any failure, logging the reason but never the body. A verified
`url_verification` gets 200 with its `challenge`. A verified `event_callback`
gets 200 **immediately**, and the inner `event` and its `event_id` go to the
`SlackEventSink` from the plan's interfaces only after the response has
resolved, so Slack's 3-second acknowledgement deadline never depends on
routing. Anything else gets 200 and is ignored, so Slack doesn't retry. Retries
of an acknowledged event are absorbed later by the router's dedupe (001-5).
The task depends only on the scaffold. `SlackEventSink` is declared in the
plan, and tests use a recording sink.

## Steps

1. **`SlackEventSink`.** If 001-1 hasn't already put it somewhere shared,
   declare and export it in `src/core/ingress/events-api.ts` exactly as the
   plan:
   `export type SlackEventSink = (e: { eventId: string; event: Record<string, unknown> }) => void;`.
   001-9 and 001-5 import it from here (Notes).
2. **Factory** (Notes):
   ```ts
   export function createEventsApiIngress(o: {
     signingSecret: string;
     sink: SlackEventSink;
     now(): number;          // ms
     logger: Logger;
   }): {
     handle(rawBody: string, headers: Record<string, string | undefined>):
       Promise<{ status: number; headers?: Record<string, string>; body?: string }>;
   };
   ```
3. **Header lookup** is case-insensitive: build a lowercase-keyed copy of
   `headers` once and read `x-slack-signature` and
   `x-slack-request-timestamp` from it (h3 lowercases, a test or another host
   might not).
4. **Verify** (Decision 4), returning `{ status: 401 }` with no body on any
   failure:
   1. Both headers present and non-empty, else fail (`missing signature headers`).
   2. The timestamp is a string of digits; parse it as seconds. If
      `Math.abs(now() / 1000 - ts) > 300`, fail (`stale timestamp`).
   3. `expected = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${tsHeader}:${rawBody}`).digest('hex')`,
      using the timestamp header string exactly as received.
   4. Compare with `crypto.timingSafeEqual` on the two UTF-8 buffers, after a
      length check (`timingSafeEqual` throws on unequal lengths; a length
      mismatch is just a failure). Mismatch → fail (`bad signature`).
   5. Log each failure at `warn` with the reason and the timestamp header,
      never the body or the signature.
5. **Dispatch** (verified requests only). Parse `rawBody` as JSON. If it
   doesn't parse or isn't an object, log `warn` and return `{ status: 200 }`
   (Decision 4: "anything else → 200 and ignore").
   - `type === 'url_verification'` → `{ status: 200, headers: { 'content-type': 'text/plain' }, body: challenge }`.
     A missing or non-string `challenge` → 200 with an empty body and a
     `warn`.
   - `type === 'event_callback'` → if `event_id` is a non-empty string and
     `event` is an object, schedule
     `setImmediate(() => sink({ eventId: event_id, event }))`, wrapped in
     `try/catch` that logs a throwing sink at `error`. Then return
     `{ status: 200 }`. A malformed callback is logged and gets 200 with no
     sink call.
   - Anything else (`app_rate_limited`, unknown types) → `{ status: 200 }`,
     debug log with the type.
6. **No other state.** The ingress keeps nothing between calls. Slack's
   `X-Slack-Retry-Num` retries are processed like first deliveries; dedupe is
   001-5's job.
7. **Tests** in `test/core/ingress/events-api.test.ts`. A test helper signs a
   body with `node:crypto` (`sign(secret, ts, body)`), plus the two fixed
   vectors below, which were computed independently with `openssl dgst` and
   Node, so a bug shared by the helper and the implementation can't hide.
   The clock is injected (`now: () => 1_700_000_000_000` for the vectors).
   Fixed vectors (secret `test-signing-secret`, timestamp `1700000000`):

   | Body | `X-Slack-Signature` |
   |---|---|
   | `{"type":"url_verification","challenge":"3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P"}` | `v0=11f8eb925a98268730c0fd64e8c6c41bb78331ea11d9d5091a31c64443cac605` |
   | `{"type":"event_callback","event_id":"Ev01","event":{"type":"message","channel":"C0123ABC","ts":"1700000000.000100","text":"1234","user":"U1"}}` | `v0=a9010542f1fb94f034997f3bb41434a8ea1d14f746b25a07bc3c07312d7ec947` |

   Cases under Verification.

## Acceptance Criteria

- [x] `createEventsApiIngress` and `SlackEventSink` are exported from
      `src/core/ingress/events-api.ts` with the shapes above.
- [x] A request signed with the right secret over the exact raw body, with a
      timestamp within 300 s, is accepted; both fixed vectors verify.
- [x] A wrong signature, a signature over a different body (one byte
      changed), a different-length signature, a missing header, a
      non-numeric timestamp, or a timestamp more than 300 s in the past or
      future → 401 with no body, and the sink is never called.
- [x] Header names match case-insensitively (`X-Slack-Signature`,
      `x-slack-signature`, `X-SLACK-SIGNATURE`).
- [x] `url_verification` → 200, `text/plain`, body equal to `challenge`.
- [x] `event_callback` → 200 with no body; the sink is called once with
      `{ eventId, event }` only after `handle()`'s promise has resolved, and a
      throwing sink doesn't throw out of `handle()` or crash the process.
- [x] Other types and unparseable verified bodies → 200, sink not called.
- [x] Failure logs contain the reason but never the request body.
- [x] Signatures are compared with `crypto.timingSafeEqual`.
- [x] The file imports only `node:crypto` and the relay's own modules (no
      HTTP library).
- [x] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.

## Files Changed

| File | Action |
|---|---|
| src/core/ingress/events-api.ts | Create |
| test/core/ingress/events-api.test.ts | Create |

## Verification

```
pnpm test test/core/ingress/events-api.test.ts
pnpm typecheck && pnpm build && pnpm test
grep -n "timingSafeEqual" src/core/ingress/events-api.ts                    # present
grep -nE "from '(h3|crossws|ws|node:http)'" src/core/ingress/events-api.ts  # no output
```

Independent check of a vector from the shell:

```
printf '%s' 'v0:1700000000:{"type":"url_verification","challenge":"3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P"}' \
  | openssl dgst -sha256 -hmac 'test-signing-secret'
# 11f8eb925a98268730c0fd64e8c6c41bb78331ea11d9d5091a31c64443cac605
```

`events-api.test.ts` covers:

1. **Vectors:** each fixed vector → accepted (`url_verification` returns the
   challenge; `event_callback` returns 200 and later calls the sink with
   `eventId: 'Ev01'` and the inner event).
2. **Helper-signed:** random bodies signed with `sign()` → accepted.
3. **Bad signature:** last hex digit changed → 401; signature for another
   secret → 401; `v0=abc` (short) → 401, no throw; one byte of the body
   changed after signing → 401.
4. **Timestamps:** `now` 301 s after the header → 401; 301 s before → 401;
   exactly 300 s either way → accepted; `abc` → 401.
5. **Missing headers:** no signature, no timestamp, empty strings → 401.
6. **Case-insensitivity:** the same request with mixed-case, lowercase, and
   uppercase header names → accepted.
7. **Async sink:** `const r = await handle(...)`; at that point the recording
   sink has **not** been called; after `await new Promise(setImmediate)` it
   has been called exactly once.
8. **Throwing sink:** a sink that throws → `handle()` still resolves 200;
   after `setImmediate` the logger recorded an `error`.
9. **Other types:** a signed `{"type":"app_rate_limited"}` and a signed
   `not json` → 200, sink never called.
10. **No body in logs:** with a recording logger, a 401 for a body containing
    a marker string → no logged argument contains the marker.

## Notes

- **Factory not in the plan's interfaces.** The plan fixes `SlackEventSink`
  and `relay.handleSlackEvent`'s signature but not this module's export.
  `createEventsApiIngress({ signingSecret, sink, now, logger }).handle(rawBody, headers)`
  is the simplest shape that matches `handleSlackEvent` one to one. 001-10
  calls it; add it to the plan's interfaces section when this lands.
- **Where `SlackEventSink` lives.** The plan lists it under "Ingress (tasks 8
  and 9)" without a file. It is defined here because this task lands first
  (wave 2). 001-9 and 001-5 import the type from
  `src/core/ingress/events-api.ts`, unless 001-1 already placed it in a
  shared types file.
- **`setImmediate`, not `queueMicrotask`.** A microtask queued inside `handle`
  runs before the caller's `await` continues, so the sink would run before
  the response was handed back. `setImmediate` runs after the current
  microtask queue drains, so the 200 always goes out first.
- **Unparseable but signed bodies get 200.** Decision 4 says "anything else →
  200 and ignore, so Slack doesn't retry". A body that verifies but isn't JSON
  falls under that rule rather than a 400.
- **Future timestamps** are rejected the same as past ones (`|now − ts| > 300 s`),
  as Decision 4 says "more than 300 s from now".
- **Filled in on implementation.** A non-numeric timestamp logs
  `bad timestamp` (distinct from `stale timestamp`); both answer 401. A
  signature whose UTF-8 byte length differs from the expected one (e.g. a
  multi-byte character) fails the length check before `timingSafeEqual`, so
  it never throws. The response type is also exported as `EventsApiResponse`
  (same shape as the plan's inline type). Failure logs carry the reason and
  the timestamp header only; the sink-error log carries `eventId` and the
  error.
