# Task 001-1: Scaffold (package, toolchain, logger, empty entry points)

**Spec:** [001 — Relay v1](../specs/001-relay-v1.md)
**Status:** Complete
**Parallel group:** Wave 1 (solo — every later task needs the package, the toolchain, and `Logger`)
**Depends on:** —
**Blocks:** [001-2](001-2-protocol.md), [001-3](001-3-config-keys.md), [001-4](001-4-slack-api.md), [001-8](001-8-events-api.md)

## What

Create the package skeleton for `@ministryplus/propager-relay` exactly as
Spec 001 Decision 1 describes: `package.json` with the three exports, the
`propager-relay` bin, `files`, `engines`, the pinned `packageManager`, and
the scripts; `pnpm-workspace.yaml` with `minimumReleaseAge: 10080`; the two
tsconfigs (type-check src + tests / build src → `dist/`); Vitest; and
`.gitignore`. **Every dependency in Decision 1 is installed here, up front**
(runtime, peer, and dev), so the parallel tasks in waves 2 and 3 never edit
`package.json` or `pnpm-lock.yaml` (plan Notes). The only code is
`src/core/logger.ts` (`Logger` and `consoleLogger`, as fixed in the plan's
"Interfaces between tasks") and four empty entry points, plus one smoke test.
This task touches more than the usual ~5 files because it is scaffolding;
none of the files contains real behavior beyond the logger.

## Steps

1. **`package.json`.** Start from the abridged block in Decision 1 and fill in:
   - `name` `@ministryplus/propager-relay`, `version` `0.1.0`,
     `"type": "module"`, `"license"` matching `LICENSE`.
   - `exports` exactly as Decision 1 (`.` → `dist/core/index`, `./h3` →
     `dist/h3/index`, `./standalone` → `dist/standalone/index`, each with
     `types` before `default`).
   - `"bin": { "propager-relay": "./dist/standalone/cli.js" }`,
     `"files": ["dist", "protocol"]`, `"engines": { "node": ">=24" }`,
     `"packageManager": "pnpm@12.9.1"`.
   - `scripts`:
     - `build`: `tsc -p tsconfig.build.json`
     - `prepare`: `pnpm run build` (ADR 001 Decision 4: git-dependency installs build on install)
     - `test`: `vitest run`
     - `typecheck`: `tsc -p tsconfig.json --noEmit`
     - `dev:site` is added by [001-12](001-12-release.md) together with
       `scripts/dev-site.ts` (see Notes).
2. **`pnpm-workspace.yaml`** with `minimumReleaseAge: 10080` (Decision 1:
   no dependency version younger than 7 days). Nothing else.
3. **Install every dependency, pinned exactly** (`pnpm add -E` / `-D -E`), so
   the lockfile and `package.json` hold exact versions. With
   `minimumReleaseAge` in place, pnpm picks the newest version at least 7 days old.
   - `dependencies`: `ws` (8.14 or later: task 9's fake Socket Mode server
     uses `autoPong: false`).
   - `peerDependencies`: `"h3": "^1.15.0"`, `"crossws": "^0.3.5"` (ranges,
     as Decision 1 states; added by hand, not with `pnpm add`).
   - `devDependencies`: `typescript`, `vitest`, `@types/node` (a 24.x
     version, matching the runtime), `@types/ws`, `@slack/types` (`3.3.1`
     per Decision 1, or the newest 3.x older than 7 days), `ajv`, `h3`
     (a 1.x satisfying `^1.15.0`, **not** a 2.x release candidate), and
     `crossws` (a 0.3.x satisfying `^0.3.5`).
   - Run installs with pnpm 12.9.1 (pnpm switches to the `packageManager`
     version itself, or use `corepack`), so `pnpm-lock.yaml` is written by
     the pinned version (`lockfileVersion: '9.0'`).
4. **`tsconfig.json`** (type-checking for everything):
   `strict: true`, `module`/`moduleResolution: "NodeNext"`, `target: "ES2023"`,
   `lib: ["ES2023"]`, `types: ["node"]`, `verbatimModuleSyntax: true` (forces
   `import type` for type-only imports, which Decision 1 relies on for
   `@slack/types`), `isolatedModules: true`, `skipLibCheck: true`,
   `noEmit: true`. `include`: `src`, `test`, `scripts`, `vitest.config.ts`.
   Relative imports use `.js` extensions (NodeNext).
5. **`tsconfig.build.json`** extends `tsconfig.json` and overrides:
   `noEmit: false`, `rootDir: "src"`, `outDir: "dist"`, `declaration: true`,
   `sourceMap: true`; `include: ["src"]`. Tests and scripts never land in `dist/`.
6. **`vitest.config.ts`**: `defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } })`.
7. **`.gitignore`**: `dist`, `node_modules` (Spec File Plan).
8. **`src/core/logger.ts`**, exactly the plan interface:
   ```ts
   export interface Logger { debug(...a: unknown[]): void; info(...a: unknown[]): void;
                             warn(...a: unknown[]): void; error(...a: unknown[]): void }
   export const consoleLogger: Logger; // "[relay]" prefix
   ```
   Each method forwards to the matching `console` method with `'[relay]'` as
   the first argument, followed by the caller's arguments unchanged
   (Decision 12: "default console with "[relay]" prefix").
