// dev:site: a stand-in ProPager site (or remote viewer) for checking a relay by
// hand (Spec 001 Decision 13). Not part of the package. Node runs this file
// directly with type stripping, so it uses only erasable TypeScript syntax and
// imports only `ws` and Node built-ins (nothing from src/).
//
//   pnpm dev:site --url ws://127.0.0.1:8787/ws --key prk_…
//   pnpm dev:site --url … --key prk_… --resume <epoch>:<seq>
//   pnpm dev:site --url … --key prk_… --role viewer   # then: history <channel> [limit] / post <channel> <text…>

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const USAGE = `Usage: pnpm dev:site --url <ws url> --key <prk_…> [--resume <epoch>:<seq>] [--role site|viewer]`;
const VIEWER_HELP = `Commands:\n  history <channel> [limit]\n  post <channel> <text…>`;
const PING_EVERY_MS = 25_000; // the protocol asks for a frame at least every 30 s

function fail(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      url: { type: 'string' },
      key: { type: 'string' },
      resume: { type: 'string' },
      role: { type: 'string', default: 'site' },
    },
    strict: true,
  }));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const { url, key } = values;
if (!url) fail('--url is required');
if (!key) fail('--key is required');
const role = values.role;
if (role !== 'site' && role !== 'viewer') fail(`--role must be "site" or "viewer", not "${role}"`);

let resume: { epoch: string; seq: number } | undefined;
if (values.resume !== undefined) {
  const m = /^(.+):(\d+)$/.exec(values.resume);
  if (!m) fail('--resume must be <epoch>:<seq>, e.g. k3v9…:41');
  resume = { epoch: m[1]!, seq: Number(m[2]) };
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

function log(text: string): void {
  process.stdout.write(`${new Date().toISOString()} ${text}\n`);
}

const ws = new WebSocket(url);

function send(frame: Record<string, unknown>): void {
  log(`> ${JSON.stringify(frame)}`);
  ws.send(JSON.stringify(frame));
}

let pinger: ReturnType<typeof setInterval> | undefined;

ws.on('open', () => {
  send({
    type: 'hello',
    protocol: 1,
    role,
    key,
    client: { name: 'dev-site', version: pkg.version },
    ...(resume ? { resume } : {}),
  });
  pinger = setInterval(() => send({ type: 'ping' }), PING_EVERY_MS);
  if (role === 'viewer') startViewerCommands();
});

ws.on('message', (data) => {
  const text = String(data);
  log(`< ${text}`);
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  if (frame.type === 'welcome') {
    log(`epoch=${String(frame.epoch)} resumed=${String(frame.resumed)}`);
  } else if (frame.type === 'message') {
    log(`seq=${String(frame.seq)}`);
    if (role === 'site' && frame.kind === 'channel') {
      const channel = frame.channel;
      const ts = frame.ts;
      send({ type: 'reply', id: randomUUID(), channel, threadTs: ts, text: `relay saw ${String(frame.text)}` });
      send({ type: 'react', id: randomUUID(), channel, ts, emoji: 'eyes' });
    }
  }
});

ws.on('close', (code, reason) => {
  if (pinger) clearInterval(pinger);
  log(`closed code=${code} reason=${JSON.stringify(reason.toString())}`);
  process.exit(code === 1000 || code === 1001 ? 0 : 1);
});

ws.on('error', (err) => {
  // A failed connect emits error then close (code 1006), which exits 1.
  log(`error ${err.message}`);
});

function startViewerCommands(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const [command, channel, ...rest] = line.trim().split(/\s+/);
    if (command === 'history' && channel && rest.length <= 1) {
      const limit = rest[0] !== undefined ? Number(rest[0]) : undefined;
      if (limit === undefined || (Number.isInteger(limit) && limit >= 1)) {
        send({ type: 'history', id: randomUUID(), channel, ...(limit !== undefined ? { limit } : {}) });
        return;
      }
    } else if (command === 'post' && channel && rest.length > 0) {
      // The rest of the line, as typed, is the text.
      const text = line.trim().replace(/^post\s+\S+\s+/, '');
      send({ type: 'post', id: randomUUID(), channel, text });
      return;
    }
    if (line.trim() !== '') process.stdout.write(`${VIEWER_HELP}\n`);
  });
  // End of input (Ctrl-D, or the end of a piped script) disconnects.
  rl.on('close', () => ws.close(1000, 'dev-site input ended'));
}

process.on('SIGINT', () => ws.close(1000, 'dev-site stopped'));
process.on('SIGTERM', () => ws.close(1000, 'dev-site stopped'));
