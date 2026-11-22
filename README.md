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

> **Status: design stage.** There is no code or release yet. The decisions are
> recorded in [`docs/adr/`](docs/adr/), and the first spec is next.

## How it fits

```
                 ┌──────── ProPager Relay ────────┐
 Slack ────────▶ │ route each channel's messages  │ ──▶ ProPager (site A) ──▶ ProPresenter
       ◀──────── │ post replies with the bot token│ ──▶ ProPager (site B) ──▶ ProPresenter
                 └────────────────────────────────┘ ──▶ web view (optional)
```

- **Sites connect out** to the relay over a secure WebSocket with a per-site
  key. They hold no Slack tokens, and ProPresenter stays on each site's local
  network.
- **The relay posts for the sites:** ProPager's thread replies and reactions
  go out through the relay with the bot token, in order.
- **ProPager keeps working without it.** A one-site church uses ProPager's
  Direct mode; a multi-site church switches its ProPagers to Relay mode.

## Planned shape

The relay will be a TypeScript package, `@ministryplus/propager-relay`, with
one core and thin adapters:

| Entry point | What it is |
|---|---|
| `@ministryplus/propager-relay` | The core: routing, the site registry, Slack in, Web API out. No web framework. |
| `@ministryplus/propager-relay/h3` | Ready-made [h3](https://h3.dev) handlers for the Slack webhook and the site WebSocket, for apps built on h3 or Nitro (for example Nuxt). |
| `@ministryplus/propager-relay/standalone` | A small server you can run on its own, on a public host or on a machine in your network. |

The wire protocol between the relay and ProPager is defined in this repo, with
example messages that both sides test against.

## Documentation

- [ADR 001: Founding the ProPager Relay](docs/adr/001-founding-propager-relay.md):
  why this repo exists and the decisions that shape it
- [ProPager ADR 001: Slack relay architecture](https://github.com/ministryplus/mps-propager/blob/master/docs/adr/001-slack-relay-architecture.md):
  the problem in detail and the alternatives considered

## License

[MIT](LICENSE) © 2026 Ministry Plus Solutions Inc.
