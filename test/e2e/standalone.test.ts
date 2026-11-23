// End to end: the standalone server on an ephemeral port, a real `ws` client as
// a site, a signed Events API POST in, and a fake Slack Web API over HTTP.
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { generateKey, hashKey, type Logger, type RelayConfig } from '../../src/core/index.js';
import { createSlackApi } from '../../src/core/slack-api.js';
import { startServer } from '../../src/standalone/index.js';

const SECRET = 'e2e-signing-secret';
const CHANNEL = 'C0E2E';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

interface Recorded {
  method: string;
  body: Record<string, unknown>;
}

/** A fake Slack Web API on 127.0.0.1: records every request and answers the methods the relay calls. */
async function startFakeSlack(): Promise<{ server: Server; baseUrl: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  let n = 0;
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const method = (req.url ?? '').replace(/^\/api\//, '');
      const body = (req.headers['content-type'] ?? '').startsWith('application/json')
        ? (JSON.parse(raw) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(raw));
      requests.push({ method, body });
      const answer =
        method === 'auth.test'
          ? { ok: true, user_id: 'U_BOT', bot_id: 'B_BOT' }
          : method === 'conversations.history'
            ? { ok: true, messages: [] }
            : method === 'chat.postMessage'
              ? { ok: true, ts: `1800000000.${String(++n).padStart(6, '0')}` }
              : { ok: false, error: 'unknown_method' };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`, requests };
}

/** Collects every frame a client receives; `next(type)` waits for the first unseen one of that type. */
function frames(client: WebSocket) {
  const seen: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  client.on('message', (d) => {
    seen.push(JSON.parse(String(d)) as Record<string, unknown>);
    for (const w of waiters.splice(0)) w();
  });
  const taken = new Set<number>();
  return {
    seen,
    async next(type: string): Promise<Record<string, unknown>> {
      const deadline = Date.now() + 3_000;
      for (;;) {
        const i = seen.findIndex((f, idx) => f.type === type && !taken.has(idx));
        if (i >= 0) {
          taken.add(i);
          return seen[i]!;
        }
        if (Date.now() > deadline) throw new Error(`no ${type} frame; saw ${JSON.stringify(seen)}`);
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

describe('standalone server end to end', () => {
  const key = generateKey();
  let slack: Awaited<ReturnType<typeof startFakeSlack>>;
  let relay: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  let stopped = false;

  beforeAll(async () => {
    slack = await startFakeSlack();
    const config: RelayConfig = {
      slack: { botToken: 'xoxb-e2e', ingress: { mode: 'events-api', signingSecret: SECRET } },
      sites: [{ name: 'north', channels: [CHANNEL], keyHashes: [hashKey(key)] }],
    };
    relay = await startServer({
      config,
      host: '127.0.0.1',
      port: 0,
      logger: silent,
      slackApi: createSlackApi({ botToken: 'xoxb-e2e', baseUrl: slack.baseUrl }),
    });
    base = `127.0.0.1:${relay.port}`;
  });

  afterAll(async () => {
    if (!stopped) await relay?.stop();
    slack?.server.closeAllConnections();
    await new Promise<void>((r) => (slack ? slack.server.close(() => r()) : r()));
  });

  it('pages a site from a signed event, posts its reply to Slack, and closes it with 1001 on stop', async () => {
    expect(relay.port).toBeGreaterThan(0);

    // GET /healthz → 200 once auth.test has succeeded (startServer awaits relay.start()).
    const health = await fetch(`http://${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ slack: 'connected', ingress: 'events-api' });
    expect(slack.requests.map((r) => r.method)).toContain('auth.test');

    // The site connects and says hello.
    const client = new WebSocket(`ws://${base}/ws`);
    const f = frames(client);
    const closed = new Promise<number>((r) => client.once('close', (code) => r(code)));
    await new Promise((r, j) => client.once('open', r).once('error', j));
    client.send(
      JSON.stringify({ type: 'hello', protocol: 1, role: 'site', key, client: { name: 'e2e', version: '0.0.0' } }),
    );
    expect(await f.next('welcome')).toMatchObject({ role: 'site', name: 'north', channels: [CHANNEL] });
    expect(await f.next('status')).toMatchObject({ slack: 'connected' });

    // A signed event_callback in → a message frame out.
    const ts = `${Math.floor(Date.now() / 1000)}.000100`;
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev_E2E_1',
      event: { type: 'message', channel: CHANNEL, user: 'U_PERSON', text: '1234', ts },
    });
    const post = await fetch(`http://${base}/slack/events`, { method: 'POST', headers: signed(body), body });
    expect(post.status).toBe(200);
    await post.text();
    expect(await f.next('message')).toMatchObject({ text: '1234', kind: 'channel', channel: CHANNEL, ts });

    // The site replies → chat.postMessage on the fake Slack → a result frame.
    client.send(JSON.stringify({ type: 'reply', id: 'r1', channel: CHANNEL, threadTs: ts, text: 'on it' }));
    const result = await f.next('result');
    const posted = slack.requests.filter((r) => r.method === 'chat.postMessage');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatchObject({ channel: CHANNEL, thread_ts: ts, text: 'on it', unfurl_links: false });
    expect(result).toEqual({ type: 'result', id: 'r1', ok: true, ts: '1800000000.000001' });

    // An unsigned post is refused.
    const forged = await fetch(`http://${base}/slack/events`, { method: 'POST', body });
    expect(forged.status).toBe(401);
    await forged.text();

    // Upgrades on any other path are refused.
    const stray = new WebSocket(`ws://${base}/elsewhere`);
    await expect(
      new Promise((resolve, reject) => {
        stray.once('open', () => resolve('opened'));
        stray.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        stray.once('error', reject);
      }),
    ).rejects.toThrow();
    stray.terminate();

    // stop() → the site sees 1001.
    stopped = true;
    await relay.stop();
    expect(await closed).toBe(1001);
    await expect(fetch(`http://${base}/healthz`)).rejects.toThrow();
  });
});
