import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, createRouter, toNodeListener } from 'h3';
import crossws from 'crossws/adapters/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { HealthReport, Relay } from '../../src/core/index.js';
import { createRelayHandlers } from '../../src/h3/index.js';

/** A stub Relay that records calls and answers with scripted results. */
function stubRelay() {
  const calls = {
    slackEvents: [] as { rawBody: string; headers: Record<string, string | undefined> }[],
    connections: [] as {
      transport: { send(text: string): void; close(code: number, reason: string): void };
      received: string[];
      closed: number;
    }[],
  };
  let eventResult: Awaited<ReturnType<Relay['handleSlackEvent']>> = { status: 200 };
  let health: HealthReport = {
    slack: 'connected',
    slackSharedApp: false,
    ingress: 'events-api',
    sites: [{ name: 'north', connected: false, lastSeenMs: null }],
    viewers: 0,
  };
  const relay: Relay = {
    start: async () => {},
    stop: async () => {},
    handleSlackEvent: async (rawBody, headers) => {
      calls.slackEvents.push({ rawBody, headers });
      return eventResult;
    },
    openConnection(transport) {
      const c = { transport, received: [] as string[], closed: 0 };
      calls.connections.push(c);
      return { receive: (t) => void c.received.push(t), closed: () => void c.closed++ };
    },
    viewer: () => {
      throw new Error('not used');
    },
    health: () => health,
  };
  return {
    relay,
    calls,
    setEventResult: (r: typeof eventResult) => void (eventResult = r),
    setHealth: (h: HealthReport) => void (health = h),
  };
}

let stub: ReturnType<typeof stubRelay>;
let server: Server;
let base: string;
let ws: ReturnType<typeof crossws>;

beforeEach(async () => {
  stub = stubRelay();
  const h = createRelayHandlers(stub.relay);
  const app = createApp();
  app.use(createRouter().post('/slack/events', h.slackEvents).get('/ws', h.socket).get('/healthz', h.health));
  server = createServer(toNodeListener(app));
  ws = crossws(app.websocket);
  server.on('upgrade', (req, socket, head) => void ws.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  ws.closeAll(1001, 'test over', true);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Resolves when `cond` holds, polling every few ms (fails after 2 s). */
async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('slackEvents', () => {
  it('passes the exact raw body and lowercase headers, and returns the relay response unchanged', async () => {
    stub.setEventResult({ status: 200, headers: { 'content-type': 'text/plain', 'x-extra': 'yes' }, body: 'chal-123' });
    const raw = '{"type":"url_verification",  "challenge":"chal-123"}\n';
    const res = await fetch(`http://${base}/slack/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Slack-Signature': 'v0=abc', 'X-Slack-Request-Timestamp': '42' },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('x-extra')).toBe('yes');
    expect(await res.text()).toBe('chal-123');

    expect(stub.calls.slackEvents).toHaveLength(1);
    const [call] = stub.calls.slackEvents;
    expect(call!.rawBody).toBe(raw);
    expect(call!.headers['x-slack-signature']).toBe('v0=abc');
    expect(call!.headers['x-slack-request-timestamp']).toBe('42');
  });

  it('returns a non-200 status with an empty body', async () => {
    stub.setEventResult({ status: 401 });
    const res = await fetch(`http://${base}/slack/events`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  it('hands an empty string for an empty body', async () => {
    const res = await fetch(`http://${base}/slack/events`, { method: 'POST' });
    await res.text();
    expect(stub.calls.slackEvents[0]!.rawBody).toBe('');
  });
});

describe('health', () => {
  it('returns the HealthReport with 200 when Slack is connected', async () => {
    const res = await fetch(`http://${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual(stub.relay.health());
  });

  it('returns 503 when Slack is disconnected', async () => {
    const report: HealthReport = { ...stub.relay.health(), slack: 'disconnected' };
    stub.setHealth(report);
    const res = await fetch(`http://${base}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(report);
  });
});

describe('socket', () => {
  it('answers a plain GET /ws with 426', async () => {
    const res = await fetch(`http://${base}/ws`);
    expect(res.status).toBe(426);
    await res.text();
    expect(stub.calls.connections).toHaveLength(0);
  });

  it('maps each peer to one openConnection: text frames reach receive, close reaches closed', async () => {
    const client = new WebSocket(`ws://${base}/ws`);
    const fromServer: string[] = [];
    client.on('message', (d) => fromServer.push(String(d)));
    await new Promise((r, j) => client.once('open', r).once('error', j));

    await until(() => stub.calls.connections.length === 1);
    const conn = stub.calls.connections[0]!;

    client.send('{"type":"ping"}');
    client.send('second');
    await until(() => conn.received.length === 2);
    expect(conn.received).toEqual(['{"type":"ping"}', 'second']);

    conn.transport.send('{"type":"pong"}');
    await until(() => fromServer.length === 1);
    expect(fromServer).toEqual(['{"type":"pong"}']);

    client.close(1000, 'bye');
    await until(() => conn.closed === 1);
    expect(stub.calls.connections).toHaveLength(1);
  });

  it('closes the peer with the code and reason the relay gives', async () => {
    const client = new WebSocket(`ws://${base}/ws`);
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      client.once('close', (code, reason) => r({ code, reason: String(reason) })),
    );
    await new Promise((r, j) => client.once('open', r).once('error', j));
    await until(() => stub.calls.connections.length === 1);
    const conn = stub.calls.connections[0]!;

    conn.transport.close(4001, 'unauthorized');
    expect(await closed).toEqual({ code: 4001, reason: 'unauthorized' });
    await until(() => conn.closed === 1);
  });

  it('keeps two peers apart', async () => {
    const a = new WebSocket(`ws://${base}/ws`);
    const b = new WebSocket(`ws://${base}/ws`);
    await Promise.all([a, b].map((c) => new Promise((r, j) => c.once('open', r).once('error', j))));
    await until(() => stub.calls.connections.length === 2);

    a.send('from-a');
    b.send('from-b');
    await until(() => stub.calls.connections.every((c) => c.received.length === 1));
    expect(stub.calls.connections.map((c) => c.received[0]).sort()).toEqual(['from-a', 'from-b']);

    a.close();
    await until(() => stub.calls.connections.some((c) => c.closed === 1));
    const conns = stub.calls.connections;
    const [ca, cb] = conns[0]!.received[0] === 'from-a' ? conns : [...conns].reverse();
    expect(ca!.closed).toBe(1);
    expect(cb!.closed).toBe(0);
    b.close();
    await until(() => cb!.closed === 1);
  });
});