9. **Empty entry points**, each containing only `export {};`:
   `src/core/index.ts`, `src/h3/index.ts`, `src/standalone/index.ts`.
   [001-10](001-10-relay-assembly.md) owns `src/core/index.ts` and fills it;
   [001-11](001-11-h3-standalone.md) fills the other two.
10. **`src/standalone/cli.ts`**: first line `#!/usr/bin/env node`, then
    `export {};`. `tsc` keeps the shebang in `dist/standalone/cli.js`, which
    the `bin` entry points at. [001-11](001-11-h3-standalone.md) adds `serve`/`keygen`.
11. **`test/smoke.test.ts`**:
    - `consoleLogger.info('hello', 42)` calls `console.info` once with
      `('[relay]', 'hello', 42)` (spy with `vi.spyOn`); same for `debug`,
      `warn`, `error`.
    - Dynamically importing `../src/core/index.js`, `../src/h3/index.js`, and
      `../src/standalone/index.js` resolves (the entry points load).

## Acceptance Criteria

- [x] `package.json` matches Decision 1: name, `0.1.0`, `"type": "module"`,
      the three `exports` (types + default), `bin`, `files: ["dist", "protocol"]`,
      `packageManager: "pnpm@12.9.1"`, `engines.node: ">=24"`.
- [x] Scripts `build`, `prepare` (→ `pnpm run build`), `test` (→ `vitest run`),
      and `typecheck` exist and work.
- [x] `ws` is the only runtime dependency; `h3 ^1.15.0` and `crossws ^0.3.5`
      are peer dependencies; every dev dependency listed in Decision 1
      (`typescript`, `vitest`, `@types/node`, `@types/ws`, `@slack/types`,
      `ajv`, `h3`, `crossws`) is installed. Every `dependencies` and
      `devDependencies` version is exact (no `^`/`~`).
- [x] The installed `h3` is 1.x and `crossws` is 0.3.x.
- [x] `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`; `pnpm-lock.yaml`
      is committed and has `lockfileVersion: '9.0'`.
- [x] `tsconfig.json` is `strict`, NodeNext, `verbatimModuleSyntax`, and covers
      `src`, `test`, `scripts`; `tsconfig.build.json` emits only `src` to
      `dist/` with `.d.ts` files.
- [x] `consoleLogger` implements `Logger` and prefixes every line with `[relay]`.
- [x] `pnpm build` produces `dist/core/index.{js,d.ts}`,
      `dist/h3/index.{js,d.ts}`, `dist/standalone/index.{js,d.ts}`, and
      `dist/standalone/cli.js` starting with `#!/usr/bin/env node`.
- [x] `node dist/standalone/cli.js` exits 0 with no output.
- [x] `pnpm install`, `pnpm build`, `pnpm test`, and `pnpm typecheck` all pass.
- [x] `dist/` and `node_modules/` are git-ignored.

## Files Changed

| File | Action |
|---|---|
| package.json | Create |
| pnpm-lock.yaml | Create (generated) |
| pnpm-workspace.yaml | Create |
| tsconfig.json | Create |
| tsconfig.build.json | Create |
| vitest.config.ts | Create |
| .gitignore | Create |
| src/core/logger.ts | Create |
| src/core/index.ts | Create (empty) |
| src/h3/index.ts | Create (empty) |
| src/standalone/index.ts | Create (empty) |
| src/standalone/cli.ts | Create (shebang only) |
| test/smoke.test.ts | Create |

## Verification

1. `pnpm --version` inside the repo prints `12.9.1`.
2. `pnpm install --frozen-lockfile` succeeds on a clean clone (no
   `node_modules`), and `prepare` runs the build as part of it.
3. `pnpm build && ls dist/core/index.js dist/core/index.d.ts dist/h3/index.js dist/standalone/index.js dist/standalone/cli.js`
   lists all five; `head -1 dist/standalone/cli.js` prints `#!/usr/bin/env node`.
4. `node dist/standalone/cli.js; echo $?` prints `0`.
5. `pnpm test` runs `test/smoke.test.ts` and passes.
6. `pnpm typecheck` passes.
7. `pnpm ls --depth 0` shows `ws` under dependencies and the dev
   dependencies above; `h3` is 1.x and `crossws` 0.3.x.
8. `grep -E '"\^|"~' package.json` matches only the two peer ranges.
9. `git status --short` shows no `dist/` or `node_modules/` entries.

## Notes

- **`dev:site` script deferred to 001-12.** Decision 1 lists `dev:site` among
  the scripts, but its target `scripts/dev-site.ts` (Decision 13) is written
  in 001-12. Adding the script entry there avoids a script that points at a
  missing file. Node 24 runs `.ts` files natively (type stripping), so the
  entry can be `node scripts/dev-site.ts` with no new dependency.
- **Peers are not marked optional.** Decision 1 makes `h3`/`crossws` peers
  only. The standalone bin needs them at runtime, so a consumer that runs
  `propager-relay serve` relies on pnpm's default `auto-install-peers=true`
  (Spec Success criterion 7). No `peerDependenciesMeta` is added; 001-12's
  install check confirms this works in the scratch consumer.
- **`tsconfig` options beyond `strict`/ESM** (`verbatimModuleSyntax`,
  `target`, `skipLibCheck`) are the simplest choices consistent with
  Decision 1; the spec doesn't name them.
