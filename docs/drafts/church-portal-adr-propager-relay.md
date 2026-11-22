<!--
DRAFT for church-portal. Not adopted.

When the portal integration starts:
  1. Renumber: run the portal's ADR number scan across all branches (033 was next on 2026-11-22).
  2. Re-check every fact below against the portal as it is then (Nuxt/Nitro versions, config, auth).
  3. Move it to church-portal/docs/adr/{NNN}-propager-relay-integration.md and set Status.
  4. Synthetic values only (portal CLAUDE.md "Real Data"); the leak guard runs on commit.
-->

# ADR 0XX: Host a ProPager Relay as a First-Party Integration

**Date:** 2026-11-22 (drafted in mps-propager-relay; adopt with the integration date)
**Status:** Draft
**Context:** The church runs ProPager at several sites in one Slack workspace, and wants to see and post to those channels from the portal

## Context

ProPager (Ministry Plus, MIT) pages numbers from a Slack channel onto ProPresenter. One Slack app can't feed several sites over Socket Mode: Slack load-balances an app's events across its connections, so each site gets a random share. Ministry Plus decided ([mps-propager ADR 001](https://github.com/ministryplus/mps-propager/blob/master/docs/adr/001-slack-relay-architecture.md)) that multi-site churches run a **relay**: one service holds the app's only inbound connection and routes each channel's events to the site that owns it. ProPager sites connect to it in **Relay mode**.

The relay is a separate package, `@ministryplus/propager-relay` ([founding ADR](https://github.com/ministryplus/mps-propager-relay/blob/main/docs/adr/001-founding-propager-relay.md)). It ships a framework-free core, `./h3` handlers, and a `./standalone` server. The portal's Nitro server is built on h3 and crossws and already runs as a long-lived process (`scheduledTasks` requires the node-server preset), so it can host a relay instance with very little code.

Staff also want to see a site's paging channel in the portal (at least the latest message) and post to it. Posting has to page: a message the portal posts is sent as the bot, and ProPager ignores its own bot's messages, so the relay, not the portal, routes portal posts back to the site as pages.

## Decisions

### 1. The portal hosts a relay instance; it doesn't own the relay

The relay's code lives in `ministryplus/mps-propager-relay` and is shared with the standalone server. The portal mounts the package's `./h3` handlers and supplies configuration. It doesn't fork or reimplement routing, the echo filter, or the protocol.

| Portal file | Role |
|---|---|
| `server/api/propager/slack.post.ts` | Re-exports the relay's Slack Events API handler (signature verification included) |
| `server/routes/propager/ws.ts` | Re-exports the relay's site/viewer WebSocket handler (crossws) |
| `server/utils/propager-relay.ts` | Creates the relay instance once with the portal's config source |

Nitro needs `nitro.experimental.websocket: true` for the WebSocket route.

Hosting it in the portal rather than separately reuses the portal's public URL, TLS, deploys, and monitoring. The cost is that a portal deploy drops every ProPager site connection until it reconnects (Decision 5).

### 2. Dependency: a pinned git dependency with a trusted build

```json
"@ministryplus/propager-relay": "github:ministryplus/mps-propager-relay#v0.1.0"
```

- Pinned to a release tag, like every portal dependency.
- The relay's `prepare` script builds `dist/` on install, so `pnpm-workspace.yaml` allows it. pnpm only accepts an entry pinned to the exact source and commit for a git-hosted package; a name-only entry fails the install with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`:

  ```yaml
  allowBuilds:
    '@ministryplus/propager-relay@<resolved git url>#<commit sha>': true
  ```

- **Upgrading the relay edits two lines:** the tag in `package.json` and the commit in this entry. pnpm prints the entry it wants when the install fails, so copy it from the error. The entry is a deliberate per-commit trust step, consistent with the portal's supply-chain rules.
- If the relay ever switches to committing `dist/` on release tags, the `allowBuilds` entry goes away and an upgrade is one line.
- When the relay moves to npm, the spec changes to a version (`"0.3.0"`) and imports don't change. If `minimumReleaseAge` would delay a release of this first-party package, add it to `minimumReleaseAgeExclude`.

### 3. Configuration: runtime config first, Directus later

The relay core reads configuration through its config-source interface.

- **First:** environment variables through `runtimeConfig` (Slack bot token, signing secret, and a site → channel → site-key table), all server-only. Never exposed to the client.
- **Later, if wanted:** a Directus collection mapping portal `sites` to Slack channels and site keys, with an admin screen. That's a schema change, so it needs a declarative migration in `directus/migrations/` per the portal's conventions.

### 4. Channel view and posting are portal UI over relay capabilities

- **Read:** the portal's server subscribes to a channel as a **viewer**, in-process through the shared relay instance, and pushes updates to the browser. On load it shows the relay's recent-history buffer, at least the latest message.
- **Post:** the portal asks the relay to post. The relay posts as the bot and routes the echo back to the owning site as a page.
- **Permissions:** who may view or post per site is a portal authorization rule (see `docs/authentication.md` and the authorization resolver), enforced in the portal's API routes before calling the relay.

### 5. Deploys and restarts

- **Restarts drop site connections.** ProPager reconnects with backoff. Slack events that arrive while the portal is down are lost unless the relay buffers or Slack retries them. Until the relay spec settles buffering, don't deploy during service times.
- **Secrets** (bot token, signing secret, site keys) live in the deploy environment, not in git.

## Consequences

### Positive

- **Every church site pages from one Slack app,** with no extra hosting.
- **Staff see and post to paging channels in the portal,** and portal posts actually page.
- **The portal adds little code:** three small server files, plus UI and permissions.
- **No fork:** the portal runs the same relay code other churches run.

### Negative

- **Portal deploys interrupt paging** at every site until ProPager reconnects.
- **The portal now holds the Slack bot token** and site keys, raising the stakes of a server-side leak.
- **A new trusted install-time build** in the portal's dependency tree, and a two-line upgrade (tag plus commit-pinned `allowBuilds` entry), until the relay moves to npm.
- **The portal's uptime becomes paging's uptime.** If that is unacceptable, move to a standalone relay; ProPager sites only change their relay URL.

## Related

- [mps-propager ADR 001](https://github.com/ministryplus/mps-propager/blob/master/docs/adr/001-slack-relay-architecture.md): Slack relay architecture
- [mps-propager-relay ADR 001](https://github.com/ministryplus/mps-propager-relay/blob/main/docs/adr/001-founding-propager-relay.md): the relay's founding decisions
- ADR 031: in-repo Nitro routes for cross-system side effects (the same "logic in the repo, not in Directus" stance)
