#!/usr/bin/env node
// propager-relay: `serve --config <file>` and `keygen` (Spec 001 Decisions 3 and 12).

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generateKey, hashKey } from '../core/index.js';
import { loadConfig, startServer } from './index.js';

const USAGE = `Usage:
  propager-relay serve --config <file>   run the relay (secrets from SLACK_* env vars; HOST, PORT)
  propager-relay keygen                  print a new site or viewer key and its hash
`;

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
}

const processIo: CliIo = {
  env: process.env,
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
};

/**
 * Runs one CLI invocation. Resolves to an exit code, or `null` when `serve`
 * started a server that keeps running until SIGTERM/SIGINT.
 */
export async function run(argv: string[], io: CliIo = processIo): Promise<number | null> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { config: { type: 'string' } }, allowPositionals: true, strict: true });
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;

  if (command === 'keygen' && rest.length === 0 && parsed.values.config === undefined) {
    const key = generateKey();
    io.stdout(
      `key:  ${key}   (give this to the site's ProPager; it is not stored anywhere)\n` +
        `hash: ${hashKey(key)}  (put this in the site's keyHashes)\n`,
    );
    return 0;
  }

  if (command === 'serve' && rest.length === 0 && parsed.values.config !== undefined) {
    return serve(parsed.values.config, io);
  }

  io.stderr(USAGE);
  return 2;
}

async function serve(path: string, io: CliIo): Promise<number | null> {
  let file: unknown;
  try {
    file = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    io.stderr(`Cannot read config file ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let server;
  try {
    const config = loadConfig(file, io.env);
    server = await startServer({ config, host: io.env.HOST, port: Number(io.env.PORT) || undefined });
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) process.exit(1); // a second signal exits at once
    stopping = true;
    io.stderr(`${signal} received\n`);
    server.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        io.stderr(`shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  return null;
}

/** True when this file is the process entry point (directly or through a bin symlink). */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2)).then(
    (code) => {
      if (code !== null) process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
