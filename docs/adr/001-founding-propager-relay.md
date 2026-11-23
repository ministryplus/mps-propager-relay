# ADR 001: Founding the ProPager Relay

**Date:** 2026-11-22
**Status:** Accepted
**Context:** Why this repo exists, what it owns, and how it is built and consumed

## Context

ProPager pages numbers from a Slack channel onto ProPresenter. It receives Slack messages over **Socket Mode**, which load-balances an app's events across every open connection. When a church runs ProPager at several sites in **one workspace**, each site gets a random share of every channel's messages. Giving each site its own Slack app doesn't scale on Slack's free plan, which caps installed apps.

[mps-propager ADR 001](https://github.com/ministryplus/mps-propager/blob/master/docs/adr/001-slack-relay-architecture.md) decided the fix: ProPager gets a **Relay mode**. One relay holds the Slack app's only inbound connection and routes each channel's events to the site that owns it. That ADR records the alternatives rejected (tailnet hub, polling, withholding acks). This repo is the relay. This ADR records the decisions that shape the repo itself.

## Decisions

### 1. Identity: a Ministry Plus product, separate from ProPager

| | |
|---|---|
| **Repo** | `ministryplus/mps-propager-relay` |
| **Package** | `@ministryplus/propager-relay` |
| **License** | MIT, like ProPager |
| **Language** | TypeScript |

It is a separate repo, not a folder in mps-propager: different language, toolchain, release cadence, and consumers. Consumers install it as a git dependency (Decision 4), which can only point at a whole repo. The repo name carries the org's `mps-` prefix; the package name doesn't, because the `@ministryplus` scope already names the publisher. Renaming the repo later changes only consumers' git URLs, never their imports.

### 2. Who uses it

| Consumer | How |
|---|---|
| **ProPager sites** (Relay mode) | `RelayClient` connects out over WSS with a site key and subscribes to its channel(s). A site holds no Slack tokens. |
| **The standalone server** | `./standalone`, on a public host or a Mac on the church's tailnet. The release path for other churches. |
| **church-portal** | A first-party integration that hosts an instance inside its Nitro server and adds a channel view. A draft portal ADR waits in [`docs/drafts/`](../drafts/church-portal-adr-propager-relay.md). |

One-site churches don't need the relay; ProPager's Direct mode keeps working with no server.

### 3. Package shape: one core, thin adapters

```
@ministryplus/propager-relay
  .            core: routing, site registry, auth, Slack ingress + Web API out (no framework)
  ./h3         h3 handlers: Slack webhook (event handler) + site socket (crossws handler)
  ./standalone CLI / Node server built on ./h3, reads a config file
```

- **The core is framework-free.** It takes Slack events in, routes them, and calls the Web API. It defines a small **config-source interface** (sites, channels, site keys, Slack credentials), so each host decides where configuration lives: a file for standalone, environment variables or Directus for a host app.
- **`./h3` is the only HTTP/WebSocket layer.** Nitro is built on h3 and crossws, so church-portal mounts these handlers directly, and `./standalone` is a small h3 app around the same handlers. The portal and standalone share everything except configuration and roughly ten lines of setup each.
- **Slack ingress is pluggable:** the Events API webhook (needs a public URL, which a host app already has) or Socket Mode (for a standalone relay without one). The core sees the same events either way.

### 4. Consumption: git dependency now, npm later

```json
"@ministryplus/propager-relay": "github:ministryplus/mps-propager-relay#v0.1.0"
```

- **The repo is a real package from the first tag:** `name`, `exports` (`.`, `./h3`, `./standalone`), `types`, `files`, semver tags `vX.Y.Z`.
- **`prepare` builds `dist/` on install,** and consumers trust it through their build allowlist. `dist/` is never committed.
- **The allowlist entry is pinned to a commit.** A spike on 2026-11-22 (pnpm 10.34.9, church-portal's pinned version; pnpm 12 behaves the same) showed that pnpm refuses to install a git-hosted package with build scripts unless `allowBuilds` names the exact source and commit. A name-only entry fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`:

  ```yaml
  allowBuilds:
    '@ministryplus/propager-relay@<resolved git url>#<commit sha>': true
  ```

  So a consumer upgrades in two places: the tag in `package.json` and this entry. pnpm prints the exact entry it wants when an install fails, so it can be copied from the error. We keep `prepare` anyway: the entry is an explicit trust step per commit, it never installs the package unbuilt, and the relay's build tools stay out of the consumer's `node_modules`. If upgrades become frequent enough to hurt, the fallback is a release script that commits `dist/` on tagged release commits only; consumers then need no allowlist entry.
- **Pin pnpm in this repo** with `packageManager` in `package.json`, so builds don't depend on whichever pnpm a contributor has installed globally.
- **npm later:** `prepack` runs the same `build` script, the tarball carries `dist/` and type declarations, and consumers change `github:…#vX.Y.Z` to `X.Y.Z`. Reserve the `@ministryplus` npm scope before the first tag; if it's taken, choose the fallback scope then, so no import ever changes.

### 5. This repo owns the wire protocol

ProPager's `RelayClient` is C++ and can't import this repo's types, so the protocol is shared as data:

- **`protocol/`** holds a short spec, a JSON Schema per frame type (subscribe, event, reply, react, post, error, …), and example frames as fixture files. This repo's tests run against those fixtures.
- **An integer protocol version,** separate from package semver. Clients send it when connecting; the relay rejects an unsupported version with an explicit error, never a silent stall. Breaking frame changes bump it.
- **Clients pin fixtures:** ProPager copies `protocol/` fixtures at a tagged release into its own tests. Treat a fixture change as a client-visible change, and call it out in the release notes.

### 6. What the relay is responsible for

These follow from the relay being the one component that sees every event and every post (mps-propager ADR 001, Decisions 5 and 6). All of them are protocol v1.

| Responsibility | Detail |
|---|---|
| **Route by channel** | Deliver each listen channel's top-level messages and thread replies only to the sites subscribed to it. |
| **Own the echo filter** | Drop the bot's own messages before routing, so its replies never page. Learn the bot's ids from `auth.test`. |
| **Post for sites** | Thread replies and reactions arrive over the site socket; the relay sends them with the bot token, in order per thread (one request in flight per `thread_ts`). |
| **Route its own posts back as pages** | A post made *through the relay* is posted as the bot. The relay records the returned `ts` and delivers that echo to the owning site as a normal channel message instead of filtering it. |
| **Viewer subscriptions** | Read-only subscribers to a channel (in-process or over WSS). They never page. |
| **Recent history** | A small per-channel buffer of recent messages, backfilled from `conversations.history` at startup, so a viewer can show the latest message on load. |

**Open for the relay spec:** buffering events briefly across a host restart or a site reconnect, site-key issuance and rotation, and rate-limit handling for bursts across many sites.

### 7. Repo conventions

- **Docs mirror mps-propager:** decisions in `docs/adr/NNN-*.md`, buildable specs in `docs/specs/NNN-*.md` with task breakdowns in `docs/tasks/`. The first spec, `docs/specs/001-…`, covers the core, `./h3`, `./standalone`, and protocol v1.
- **Drafts for other repos** live in `docs/drafts/` until the owning repo adopts them under its own conventions and numbering.
- **pnpm** as the package manager, with pinned dependency versions, matching church-portal's supply-chain rules so the relay never adds an unpinned transitive surprise to a host.
- **Toolchain specifics** (Node version, test runner, build tool) are decided in spec 001, not here.

## Consequences

### Positive

- **One codebase for every host.** Standalone and church-portal differ only in configuration and a few lines of setup.
- **Releasable on its own.** Other churches run `./standalone` without church-portal.
- **The protocol has one source of truth,** and clients detect drift as failing tests.
- **The path to npm is a release step,** not a restructure.

### Negative

- **A second repo and release process** alongside ProPager, plus a fixture sync in ProPager whenever the protocol changes.
- **Hosts depend on a trusted install-time build** until the package moves to npm, and every upgrade edits a commit-pinned `allowBuilds` entry as well as the tag.
- **A hosted relay is a single point of failure** for every site using it; restarts drop all site connections until clients reconnect.
- **Echo filtering and per-thread ordering are implemented twice:** here for Relay mode, and in ProPager's `SlackClient` for Direct mode.
- **Multi-workspace hosting is out of scope.** Each church runs its own relay; serving many churches from one relay (OAuth installs, app distribution) is a later decision.

## Related

- [mps-propager ADR 001](https://github.com/ministryplus/mps-propager/blob/master/docs/adr/001-slack-relay-architecture.md): the architecture decision this repo implements
- [mps-propager Spec 003](https://github.com/ministryplus/mps-propager/blob/master/docs/specs/003-threaded-slack-feedback.md): threaded feedback, the own-message filter (Decision 2), and per-thread reply order (Decision 9) that the relay takes over in Relay mode
- [Draft church-portal ADR](../drafts/church-portal-adr-propager-relay.md)

## Addendum

**Date:** 2026-11-22

[Spec 001: Relay v1](../specs/001-relay-v1.md) refines two rows of Decision 6's table. The table above is left as written; this addendum is the current behavior.

- **Route its own posts back as pages** (Spec 001 Decision 8). The relay doesn't wait for the echo of its own post: Slack's echo event can arrive before the `chat.postMessage` response that tells the relay which `ts` it was. Instead, when a viewer's `post` succeeds, the relay builds the page from the API response (`origin: "relay"`, `eventId: "relay:<ts>"`) and routes it to the owning site immediately, like a Slack message. When the echo arrives it is the bot's own message, so the echo filter drops it for sites; viewers receive it with `fromSelf: true`. The site pages once, with no race.
- **Viewer subscriptions** (Spec 001 Decisions 7 and 11). Viewers are not read-only, and their posts do page. A viewer configured with `canPost` may post to its channels through the relay (a `post` frame, or `view.post()` for an in-process viewer), and a top-level post pages the owning site as described above. A viewer without `canPost` is read-only.
