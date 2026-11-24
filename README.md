# ProPager Relay

One Slack app, many ProPager sites.

[ProPager](https://github.com/ministryplus/mps-propager) pages numbers from a
Slack channel onto ProPresenter, the way a kids' check-in desk calls a parent
to the room. A church with one site runs ProPager on its own: it connects
straight to Slack and needs no server.

A church with **several sites in one Slack workspace** can't do that with one
Slack app. Slack's Socket Mode spreads an app's events across every open
connection, so each site's ProPager would get a random share of the messages,
including other sites' messages, and miss some of its own. A separate app per
site runs into Slack's limit on installed apps.

The relay fixes this. It holds the app's only connection to Slack and gives
each site exactly the messages for its channel.

> **Status: v0.1.0**, protocol 1. Built to
> [Spec 001: Relay v1](docs/specs/001-relay-v1.md). The wire protocol is
> documented in [`protocol/`](protocol/README.md).

## How it fits

```
                 ┌──────── ProPager Relay ────────┐
 Slack ────────▶ │ route each channel's messages  │ ──▶ ProPager (site A) ──▶ ProPresenter
       ◀──────── │ post replies with the bot token│ ──▶ ProPager (site B) ──▶ ProPresenter
                 └────────────────────────────────┘ ──▶ viewers (optional)
```

- **Sites connect out** to the relay over a secure WebSocket with a per-site
  key. They hold no Slack tokens, and ProPresenter stays on each site's local
  network.
- **The relay posts for the sites:** ProPager's thread replies and reactions
  go out through the relay with the bot token, in order per thread.
- **The relay filters its own messages,** so its replies never page a site.
- **Short reconnects lose nothing:** a site that reconnects within two minutes
  gets the messages it missed (`resume`).
- **ProPager keeps working without it.** A one-site church uses ProPager's
  Direct mode; a multi-site church switches its ProPagers to Relay mode.

## Package shape

`@ministryplus/propager-relay` is a TypeScript package (Node 24 or later) with
one core and thin adapters:

| Entry point | What it is |
|---|---|
| `@ministryplus/propager-relay` | The core: `createRelay`, routing, sites and viewers, Slack in (Events API or Socket Mode), Web API out, keys (`generateKey`, `hashKey`, `verifyKey`), `validateConfig`. No web framework. |
| `@ministryplus/propager-relay/h3` | `createRelayHandlers(relay)`: [h3](https://h3.dev) v1 handlers for the Slack webhook, the site and viewer WebSocket, and health, for apps built on h3 or Nitro (for example Nuxt). |
| `@ministryplus/propager-relay/standalone` | The `propager-relay` command: a small server you run on its own, on a public host or on a machine in your network. |

The wire protocol between the relay and its clients is defined in
[`protocol/`](protocol/README.md): a frame reference, a JSON Schema, and
example frames that both sides test against.

## Install

The package is installed from git, pinned to a release tag:

```json
"@ministryplus/propager-relay": "github:ministryplus/mps-propager-relay#v0.1.0"
```

Its `prepare` script builds `dist/` on install, and pnpm refuses to run it
for a git-hosted package unless the build is allowed for that exact source
and commit ([ADR 001 Decision 4](docs/adr/001-founding-propager-relay.md)).
In `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@ministryplus/propager-relay@https://codeload.github.com/ministryplus/mps-propager-relay/tar.gz/6dbc09e612e6ba86df689bde997a7b0f2c41c9ff': true
```

That key is for `v0.1.0` (commit `6dbc09e`); pnpm resolves a `github:` tag to
a codeload tarball URL for the tagged commit. For another tag, the first
install fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and prints the
exact key it wants; copy it from the error into `allowBuilds` and install
again. A name-only entry doesn't work. Upgrading the relay therefore
edits two places: the tag in `package.json` and this entry.

`h3` (`^1.15.0`) and `crossws` (`^0.3.5`) are peer dependencies, used by
`./h3` and `./standalone`; pnpm installs them automatically by default.

## Generate keys

Each site, and each remote viewer, connects with its own key. The relay
stores only the key's hash.

```
$ propager-relay keygen
key:  prk_9fJ2…   (give this to the site's ProPager; it is not stored anywhere)
hash: sha256:3b1f…  (put this in the site's keyHashes)
```

- The **key** (`prk_…`) goes into that site's ProPager (Relay mode) or the
  remote viewer, and nowhere else. It is printed once.
- The **hash** goes into that site's (or viewer's) `keyHashes` in the relay's
  configuration. A hash belongs to exactly one site or viewer.
- **Rotating a key:** run `keygen`, list the new hash next to the old one in
  `keyHashes` and restart the relay, give the site's ProPager the new key,
  then remove the old hash and restart again.

## Run standalone

```
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… propager-relay serve --config ./propager-relay.json
```

The config file holds sites, viewers, and optional settings. It never holds
secrets, so it can be committed or shared; a file with a `slack` key is
rejected. (The hashes below are placeholders; real ones are `sha256:` and 64
hex digits, from `keygen`.)

```json
{
  "ingress": "socket-mode",
  "sites": [
    { "name": "north", "channels": ["C0123ABC"], "keyHashes": ["sha256:3b1f…"] },
    { "name": "south", "channels": ["C0456DEF"], "keyHashes": ["sha256:9a07…"] }
  ],
  "viewers": [
    { "name": "office", "channels": "*", "keyHashes": ["sha256:c4d2…"], "canPost": true }
  ],
  "limits": { "historySize": 50 }
}
```

| Field | Meaning |
|---|---|
| `ingress` | Optional: `"socket-mode"` or `"events-api"`. Default: `socket-mode` if `SLACK_APP_TOKEN` is set, else `events-api`. |
| `sites[]` | `name` (unique), `channels` (Slack channel ids, `C…` or `G…`; each channel belongs to exactly one site), `keyHashes` |
| `viewers[]` | Optional. `name` (unique), `channels` (ids, or `"*"` for every site channel), `keyHashes`, `canPost` |
| `limits` | Optional overrides: `resumeWindowMs` (120000), `resumeMaxEvents` (200), `maxEventAgeMs` (300000), `historySize` (50), `handshakeTimeoutMs` (10000), `idleTimeoutMs` (90000), `maxFrameBytes` (65536) |

Secrets and the listen address come from environment variables:

| Variable | Required | Default |
|---|---|---|
| `SLACK_BOT_TOKEN` | always (`xoxb-…`) | |
| `SLACK_APP_TOKEN` | for Socket Mode (`xapp-…`) | |
| `SLACK_SIGNING_SECRET` | for the Events API | |
| `HOST` | no | `0.0.0.0` |
| `PORT` | no | `8787` |

Every problem with the file or the environment is reported at once, and
`serve` exits with code 1; a usage error exits with 2. `SIGTERM` or `SIGINT`
closes every connection with `1001` and exits 0. If Slack rejects the bot
token at startup, the relay keeps running, logs the error, retries with
backoff, and `/healthz` answers 503 until it succeeds.

Routes:

| Route | Purpose |
|---|---|
| `POST /slack/events` | Slack Events API Request URL (Events API mode; 404 in Socket Mode) |
| `GET /ws` | WebSocket for sites and remote viewers (protocol 1); a plain HTTP request gets 426 |
| `GET /healthz` | JSON health: `slack`, `slackSharedApp`, `ingress`, each site's `connected` and `lastSeenMs`, the viewer count. **200** when Slack is connected, **503** otherwise |

The server speaks plain HTTP. Put TLS in front of it with a reverse proxy or
`tailscale serve` (or `tailscale funnel` for a public Events API URL), and
give sites the `wss://…/ws` URL. The relay never handles certificates.

Configuration changes need a restart.

## Slack app setup

One Slack app serves every site. In its settings:

1. **OAuth & Permissions → Bot Token Scopes:** `chat:write`,
   `reactions:write`, `channels:history`, `groups:history`. Install the app
   to the workspace and put the **Bot User OAuth Token** (`xoxb-…`) in
   `SLACK_BOT_TOKEN`.
2. **Event Subscriptions → Subscribe to bot events:** `message.channels`,
   `message.groups`.
3. **Invite the bot to every site channel** (`/invite @YourApp`). It only
   receives messages from channels it is in.
4. Pick **one** ingress mode:
   - **Socket Mode** (no public URL needed): turn on Socket Mode, and under
     **Basic Information → App-Level Tokens** create a token with the
     `connections:write` scope. It goes in `SLACK_APP_TOKEN`.
   - **Events API** (needs a public HTTPS URL): leave Socket Mode off, set
     the Event Subscriptions **Request URL** to
     `https://<host>/slack/events` (the relay must be running to answer
     Slack's verification request), and put the app's **Signing Secret**
     (Basic Information) in `SLACK_SIGNING_SECRET`.

**One app, one Socket Mode client.** Slack splits an app's events across
every Socket Mode connection. If a ProPager in Direct mode, or a second relay,
uses the same app's app-level token, each one gets only part of the
messages. The relay notices when Slack reports more connections than its own,
logs a warning, and reports `slackSharedApp: true` in `/healthz` and in the
`status` frame sites see. Switch every ProPager on that app to Relay mode.

## Mount in h3 or Nitro

A host app built on h3 or Nitro (for example Nuxt) can run the relay inside
its own server instead of the standalone one. It supplies the `RelayConfig`
from wherever it keeps configuration (runtime config, a database); secrets
stay server-only. In Nitro:

```ts
// server/utils/propager-relay.ts: the one relay instance for this server
import { createRelay } from '@ministryplus/propager-relay';
import { createRelayHandlers } from '@ministryplus/propager-relay/h3';

const config = useRuntimeConfig();

export const propagerRelay = createRelay({
  config: {
    slack: {
      botToken: config.propager.slackBotToken,
      ingress: { mode: 'events-api', signingSecret: config.propager.slackSigningSecret },
    },
    sites: config.propager.sites, // [{ name, channels, keyHashes }]
    viewers: [{ name: 'portal', channels: '*', keyHashes: [], canPost: true }],
  },
});

export const propagerRelayHandlers = createRelayHandlers(propagerRelay);
```

```ts
// server/api/propager/slack.post.ts: the Slack Request URL (the relay checks the signature)
export default propagerRelayHandlers.slackEvents;
```

```ts
// server/routes/propager/ws.ts: sites and remote viewers connect here
export default propagerRelayHandlers.socket;
```

```ts
// server/routes/propager/healthz.get.ts (optional)
export default propagerRelayHandlers.health;
```

```ts
// server/plugins/propager-relay.ts: start at boot (auth.test, history backfill, Socket Mode if configured)
export default defineNitroPlugin(() => {
  void propagerRelay.start();
});
```

- The WebSocket route needs Nitro's `experimental.websocket: true`
  (`nitro: { experimental: { websocket: true } }` in a Nuxt config).
- `slackEvents` reads the raw request body, because Slack's signature covers
  the raw bytes; nothing may parse the body before it.
- `relay.start()` never rejects for a Slack failure: it logs and retries.
  Call `relay.stop()` on shutdown to close connections with `1001`.
- Outside Nitro, mount the three handlers on any h3 v1 app, with crossws
  serving the socket; `./standalone` does exactly that.

## Viewers

A viewer sees every message in its channels, including the relay's own
replies (`fromSelf: true`), and can load recent history (the last
`historySize` messages per channel, backfilled from Slack at startup).
Viewers don't resume after a reconnect; they load history instead.

- **Remote viewers** connect to `/ws` with `role: "viewer"` and a viewer key,
  and use the `history` and `post` frames ([`protocol/`](protocol/README.md)).
- **In-process viewers** are for a host app that runs the relay itself. They
  use a viewer name from `viewers` (for its channels and `canPost`) and skip
  keys, since the host has already authorized its user:

  ```ts
  const view = propagerRelay.viewer({ name: 'portal', channels: ['C0123ABC'] }, (msg) => push(msg));
  view.history('C0123ABC', 20);         // RelayMessage[], oldest first
  await view.post('C0123ABC', '1234');  // { ok, ts?, error? }, same rules as the post frame
  view.close();
  ```

- **`canPost`** lets a viewer post to its channels as the bot. A top-level
  post **pages the owning site**: the relay routes it to the site as soon as
  Slack confirms the post (`origin: "relay"`), without waiting for Slack's
  echo. A viewer without `canPost` gets `not_allowed`.

## Try it with `dev:site`

From a clone of this repo (`pnpm install`, `pnpm build`), `pnpm dev:site`
stands in for a ProPager site, so a relay can be checked against Slack before
a site is set up:

```
node dist/standalone/cli.js serve --config ./test.json     # with the SLACK_* env vars
pnpm dev:site --url ws://127.0.0.1:8787/ws --key prk_…
pnpm dev:site --url ws://127.0.0.1:8787/ws --key prk_… --resume <epoch>:<seq>
pnpm dev:site --url ws://127.0.0.1:8787/ws --key prk_… --role viewer
```

It prints every frame (with `epoch` and each `seq`, for `--resume`), answers
each top-level message with a "relay saw <text>" thread reply and a 👀, and
exits when the connection closes (code 0 after `1000`/`1001`, else 1; it
doesn't reconnect). With `--role viewer` it reads `history <channel> [limit]`
and `post <channel> <text>` from stdin, and disconnects at the end of input.

## Development

```
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## Documentation

- [Spec 001: Relay v1](docs/specs/001-relay-v1.md): what v0.1.0 does and why
- [Protocol 1](protocol/README.md): frames, close codes, resume, fixtures
- [ADR 001: Founding the ProPager Relay](docs/adr/001-founding-propager-relay.md):
  why this repo exists and the decisions that shape it
- [ProPager ADR 001: Slack relay architecture](https://github.com/ministryplus/mps-propager/blob/master/docs/adr/001-slack-relay-architecture.md):
  the problem in detail and the alternatives considered

## License

[MIT](LICENSE) © 2026 Ministry Plus Solutions Inc.
