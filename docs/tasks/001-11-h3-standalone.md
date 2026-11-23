# Task 001-11: h3 handlers, standalone server, end-to-end test

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Complete
**Parallel group:** Wave 5 (solo — needs a working `Relay`)
**Depends on:** [001-10](001-10-relay-assembly.md)
**Blocks:** [001-12](001-12-release.md)

## What

Put the core on the network (Spec 001 Decision 12). `./h3` gets
`createRelayHandlers(relay)`, three h3 v1 event handlers that adapt the
framework-free `Relay`: `slackEvents` reads the raw body and calls
`relay.handleSlackEvent`, `socket` is a crossws handler that maps each peer
to `relay.openConnection`, and `health` returns the `HealthReport` with 200
or 503. `./standalone` is a small h3 app around those handlers on
`node:http`, with the `propager-relay` CLI: `serve --config <file>` loads
sites, viewers, limits, and the ingress mode from a JSON file and the Slack
secrets from env vars (the Decision 12 table), listens on `HOST`/`PORT`, and
stops cleanly on `SIGTERM`/`SIGINT`; `keygen` prints a key and its hash
(Decision 3). One end-to-end test runs the standalone server on an ephemeral
port with a real `ws` client as a site and a fake Slack Web API over HTTP:
a signed Events API post in, a `message` frame out, a `reply` out to the
fake Slack.

## Steps

1. **`src/h3/index.ts`:** `export function createRelayHandlers(relay: Relay):
   { slackEvents: EventHandler; socket: EventHandler; health: EventHandler }`,
   importing only from `h3` (a peer dependency, `^1.15.0`) and the core's
   public types.
   - `slackEvents = defineEventHandler(async (event) => { ... })`:
     `rawBody = (await readRawBody(event, 'utf8')) ?? ''` (never a parsed
     body: the signature covers the raw bytes, Decision 4);
     `headers = getRequestHeaders(event)` (Node lowercases names);
     `const r = await relay.handleSlackEvent(rawBody, headers)`;
     `setResponseStatus(event, r.status)`; set each of `r.headers`; return
     `r.body ?? ''`.
   - `socket = defineWebSocketHandler({ open, message, close, error })`,
     keeping a `Map<peer.id, { receive, closed }>`:
     - `open(peer)`: `map.set(peer.id, relay.openConnection({ send: (t) =>
       peer.send(t), close: (code, reason) => peer.close(code, reason) }))`;
     - `message(peer, msg)`: `map.get(peer.id)?.receive(msg.text())`;
     - `close(peer)`: `map.get(peer.id)?.closed(); map.delete(peer.id)`;
     - `error(peer, err)`: log nothing here (the hub logs protocol errors);
       the `close` hook still follows, and it does the cleanup.
   - `health = defineEventHandler((event) => { const h = relay.health();
     setResponseStatus(event, h.slack === 'connected' ? 200 : 503); return h;
     })`.
