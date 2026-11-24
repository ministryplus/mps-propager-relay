// scripts/dev-site.ts as a child process (Node type stripping) against the
// standalone server on an ephemeral port with an in-memory Slack API.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKey, hashKey, type Logger, type RelayConfig } from '../../src/core/index.js';
import { startServer } from '../../src/standalone/index.js';
import { FakeSlackApi } from '../fakes/fake-slack-api.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/dev-site.ts', import.meta.url));
const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const SECRET = 'dev-site-signing-secret';
const CHANNEL = 'C0DEVSITE';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

interface DevSite {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  /** Resolves with the first output line (after `from`) matching `re`. */
  waitFor(re: RegExp, from?: number): Promise<string>;
  exited: Promise<number | null>;
}

const children: ChildProcessWithoutNullStreams[] = [];

function devSite(args: string[]): DevSite {
  const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: 'pipe' });
  children.push(child);
  const lines: string[] = [];
  let buf = '';
  const waiters: (() => void)[] = [];
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop()!;
    lines.push(...parts);
    for (const w of waiters.splice(0)) w();
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  return {
    child,
    lines,
    exited,
    async waitFor(re, from = 0) {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const hit = lines.slice(from).find((l) => re.test(l));
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`no line matching ${re}; stdout:\n${lines.join('\n')}\nstderr:\n${stderr}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
  };
}

function signed(body: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex');
  return { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig };
}

describe('dev:site', () => {
  const siteKey = generateKey();
  const viewerKey = generateKey();
  const slack = new FakeSlackApi();
  let server: Awaited<ReturnType<typeof startServer>>;
  let url: string;
  let n = 0;

  async function slackMessage(text: string): Promise<string> {
    const ts = `${Math.floor(Date.now() / 1000)}.${String(++n).padStart(6, '0')}`;
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: `Ev_DEV_${n}`,
      event: { type: 'message', channel: CHANNEL, user: 'U_PERSON', text, ts },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/slack/events`, { method: 'POST', headers: signed(body), body });
    expect(res.status).toBe(200);
    await res.text();
    return ts;
  }

  async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out; Slack calls: ${JSON.stringify(slack.calls)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    const config: RelayConfig = {
      slack: { botToken: 'xoxb-dev', ingress: { mode: 'events-api', signingSecret: SECRET } },
      sites: [{ name: 'north', channels: [CHANNEL], keyHashes: [hashKey(siteKey)] }],
      viewers: [{ name: 'portal', channels: '*', keyHashes: [hashKey(viewerKey)], canPost: true }],
    };
    server = await startServer({ config, host: '127.0.0.1', port: 0, logger: silent, slackApi: slack });
    url = `ws://127.0.0.1:${server.port}/ws`;
  });

  afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('exits 2 with usage when --url or --key is missing', async () => {
    const d = devSite(['--key', siteKey]);
    expect(await d.exited).toBe(2);
  });

  it('as a site: prints welcome and seq, replies "relay saw …" in the thread with 👀, resumes, and stops on 4003', async () => {
    const site = devSite(['--url', url, '--key', siteKey]);
    const hello = await site.waitFor(/> \{"type":"hello"/);
    expect(hello).toContain(`"client":{"name":"dev-site","version":"${VERSION}"}`);
    // The key is masked in the log: enough to tell keys apart, never the key itself.
    expect(hello).not.toContain(siteKey);
    expect(hello).toContain(`"key":"prk_…${siteKey.slice(-4)}"`);
    await site.waitFor(/< \{"type":"welcome"/);
    const epoch = /epoch=(\S+) resumed=false/.exec(await site.waitFor(/epoch=/))![1]!;
    await site.waitFor(/< \{"type":"status"/);

    const ts = await slackMessage('1234');
    await site.waitFor(/< \{"type":"message".*"text":"1234"/);
    const seq = Number(/seq=(\d+)/.exec(await site.waitFor(/seq=\d+/))![1]);
    await until(() => slack.callsTo('postMessage').length === 1 && slack.callsTo('addReaction').length === 1);
    expect(slack.callsTo('postMessage')[0]!.args).toMatchObject({ channel: CHANNEL, threadTs: ts, text: 'relay saw 1234' });
    expect(slack.callsTo('addReaction')[0]!.args).toMatchObject({ channel: CHANNEL, ts, emoji: 'eyes' });
    await site.waitFor(/< \{"type":"result".*"ok":true/);

    // A second connection with the same key replaces the first (4003), which exits 1.
    // It resumes from seq - 1, so the 1234 message is replayed.
    const resumed = devSite(['--url', url, '--key', siteKey, '--resume', `${epoch}:${seq - 1}`]);
    expect(await resumed.waitFor(/> \{"type":"hello"/)).toContain(`"resume":{"epoch":"${epoch}","seq":${seq - 1}}`);
    await resumed.waitFor(new RegExp(`epoch=${epoch} resumed=true`));
    await resumed.waitFor(/< \{"type":"message".*"text":"1234"/);
    expect(await site.exited).toBe(1);
    expect(site.lines.some((l) => l.includes('closed code=4003'))).toBe(true);

    resumed.child.kill('SIGINT');
    expect(await resumed.exited).toBe(0);
  });

  it('as a viewer: sends history and post from stdin, prints help for anything else, and exits at end of input', async () => {
    const viewer = devSite(['--url', url, '--key', viewerKey, '--role', 'viewer']);
    await viewer.waitFor(/< \{"type":"welcome".*"role":"viewer"/);

    viewer.child.stdin.write('nonsense\n');
    await viewer.waitFor(/^ {2}post <channel> <text…>$/);

    viewer.child.stdin.write(`history ${CHANNEL} 5\n`);
    expect(await viewer.waitFor(/> \{"type":"history"/)).toContain(`"channel":"${CHANNEL}","limit":5`);
    await viewer.waitFor(new RegExp(`< \\{"type":"history_result".*"channel":"${CHANNEL}"`));

    const before = slack.callsTo('postMessage').length;
    viewer.child.stdin.write(`post ${CHANNEL} 5678  please\n`);
    await viewer.waitFor(/< \{"type":"result".*"ok":true/);
    expect(slack.callsTo('postMessage')[before]!.args).toMatchObject({ channel: CHANNEL, text: '5678  please' });

    // End of stdin closes the connection with 1000 and exits 0.
    viewer.child.stdin.end();
    expect(await viewer.exited).toBe(0);
    expect(viewer.lines.some((l) => l.includes('closed code=1000'))).toBe(true);
  });
});
