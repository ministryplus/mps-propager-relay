# Task 001-12: dev:site, README, ADR addendum, v0.1.0 and live verification

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Complete — v0.1.0 tagged, install-checked, and Spec Verification 1–10 passed against a test workspace (2026-11-23)
**Parallel group:** Wave 6 (solo — tagging and pushing `v0.1.0` is outward-facing and **needs the user's go-ahead**)
**Depends on:** [001-11](001-11-h3-standalone.md)
**Blocks:** — (unblocks mps-propager Spec 004)

## What

Finish v0.1.0 (Spec 001 Implementation Sequence step 10). Add
`scripts/dev-site.ts` and the `dev:site` script (Decision 13): a stand-in
site that prints every frame, answers each top-level message with a thread
reply and a 👀, can send a `resume`, and has a viewer mode driven by stdin
commands, so the relay can be verified against real Slack before ProPager's
`RelayClient` exists. Update `README.md` from "design stage" to v0.1.0 with
how to run the standalone server, set up the Slack app for either ingress
mode, mount the handlers in h3/Nitro, and generate keys. Add an addendum to
the founding ADR recording Spec Decision 8's refinement of its Decision 6.
Then, **only after the user approves**, merge, tag `v0.1.0`, and push; install
the tag as a `github:` dependency in a scratch pnpm 12 consumer to
confirm `prepare` and the exact `allowBuilds` entry; and run Spec
Verification 1–10 against a test Slack workspace with the user.

## Steps

1. **`scripts/dev-site.ts`** (Decision 13; not part of the package, so not
   under `src/` and not in `files`). Use only `ws` and Node built-ins, and
   only erasable TypeScript syntax (no `enum`, no parameter properties), so
   Node 24 runs it directly with type stripping.
   - Options via `node:util` `parseArgs`: `--url` (required), `--key`
     (required), `--resume <epoch>:<seq>` (optional), `--role site|viewer`
     (default `site`).
   - On open, send `hello` (`protocol: 1`, `role`, `key`, `client: { name:
     'dev-site', version: <package.json version> }`, plus `resume: { epoch,
     seq }` when `--resume` is given). Send `ping` every 25 s (the protocol
     asks for at least every 30 s).
   - Print every received frame as one JSON line, prefixed with the time.
     On `welcome`, also print `epoch=<epoch> resumed=<resumed>`; on each
     `message`, print `seq=<seq>`, so a later `--resume <epoch>:<seq>` can be
     copied from the output.
   - **Site role:** for each `message` with `kind: 'channel'`, send `reply`
     (`channel`, `threadTs: ts`, `text: 'relay saw <text>'`) and `react`
     (`channel`, `ts`, `emoji: 'eyes'`), each with a fresh `id`.
   - **Viewer role:** read stdin lines with `node:readline`:
     `history <channel> [limit]` → a `history` frame; `post <channel> <text…>`
     → a `post` frame (the rest of the line is the text); anything else →
     print the two command forms.
   - On close, print the code and reason and exit (code 0 for `1000`/`1001`,
     1 otherwise). It doesn't reconnect: Verification 5 expects a replaced
     `dev:site` to stop.
2. **`dev:site` script** in `package.json`: `"dev:site": "node
   scripts/dev-site.ts"`, so `pnpm dev:site --url ws://localhost:8787/ws
   --key prk_…` works. 001-1 already includes `scripts/` in `tsconfig.json`
   (typecheck only; the build config stays `src`), and deferred this script
   entry to this task.
3. **README.md.**
   - Status: replace the "design stage" note with "v0.1.0", and the
     "Planned shape" heading with the shipped shape. Link Spec 001 and the
     `protocol/` reference.
   - **Install:** the `github:ministryplus/mps-propager-relay#v0.1.0`
     dependency and the commit-pinned `allowBuilds` entry (ADR 001
     Decision 4), using the exact key format recorded in step 8.
   - **Generate keys:** `propager-relay keygen`, where the key and the hash
     go, and rotation (Decision 3).
   - **Run standalone:** a sample `propager-relay.json` (sites, viewers,
     optional `ingress` and `limits`, no secrets), the env vars table
     (Decision 12), routes, `HOST`/`PORT` defaults, `/healthz` (200/503),
     and that TLS comes from a reverse proxy or `tailscale serve`.
   - **Slack app setup**, for both modes. Bot token scopes: `chat:write`,
     `reactions:write`, `channels:history`, `groups:history`. Bot events:
     `message.channels`, `message.groups`. Invite the bot to every site
     channel. **Socket Mode:** enable Socket Mode and create an app-level
     token with `connections:write` (`SLACK_APP_TOKEN`). **Events API:** set
     the Request URL to `https://<host>/slack/events` and use the app's
     signing secret (`SLACK_SIGNING_SECRET`). Say plainly that one app must
     have only one Socket Mode client: a ProPager in Direct mode on the same
     app splits events, and the relay warns about it (`slackSharedApp`).
   - **Mount in h3/Nitro:** `createRelay` once in a server util;
     `createRelayHandlers(relay)` re-exported from route files for the Slack
     webhook, the socket, and health; `nitro.experimental.websocket: true`;
     `relay.start()` at startup; the in-process `relay.viewer()` example
     (Decision 11). Keep it consistent with the draft church-portal ADR.
   - **Viewers:** remote (frames over `/ws`) and in-process, `canPost`, and
     that a viewer's top-level post pages the owning site.
4. **ADR addendum.** Append an `## Addendum` section to
   `docs/adr/001-founding-propager-relay.md`, dated the day it's written:
   Spec 001 Decision 8 refines Decision 6's "Route its own posts back as
   pages" row. The relay doesn't wait for the echo of its own post (the echo
   can arrive before the `chat.postMessage` response that names its `ts`);
   it builds the page from the API response and routes it to the owning
   site immediately, and the echo filter drops the echo for sites. The
   addendum also corrects Decision 6's **Viewer subscriptions** row, which
   calls viewers read-only and says they "never page": per Spec Decisions 7
   and 11, a viewer with `canPost` may post, and a top-level post pages the
   owning site. Link the spec. Leave the original Decision 6 text unchanged.