2. **How crossws 0.3 + h3 1.15 serve WebSockets on `node:http`** (checked
   against the published `h3@1.15.11` and `crossws@0.3.5` sources on
   2026-11-22):
   - `defineWebSocketHandler(hooks)` returns an event handler that answers a
     plain HTTP request with 426 and carries the hooks on the handler.
   - `app.websocket` (a getter on h3's `createApp()` result) returns
     crossws options whose `resolve(info)` looks the request path up through
     the app stack, including `createRouter()` routes (looked up as `GET`),
     and returns that handler's hooks.
   - `crossws/adapters/node` default-exports `nodeAdapter(options)`, which
     returns `{ handleUpgrade(req, socket, head): Promise<void>, closeAll(code?,
     data?, force?), peers }`. It bundles its own copy of `ws`'s
     `WebSocketServer` in `noServer` mode, so the server side needs no
     separate `ws` import.
   - h3 itself never touches the `upgrade` event, so the standalone server
     wires it:

     ```ts
     const app = createApp();
     const router = createRouter()
       .post('/slack/events', h.slackEvents)
       .get('/ws', h.socket)
       .get('/healthz', h.health);
     app.use(router);
     const server = createServer(toNodeListener(app));
     const ws = crossws(app.websocket);            // import crossws from 'crossws/adapters/node'
     server.on('upgrade', (req, socket, head) => {
       if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') return socket.destroy();
       ws.handleUpgrade(req, socket, head);
     });
     ```

     The pathname check matters: for an unknown path, `resolve` returns no
     hooks, and crossws would still accept the upgrade (see Notes).
3. **`src/standalone/index.ts`** (programmatic API, used by the CLI and the
   end-to-end test):

   ```ts
   export interface StandaloneFile {           // the --config JSON (no secrets)
     ingress?: 'events-api' | 'socket-mode';
     sites: SiteConfig[]; viewers?: ViewerConfig[]; limits?: Partial<RelayLimits>;
   }
   export function loadConfig(file: StandaloneFile, env: Record<string, string | undefined>): RelayConfig;
   export function startServer(o: { config: RelayConfig; host?: string; port?: number;
     logger?: Logger; slackApi?: SlackApi }): Promise<{ relay: Relay; port: number; stop(): Promise<void> }>;
   ```

   - `loadConfig` applies the Decision 12 table: `SLACK_BOT_TOKEN` is
     required; the mode is `file.ingress`, else `socket-mode` if
     `SLACK_APP_TOKEN` is set, else `events-api`; `events-api` requires
     `SLACK_SIGNING_SECRET`, `socket-mode` requires `SLACK_APP_TOKEN`. It
     collects every missing variable and throws one error listing them (the
     same style as `validateConfig`). Secrets are never read from the file:
     a file with a `slack` key is rejected with a message saying secrets go
     in env vars.
   - `startServer` calls `createRelay({ config, logger, slackApi })`, builds
     the app in step 2, listens on `host` (default `0.0.0.0`) and `port`
     (default `8787`; `0` picks a free port), awaits `relay.start()`, logs
     the listening address and ingress mode, and returns the bound port.
     `stop()` calls `relay.stop()` (which closes sockets with `1001`), then
     `ws.closeAll()` for any peer that never sent `hello`, then
     `server.close()`.
4. **`src/standalone/cli.ts`** (`bin: propager-relay`; keep 001-1's
   `#!/usr/bin/env node` first line, which `tsc` preserves):
   - Parse with `node:util` `parseArgs` (no new dependency).
   - `serve --config <path>`: read and `JSON.parse` the file, `loadConfig(file,
     process.env)`, `startServer({ config, host: process.env.HOST, port:
     Number(process.env.PORT) || undefined })`. On `SIGTERM` or `SIGINT`,
     `await stop()` then `process.exit(0)` (a second signal exits at once).
     A config or env error prints the message to stderr and exits with 1.
   - `keygen`: `generateKey()` and `hashKey()`, printed in the Decision 3
     format (`key:  …   (give this to the site's ProPager; it is not stored
     anywhere)` / `hash: …  (put this in the site's keyHashes)`).
   - No command, an unknown command, or `serve` without `--config` → usage on
     stderr, exit 2.
5. **Peer dependencies.** Confirm 001-1 declared `h3` `^1.15.0` and
   `crossws` `^0.3.5` as `peerDependencies` and as pinned dev dependencies,
   and that nothing under `src/core` imports either (`./h3` and
   `./standalone` only). Don't change `package.json` here unless one is
   missing; if so, stop and ask.
6. **Unit tests** `test/h3/handlers.test.ts`: mount the handlers in an h3
   app with a stub `Relay` (records calls, returns scripted results) and
   call it through `toNodeListener` on an ephemeral port with `fetch`:
   `slackEvents` passes the exact raw body and lowercase headers and returns
   the relay's status, headers, and body; `health` gives 200 with `slack:
   'connected'` and 503 otherwise; a plain `GET /ws` gets 426.
7. **Standalone tests** `test/standalone/config.test.ts`: `loadConfig`
   defaults and errors (every missing variable listed at once; `slack` key in
   the file rejected; `file.ingress` overriding the default). A CLI test
   runs `node dist/standalone/cli.js keygen` after `pnpm build` (or imports
   the command function) and checks both lines, with `verifyKey(key,
   [hash])` true.
8. **End-to-end test** `test/e2e/standalone.test.ts`:
   - A fake Slack Web API on `node:http` (`127.0.0.1`, port 0) that records
     every request and answers `auth.test` (`user_id`, `bot_id`),
     `conversations.history` (`messages: []`), and `chat.postMessage` (`ok`,
     a `ts`). Pass `slackApi: createSlackApi({ botToken, baseUrl:
     'http://127.0.0.1:<port>/api/' })` (001-4).
   - `startServer({ config, host: '127.0.0.1', port: 0, slackApi })` with
     `events-api`, one site with a key from `generateKey()`, and a test
     signing secret.
   - `GET /healthz` → 200 (`auth.test` succeeded).
   - A `ws` client connects to `ws://127.0.0.1:<port>/ws`, sends `hello` →
     `welcome` and `status` frames.
   - `POST /slack/events` with a signed `event_callback` (`1234` in the
     site's channel; signature computed as in Decision 4) → 200, then a
     `message` frame with `text: '1234'`, `kind: 'channel'`.
   - The client sends `reply` → the fake Slack records `chat.postMessage`
     with `thread_ts`, `text`, and `unfurl_links: false` → a `result` frame
     `{ ok: true, ts }`.
   - `stop()` → the client sees close code `1001`.

## Acceptance Criteria

- [x] `createRelayHandlers(relay)` returns `slackEvents`, `socket`, and
      `health`, built only from `h3` APIs (`readRawBody`,
      `defineWebSocketHandler`, `defineEventHandler`).
- [x] `slackEvents` hands the relay the raw body string and returns its
      status, headers, and body unchanged.
- [x] Each crossws peer maps to exactly one `relay.openConnection`; its text
      frames reach `receive`, and its close reaches `closed`.
- [x] `health` returns the `HealthReport` as JSON with 200 when Slack is
      connected and 503 otherwise.
- [x] `propager-relay serve --config <file>` reads sites, viewers, limits,
      and ingress from the file and the secrets from env, defaults to
      `0.0.0.0:8787`, serves `POST /slack/events`, `GET /ws`, and
      `GET /healthz`, and stops on `SIGTERM`/`SIGINT` after closing
      connections with `1001`.
- [x] Missing env vars are reported together; secrets in the file are
      rejected.
- [x] `propager-relay keygen` prints a key and its hash in the Decision 3
      format, and the hash verifies the key.
- [x] Upgrades on any path other than `/ws` are refused.
- [x] `src/core` imports neither `h3` nor `crossws`.
- [x] The end-to-end test passes over real HTTP and WebSocket;
      `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.

## Files Changed

| File | Action |
|---|---|
| src/h3/index.ts | Modify (replace the empty entry point) |
| src/standalone/index.ts | Modify (replace the empty entry point) |
| src/standalone/cli.ts | Modify (001-1 left a shebang-only stub) |
| test/h3/handlers.test.ts | Create |
| test/standalone/config.test.ts | Create |
| test/e2e/standalone.test.ts | Create |

## Verification

```
pnpm build && pnpm exec vitest run test/h3 test/standalone test/e2e
pnpm test && pnpm typecheck
grep -rn "from 'h3'\|from 'crossws" src/core   # prints nothing
node dist/standalone/cli.js keygen
node dist/standalone/cli.js; echo "exit $?"     # usage, exit 2
```

Manual smoke (no Slack needed). Port 8787 is the default; check it's free
first, or set `PORT`:

```
printf '{"sites":[{"name":"north","channels":["C0123ABC"],"keyHashes":["<hash from keygen>"]}]}' > /tmp/relay-smoke.json
SLACK_BOT_TOKEN=xoxb-fake SLACK_SIGNING_SECRET=fake PORT=8790 node dist/standalone/cli.js serve --config /tmp/relay-smoke.json &
curl -i http://127.0.0.1:8790/healthz   # 503: auth.test fails with a fake token, but the server is up
kill -TERM %1                           # logs shutdown, exits 0
```

## Notes

- **Unknown-path upgrades:** reading `crossws@0.3.5`'s node adapter, an
  upgrade whose path resolves to no hooks is still accepted (the default
  `upgrade` hook allows it) and becomes a socket nobody handles. This was
  read, not run; the pathname check in step 2 makes it moot either way. A Nitro
  host routes upgrades itself and doesn't need it.
- **Not verified by running:** the step 2 wiring comes from reading the
  published sources, not from a running server. The end-to-end test is the
  check. If `app.websocket`'s resolver doesn't find the router's `/ws`
  route, pass the socket hooks to the adapter directly
  (`crossws({ hooks: socketHooks })`) and note it here.
- **`crossws` as a peer:** `./standalone` imports `crossws/adapters/node`
  directly, so a consumer needs `crossws` resolvable. pnpm installs peers
  automatically by default (`auto-install-peers`), and h3 1.15 depends on
  `crossws ^0.3.5` anyway. 001-12's install check confirms the binary starts.
- **Programmatic standalone API:** `loadConfig` and `startServer` aren't in
  the spec, which only defines the CLI. They exist so the end-to-end test
  can inject `slackApi` without adding an env var for the Slack API URL.
  Keep them exported from `./standalone`; the README (001-12) documents
  only the CLI.
- **Frame size:** `maxFrameBytes` is enforced by the hub (001-6). The node
  adapter's own `maxPayload` default (100 MiB in `ws`) is left alone; set
  `serverOptions: { maxPayload }` only if a test shows the hub's check isn't
  enough.
- **Implementation notes (001-11, gaps filled):**
  - **Step 2 wiring confirmed by running:** `crossws(app.websocket)` resolves
    the router's `GET /ws` route; the hooks didn't need passing directly.
    Unknown-path upgrades get `404` written to the socket and closed (instead
    of a bare `destroy()`), so a client sees a clear refusal; the e2e test
    checks it.
  - **`loadConfig` takes the parsed JSON (`unknown`)**, not only a typed
    `StandaloneFile`, and shape-checks it before `validateConfig` (which
    assumes arrays and would throw a `TypeError` on, say, a missing
    `sites`): object file, known `ingress`, `sites`/`viewers` element shapes,
    `limits` an object. Shape problems, a `slack` key, and missing env vars
    all go into one `ConfigError`. An empty env var counts as missing.
  - **CLI is testable in-process:** `cli.ts` exports `run(argv, io)` (exit
    code, or `null` while `serve` runs) and calls it only when it is the
    process entry point (`realpath` of `argv[1]`, so a bin symlink works).
    The config tests cover `keygen`, usage (exit 2, including an unknown
    flag), and every `serve` error path (exit 1). A config error, unreadable
    or non-JSON file, or failed listen prints to stderr and exits 1.
  - **Signals:** the first `SIGTERM`/`SIGINT` stops the server and exits 0;
    a second exits 1 at once. Verified manually (not in `pnpm test`, which
    never starts `serve` against real Slack).
  - **`stop()`** = `relay.stop()` → `ws.closeAll(1001)` → `server.close()`
    with `closeIdleConnections()` so keep-alive sockets don't hold it open.
    If `listen` fails, `startServer` stops the relay and rejects.
  - **Manual smoke (2026-11-22):** `keygen` and usage/exit 2 as specified;
    `serve` with dummy tokens on `127.0.0.1:8790` gave `/healthz` 503 while
    `auth.test` failed with `invalid_auth` and retried (logged, no crash; the
    fake token does reach slack.com, since the CLI has no Slack URL
    override); a `ws` site got `welcome` + `status`; `SIGTERM` closed it with
    `1001` and exited 0. `SIGINT` on default host `0.0.0.0:8791` also exited
    0; unsigned `POST /slack/events` → 401, plain `GET /ws` → 426; a missing
    `SLACK_SIGNING_SECRET` printed the error and exited 1.
  - No earlier module needed a fix.
