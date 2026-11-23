import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSlackApi, SlackApiError } from '../../src/core/slack-api.js';

type Recorded = { path: string; headers: IncomingHttpHeaders; body: string };
type Scripted = { status?: number; headers?: Record<string, string>; json?: unknown; raw?: string; hang?: boolean };

let server: Server;
let baseUrl: string;
let requests: Recorded[] = [];
const queues = new Map<string, Scripted[]>();

function script(method: string, ...responses: Scripted[]): void {
  queues.set(`/api/${method}`, [...(queues.get(`/api/${method}`) ?? []), ...responses]);
}

function requestsTo(method: string): Recorded[] {
  return requests.filter((r) => r.path === `/api/${method}`);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      const path = req.url ?? '';
      requests.push({ path, headers: req.headers, body });
      const r = queues.get(path)?.shift() ?? { json: { ok: true } };
      if (r.hang) return; // never answer
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
      res.end(r.raw ?? JSON.stringify(r.json ?? { ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  queues.clear();
});

const noSleep = async (): Promise<void> => {};

/** A client on a virtual clock: `sleep` advances time instantly. */
function api(extra: Partial<Parameters<typeof createSlackApi>[0]> = {}) {
  let t = 0;
  return createSlackApi({
    botToken: 'xoxb-test',
    baseUrl,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...extra,
  });
}

async function rejection(p: Promise<unknown>): Promise<SlackApiError> {
  const err = await p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SlackApiError);
  return err as SlackApiError;
}

describe('SlackApiError', () => {
  it('carries a code and a name', () => {
    const e = new SlackApiError('channel_not_found');
    expect(e.code).toBe('channel_not_found');
    expect(e.name).toBe('SlackApiError');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain('channel_not_found');
  });
});

describe('auth', () => {
  it('postMessage sends the bot token', async () => {
    script('chat.postMessage', { json: { ok: true, ts: '1.1' } });
    await api().postMessage({ channel: 'C1', text: 'hi' });
    expect(requestsTo('chat.postMessage')[0]!.headers.authorization).toBe('Bearer xoxb-test');
  });

  it('openSocketModeUrl sends the app token and returns the url', async () => {
    script('apps.connections.open', { json: { ok: true, url: 'wss://example/ws' } });
    await expect(api().openSocketModeUrl('xapp-test')).resolves.toBe('wss://example/ws');
    expect(requestsTo('apps.connections.open')[0]!.headers.authorization).toBe('Bearer xapp-test');
  });
});

describe('postMessage', () => {
  it('sends JSON with unfurl_links false and no thread_ts by default', async () => {
    script('chat.postMessage', { json: { ok: true, ts: '1700.0001' } });
    await expect(api().postMessage({ channel: 'C1', text: 'hello' })).resolves.toEqual({ ts: '1700.0001' });
    const req = requestsTo('chat.postMessage')[0]!;
    expect(req.headers['content-type']).toContain('application/json');
    expect(JSON.parse(req.body)).toEqual({ channel: 'C1', text: 'hello', unfurl_links: false });
  });

  it('sends thread_ts when threadTs is given', async () => {
    script('chat.postMessage', { json: { ok: true, ts: '1700.0002' } });
    await api().postMessage({ channel: 'C1', text: 'r', threadTs: '1700.0001' });
    expect(JSON.parse(requestsTo('chat.postMessage')[0]!.body)).toEqual({
      channel: 'C1',
      text: 'r',
      unfurl_links: false,
      thread_ts: '1700.0001',
    });
  });
});

describe('addReaction', () => {
  it('sends channel, timestamp and name', async () => {
    await api().addReaction({ channel: 'C1', ts: '1.2', emoji: 'eyes' });
    const req = requestsTo('reactions.add')[0]!;
    expect(req.headers.authorization).toBe('Bearer xoxb-test');
    expect(JSON.parse(req.body)).toEqual({ channel: 'C1', timestamp: '1.2', name: 'eyes' });
  });

  it('resolves on already_reacted', async () => {
    script('reactions.add', { json: { ok: false, error: 'already_reacted' } });
    await expect(api().addReaction({ channel: 'C1', ts: '1.2', emoji: 'eyes' })).resolves.toBeUndefined();
  });

  it('rejects other Slack errors with their code', async () => {
    script('reactions.add', { json: { ok: false, error: 'channel_not_found' } });
    const e = await rejection(api().addReaction({ channel: 'C1', ts: '1.2', emoji: 'eyes' }));
    expect(e.code).toBe('channel_not_found');
    expect(requestsTo('reactions.add')).toHaveLength(1);
  });

  it('uses unknown_error when ok:false has no error field', async () => {
    script('reactions.add', { json: { ok: false } });
    expect((await rejection(api().addReaction({ channel: 'C1', ts: '1', emoji: 'x' }))).code).toBe('unknown_error');
  });
});

describe('authTest', () => {
  it('maps user_id and bot_id', async () => {
    script('auth.test', { json: { ok: true, user_id: 'U1', bot_id: 'B1', team: 'T' } });
    await expect(api().authTest()).resolves.toEqual({ userId: 'U1', botId: 'B1' });
    const req = requestsTo('auth.test')[0]!;
    expect(req.headers.authorization).toBe('Bearer xoxb-test');
    expect(req.headers['content-type']).toContain('application/x-www-form-urlencoded');
  });

  it('rejects with network when bot_id is missing', async () => {
    script('auth.test', { json: { ok: true, user_id: 'U1' } });
    expect((await rejection(api().authTest())).code).toBe('network');
  });

  it('rejects invalid_auth with its code', async () => {
    script('auth.test', { json: { ok: false, error: 'invalid_auth' } });
    expect((await rejection(api().authTest())).code).toBe('invalid_auth');
  });
});

describe('history', () => {
  it('sends channel and limit form-encoded and returns only the listed fields in order', async () => {
    script('conversations.history', {
      json: {
        ok: true,
        messages: [
          { type: 'message', ts: '3.0', text: 'newest', user: 'U1', thread_ts: '1.0', blocks: [], team: 'T' },
          { type: 'message', subtype: 'bot_message', ts: '2.0', text: 'bot', bot_id: 'B1', attachments: [] },
        ],
        has_more: false,
      },
    });
    const msgs = await api().history({ channel: 'C9', limit: 50 });
    const req = requestsTo('conversations.history')[0]!;
    expect(req.headers.authorization).toBe('Bearer xoxb-test');
    expect(req.headers['content-type']).toContain('application/x-www-form-urlencoded');
    const params = new URLSearchParams(req.body);
    expect(params.get('channel')).toBe('C9');
    expect(params.get('limit')).toBe('50');
    expect(msgs).toEqual([
      { type: 'message', ts: '3.0', text: 'newest', user: 'U1', thread_ts: '1.0' },
      { type: 'message', subtype: 'bot_message', ts: '2.0', text: 'bot', bot_id: 'B1' },
    ]);
    expect(Object.keys(msgs[0]!)).not.toContain('blocks');
  });

  it('returns [] when messages is missing', async () => {
    script('conversations.history', { json: { ok: true } });
    await expect(api().history({ channel: 'C9', limit: 5 })).resolves.toEqual([]);
  });
});

describe('rate limits', () => {
  it('pauses for Retry-After and retries the same request', async () => {
    const sleeps: number[] = [];
    let t = 1_000_000;
    const client = api({
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    script('chat.postMessage', { status: 429, headers: { 'retry-after': '2' } }, { json: { ok: true, ts: '9.9' } });
    await expect(client.postMessage({ channel: 'C1', text: 'x' })).resolves.toEqual({ ts: '9.9' });
    const reqs = requestsTo('chat.postMessage');
    expect(reqs).toHaveLength(2);
    expect(reqs[1]!.body).toBe(reqs[0]!.body);
    expect(sleeps).toEqual([2000]);
  });

  it('gives up with rate_limited after 4 requests', async () => {
    const r429 = { status: 429, headers: { 'retry-after': '1' } };
    script('chat.postMessage', r429, r429, r429, r429, { json: { ok: true, ts: 'never' } });
    const e = await rejection(api().postMessage({ channel: 'C1', text: 'x' }));
    expect(e.code).toBe('rate_limited');
    expect(requestsTo('chat.postMessage')).toHaveLength(4);
  });

  it('pauses 1000 ms when Retry-After is missing', async () => {
    const sleeps: number[] = [];
    let t = 0;
    const client = api({
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    script('reactions.add', { status: 429 }, { json: { ok: true } });
    await client.addReaction({ channel: 'C1', ts: '1', emoji: 'x' });
    expect(sleeps).toEqual([1000]);
  });

  it('pauses only the rate-limited method', async () => {
    let t = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let sleepCalls = 0;
    const client = api({
      now: () => t,
      sleep: async (ms) => {
        sleepCalls++;
        await held;
        t += ms;
      },
    });
    script(
      'chat.postMessage',
      { status: 429, headers: { 'retry-after': '5' } },
      { json: { ok: true, ts: 'a' } },
      { json: { ok: true, ts: 'b' } },
    );
    const first = client.postMessage({ channel: 'C1', text: 'one' });
    await waitFor(() => sleepCalls === 1);
    const second = client.postMessage({ channel: 'C1', text: 'two' });
    await client.addReaction({ channel: 'C1', ts: '1', emoji: 'x' });
    await waitFor(() => sleepCalls === 2);
    // the second postMessage is waiting on the pause; only the first (429) request reached Slack
    expect(requestsTo('chat.postMessage')).toHaveLength(1);
    expect(requestsTo('reactions.add')).toHaveLength(1);
    release();
    // both retried after the pause; arrival order of the two requests isn't guaranteed
    const answered = [(await first).ts, (await second).ts].sort();
    expect(answered).toEqual(['a', 'b']);
    expect(requestsTo('chat.postMessage')).toHaveLength(3);
  });
});

describe('network errors', () => {
  it('a closed port rejects with network', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const client = createSlackApi({ botToken: 'x', baseUrl: `http://127.0.0.1:${port}/api/`, sleep: noSleep });
    expect((await rejection(client.postMessage({ channel: 'C', text: 't' }))).code).toBe('network');
  });

  it('HTTP 500 rejects with network and is not retried', async () => {
    script('chat.postMessage', { status: 500, json: { ok: false } });
    expect((await rejection(api().postMessage({ channel: 'C', text: 't' }))).code).toBe('network');
    expect(requestsTo('chat.postMessage')).toHaveLength(1);
  });

  it('a non-JSON body rejects with network', async () => {
    script('chat.postMessage', { raw: '<html>oops</html>' });
    expect((await rejection(api().postMessage({ channel: 'C', text: 't' }))).code).toBe('network');
  });

  it('a request that never answers times out with network', async () => {
    script('chat.postMessage', { hang: true });
    const e = await rejection(api({ timeoutMs: 50 }).postMessage({ channel: 'C', text: 't' }));
    expect(e.code).toBe('network');
    expect(requestsTo('chat.postMessage')).toHaveLength(1);
  });
});

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