5. **Local checks** before asking for approval: `pnpm install`, `pnpm
   build`, `pnpm test`, `pnpm typecheck` all pass on a clean checkout of
   `feat/relay-v1`; `package.json` `version` is `0.1.0` (set it if 001-1
   didn't); `pnpm pack --dry-run` lists `dist/` and `protocol/` and no
   `scripts/`, `src/`, or `test/`; a local `dev:site` run against a local
   standalone server with a fake token connects and prints `welcome`.
6. **STOP: ask the user before anything outward-facing.** Present the
   plan: how `feat/relay-v1` reaches `main` (a PR against
   `ministryplus/mps-propager-relay`, or another way the user picks), the
   commit to tag, the annotated tag `v0.1.0`, and the push of the branch
   and tag. Release notes for the tag list protocol 1 and its fixtures
   (Decision 14). Do not merge, tag, or push until the user says so in that
   turn.
7. **Tag and push (after approval only).** Once the approved commit is on
   `main`: `git tag -a v0.1.0 -m "v0.1.0"` on it, then push the tag (and
   anything else the user approved). Record the tagged commit SHA.
8. **Git-dependency install check** (Verification 10, success criterion 7),
   in a scratch directory outside the repo:
   - Use pnpm 12, the version consumers run (village-portal moves to 12.x
     on its `next` branch); confirm `pnpm --version` prints a 12.x.
   - `pnpm add github:ministryplus/mps-propager-relay#v0.1.0` → expect it to
     fail with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. Record the exact
     `allowBuilds` key pnpm prints.
   - Add that key to the scratch `pnpm-workspace.yaml` under `allowBuilds`
     and rerun → `prepare` builds `dist/`.
   - `pnpm exec propager-relay keygen` prints a key and hash.
   - `node_modules/.bin/propager-relay serve --config <minimal file>` with
     a fake `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` on a free port starts
     listening and `/healthz` answers 503 (no real Slack).
   - Put the recorded key format in the README install section (step 3) as
     a follow-up docs commit if it differs from what's there.
9. **Live verification with the user** (Spec Verification 1–9). Needs the
   user's test Slack workspace and test app tokens; ask for them, and ask
   which ports are free before starting anything. Run each step as the spec
   words it (Socket Mode standalone with two sites; two `dev:site`
   processes; thread replies and "Also send to channel"; echo filtered in
   the log; a third `dev:site` gets `4003`; `--resume` replay; a second
   Socket Mode client → `slackSharedApp: true`; Events API standalone behind
   a tunnel or `tailscale funnel`; `dev:site --role viewer` with `history`
   and `post 5678`). Record pass/fail per step in this file's checklist.
10. After every step passes, a docs commit (with the user's approval, like
    any commit) marks Spec 001 `Complete` and the plan and task files
    `Done`, matching the mps-propager convention.

## Acceptance Criteria

- [x] `pnpm dev:site --url … --key …` connects as a site, prints every
      frame with `epoch` and `seq`, and answers each top-level message with
      "relay saw <text>" in its thread and a 👀.
- [x] `--resume <epoch>:<seq>` sends `resume` in `hello`; `--role viewer`
      accepts `history <channel>` and `post <channel> <text>` from stdin.
- [x] `scripts/dev-site.ts` passes `pnpm typecheck` and is not in the
      package (`pnpm pack --dry-run`).
- [x] README shows v0.1.0 and covers install (with the `allowBuilds`
      entry), keygen, running standalone, Slack app setup for both ingress
      modes (scopes, events, tokens), mounting in h3/Nitro, and viewers.
- [x] The founding ADR has an addendum recording Spec Decision 8's
      refinement of Decision 6 and correcting the "viewers never page" row
      (viewers with `canPost` post, and posts page); the original text is
      unchanged.
- [x] The user approved the merge, tag, and push before any of them ran.
- [x] `v0.1.0` is tagged on the approved commit and pushed. *(annotated tag on merge commit `6dbc09e`, PR #1.)*
- [x] A scratch pnpm 12 consumer installs
      `github:ministryplus/mps-propager-relay#v0.1.0` with the `allowBuilds`
      entry pnpm printed (recorded in the README); `pnpm exec propager-relay
      keygen` works and `propager-relay serve` starts. *(pnpm 12.9.1,
      2026-11-23: first install refused with
      `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`; key is the codeload tarball URL
      for `6dbc09e`, not the `<git url>#<sha>` form the ADR guessed, so the
      ADR addendum records it; `prepare` built `dist/`; `serve` listened,
      `/healthz` 503 with fake tokens, SIGTERM exited cleanly.)*
- [x] Spec Verification 1–10 pass against the test workspace
      (2026-11-23, dedicated test app, sites `north` → `C06Q284BDRT` and
      `south` → `C0CLELAL45P`, viewer `portal` with `canPost`):
  - [x] 1 Socket Mode standalone, `/healthz` connected *(200,
        `slack: connected`, `slackSharedApp: false`; both channels backfilled)*
  - [x] 2 two sites, channel isolation, reply + 👀 *(`1234` in north →
        `north` only, ~0.2 s; reply and react `ok: true`; `south` silent)*
  - [x] 3 thread replies and thread broadcasts are `kind: "thread"` *(plain
        reply and "Also send to channel" both `kind: "thread"` with the
        parent's `threadTs`; the parent's `message_changed` dropped)*
  - [x] 4 relay's own replies never reach a site *(every "relay saw …" echo
        logged as `ignoring own message`)*
  - [x] 5 a third `dev:site` replaces the first with `4003` *(old one got
        `error` 4003 and exited; the new one received `2001` as `seq=4`)*
  - [x] 6 `--resume` replays missed messages, `resumed: true` *(down ~30 s;
        `3001`/`3002` replayed as `seq` 5–6 on `--resume <epoch>:4`)*
  - [x] 7 second Socket Mode client → shared-app warning *(warned in the log
        and `/healthz` when the relay connected while a ProPager held a
        socket on the app, and in a second relay started after it; see
        Notes for the reverse-order gap)*
  - [x] 8 Events API standalone repeats 2–4 *(via `tailscale funnel`; Request
        URL verified; `4001` paged north with reply + 👀, thread reply
        `kind: "thread"`, echo filtered, `south` silent; unsigned POST 401)*
  - [x] 9 viewer sees everything, `history`, `post` pages site A *(history
        returned 13 messages oldest first incl. `fromSelf`; `post … 5678`
        → `north` got `origin: "relay"`, `eventId: "relay:<ts>"` at the same
        instant as the `result`; the echo reached the viewer with
        `fromSelf: true` and was filtered for `north`)*
  - [x] 10 git-dependency install

## Files Changed

| File | Action |
|---|---|
| scripts/dev-site.ts | Create |
| test/scripts/dev-site.test.ts | Create (not in the original plan; see Notes) |
| package.json | Modify (`dev:site` script; `version` only if not already `0.1.0`) |
| README.md | Modify |
| docs/adr/001-founding-propager-relay.md | Modify (addendum) |
| docs/specs/001-relay-v1.md, docs/tasks/001-*.md | Modify (status only, after verification) |

## Verification

Local, before approval:

```
pnpm install && pnpm build && pnpm test && pnpm typecheck
pnpm pack --dry-run          # dist/ and protocol/ only
grep -n "design stage" README.md   # prints nothing
```

`dev:site` against a local server (pick a free port; don't assume 8787 or
3000 is free):

```
SLACK_BOT_TOKEN=xoxb-fake SLACK_SIGNING_SECRET=fake PORT=8790 node dist/standalone/cli.js serve --config ./test.json
pnpm dev:site --url ws://127.0.0.1:8790/ws --key prk_…            # prints welcome, epoch, status
pnpm dev:site --url ws://127.0.0.1:8790/ws --key prk_… --role viewer   # then type: history C0123ABC
```

After approval (tag pushed), in a scratch directory:

```
pnpm --version                                         # 12.x
pnpm add github:ministryplus/mps-propager-relay#v0.1.0 # fails; copy the allowBuilds key
pnpm install                                           # after adding the key: prepare builds dist/
pnpm exec propager-relay keygen
```

Live: Spec Verification 1–9 with the user, checklist above.

## Notes

- **Follow-ups found in live verification (2026-11-23), not fixed in v0.1.0:**
  - **Shared-app detection is one-sided.** Slack reports `num_connections`
    only in `hello`, so a client that connects *after* the relay is seen by
    that client but not by the relay until the relay's next `hello` (Slack
    refreshes about every 5 hours). Matches Spec Decision 4 as written, but
    a ProPager started in Direct mode after the relay goes unnoticed by the
    relay until then.
  - **`dev:site` prints the site key** because it logs the `hello` frame in
    full. Harmless with test keys; it should mask `key` before anyone runs it
    with a production key.

- **Approval is required for every outward-facing step:** the PR or merge
  to `main`, the tag, and each push. A finished local build is not
  approval.
- **The `allowBuilds` key format for the `github:` form is untested**
  (ADR 001 Decision 4's spike used another form). Step 8 records what pnpm
  actually prints; if it differs from the ADR's example, add that to the
  addendum or the README rather than guessing beforehand.
- **Running `.ts` directly:** Node 24 strips types by default, which is why
  `dev:site` avoids non-erasable syntax and imports nothing from `src/`
  (whose imports use `.js` specifiers for `tsc`). If the Node in use prints
  an experimental warning, that's harmless; if it refuses to run the file,
  fall back to building the script with `tsc` into a scratch directory
  rather than adding `tsx` as a dependency without asking.
- **Not in the spec, left as is:** ADR 001 Decision 6 describes viewers as
  read-only subscribers that "never page", while Spec 001 gives viewers
  `canPost` and makes their posts page. The spec names only the Decision 8
  refinement for the addendum; if the user wants, the addendum can mention
  viewer posting in the same section.
- `dev:site` exits on any close instead of reconnecting, which is the
  simplest reading of Decision 13 and what Verification 5 expects.
- **Implementation notes (001-12 steps 1–5, 2026-11-22):**
  - **Automated `dev:site` test:** `test/scripts/dev-site.test.ts` spawns
    `node scripts/dev-site.ts` against `startServer` on an ephemeral port
    with the in-memory `FakeSlackApi`: usage exits 2; as a site it prints
    `hello` (with the package version), `welcome`, `epoch=… resumed=false`,
    `seq=…`, and answers a signed `1234` with `reply` "relay saw 1234" in the
    thread and `react` `eyes`; a second `--resume <epoch>:<seq-1>` instance
    gets `resumed=true` and the replay while the first exits 1 on `4003`;
    `SIGINT` exits 0. As a viewer: help on an unknown line, `history` →
    `history_result`, `post` → `chat.postMessage` with the rest of the line
    as text, end of stdin → close `1000`, exit 0.
  - **Viewer end of input:** not in the steps; `dev:site --role viewer`
    closes with `1000` when stdin ends, so a piped script finishes.
  - **Manual check (step 5):** real CLI `serve` with `xoxb-fake` on
    `127.0.0.1:8793`: `/healthz` 503 while `auth.test` failed with
    `invalid_auth` and retried; `pnpm dev:site` as a site and as a viewer
    both printed `welcome`, `epoch=… resumed=false`, and `status`; `history
    C0123ABC` returned `history_result`; `ping`/`pong` every 25 s; `SIGTERM`
    to the server closed the site with `1001` and it exited 0.
  - **README `allowBuilds` key** uses ADR 001 Decision 4's placeholder
    format (`<resolved git url>#<commit sha>`) and says pnpm prints the
    exact key; step 8 replaces it with the recorded format if it differs.
