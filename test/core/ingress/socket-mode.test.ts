import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { SlackEventSink } from '../../../src/core/ingress/events-api.js';
import {
  createSocketMode,
  createWatchdog,
  nextBackoffMs,
  type SlackStatus,
  type SocketModeTiming,
} from '../../../src/core/ingress/socket-mode.js';
import type { Logger } from '../../../src/core/logger.js';
import { FakeSlackApi } from '../../fakes/fake-slack-api.js';
import {
  startFakeSocketModeServer,
  type FakeConn,
  type FakeSocketModeServer,
} from '../../fakes/fake-socket-mode-server.js';

const APP_TOKEN = 'xapp-test-token';
const PLACEHOLDER_URL = 'ws://127.0.0.1:0/fake';

/** Short real-time timing for socket tests; fake timers stall `ws` I/O. */
const TIMING: SocketModeTiming = {
  pingIntervalMs: 40,
  staleAfterMs: 120,
  backoffBaseMs: 20,
  backoffMaxMs: 160,
  refreshIntervalMs: 60_000, // off for these tests unless one overrides it
};

// The real send, so the spy in the ack-order test can call through.
const origSend = WebSocket.prototype.send;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Level = 'debug' | 'info' | 'warn' | 'error';
function recordingLogger() {
  const calls: { level: Level; text: string }[] = [];
  const rec =
    (level: Level) =>
    (...args: unknown[]) =>
      calls.push({ level, text: args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ') });
  const logger: Logger = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
  return { logger, calls, at: (level: Level) => calls.filter((c) => c.level === level) };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(
  o: {
    server?: { autoHello?: boolean; autoPong?: boolean };
    timing?: Partial<SocketModeTiming>;
    sink?: SlackEventSink;
  } = {},
) {
  const server: FakeSocketModeServer = await startFakeSocketModeServer(o.server);
  cleanups.push(() => server.stop());

  // FakeSlackApi answers apps.connections.open with a placeholder; point it at the fake server.
  const api = new FakeSlackApi();
  const openTimes: number[] = [];
  const original = api.openSocketModeUrl.bind(api);
  api.openSocketModeUrl = async (token: string) => {
    openTimes.push(Date.now());
    const url = await original(token);
    return url === PLACEHOLDER_URL ? server.url() : url;
  };
  const opens = () => api.callsTo('openSocketModeUrl').length;

  const sunk: Parameters<SlackEventSink>[0][] = [];
  const statuses: SlackStatus[] = [];
  const log = recordingLogger();
  const client = createSocketMode({
    appToken: APP_TOKEN,
    slackApi: api,
    sink: o.sink ?? ((e) => sunk.push(e)),
    logger: log.logger,
    onStatus: (s) => statuses.push({ ...s }),
    timing: { ...TIMING, ...o.timing },
  });
  cleanups.push(() => client.stop());
  return { server, api, opens, openTimes, client, sunk, statuses, log };
}

/** Starts the client and returns its first connection after the status says connected. */
async function startConnected(ctx: Awaited<ReturnType<typeof setup>>): Promise<FakeConn> {
  await ctx.client.start();
  const conn = await ctx.server.nextConnection();
  await vi.waitFor(() => expect(ctx.client.status().slack).toBe('connected'));
  return conn;
}

describe('nextBackoffMs', () => {
  it('starts at base, doubles, and caps at max', () => {
    const seq: number[] = [];
    let cur = 0;
    for (let i = 0; i < 9; i++) {
      cur = nextBackoffMs(cur, 1000, 60_000);
      seq.push(cur);
    }
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });
});

describe('watchdog (fake timers)', () => {
  function make() {
    vi.useFakeTimers();
    const ping = vi.fn();
    const expire = vi.fn();
    const wd = createWatchdog({ pingIntervalMs: 10_000, staleAfterMs: 30_000, ping, expire });
    return { wd, ping, expire };
  }

  it('pings every interval while activity is noted', () => {
    const { wd, ping, expire } = make();
    vi.advanceTimersByTime(9_000);
    wd.noteActivity();
    vi.advanceTimersByTime(1_000);
    expect(ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9_000);
    wd.noteActivity();
    vi.advanceTimersByTime(1_000);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(expire).not.toHaveBeenCalled();
    wd.stop();
  });

  it('expires at the first check at or past staleAfterMs with no activity, then stays silent', () => {
    const { ping, expire } = make();
    vi.advanceTimersByTime(20_000);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('stop() silences it', () => {
    const { wd, ping, expire } = make();
    wd.stop();
    vi.advanceTimersByTime(120_000);
    expect(ping).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });
});

describe('socket mode: connect and hello', () => {
  it('opens one URL with the app token and reports connected only after hello', async () => {
    const ctx = await setup({ server: { autoHello: false } });
    await ctx.client.start();
    const conn = await ctx.server.nextConnection();
    expect(ctx.api.callsTo('openSocketModeUrl')).toEqual([{ method: 'openSocketModeUrl', args: APP_TOKEN }]);
    await sleep(20);
    expect(ctx.statuses).toEqual([]);
    expect(ctx.client.status()).toEqual({ slack: 'disconnected', slackSharedApp: false });

    conn.sendHello(1);
    await vi.waitFor(() => expect(ctx.statuses).toHaveLength(1));
    expect(ctx.statuses).toEqual([{ slack: 'connected', slackSharedApp: false }]);
    expect(ctx.client.status()).toEqual({ slack: 'connected', slackSharedApp: false });
    expect(ctx.opens()).toBe(1);
  });

  it('a malformed frame is logged at warn and does not break the socket', async () => {
    const ctx = await setup();
    const conn = await startConnected(ctx);
    conn.sendRaw('{not json');
    const id = conn.sendEvent({ eventId: 'Ev1', event: { type: 'message' } });
    await conn.waitForAck(id);
    await vi.waitFor(() => expect(ctx.sunk).toHaveLength(1));
    expect(ctx.log.at('warn').length).toBeGreaterThanOrEqual(1);
  });
});

describe('socket mode: ack and sink', () => {
  it('acks on the same socket before the sink runs, and sinks { eventId, event }', async () => {
    const order: string[] = [];
    const sunk: Parameters<SlackEventSink>[0][] = [];
    const sendSpy = vi.spyOn(WebSocket.prototype, 'send');
    sendSpy.mockImplementation(function (this: WebSocket, ...args: Parameters<WebSocket['send']>) {
      order.push(`send:${String(args[0])}`);
      return origSend.apply(this, args);
    });
    const ctx = await setup({
      sink: (e) => {
        order.push(`sink:${e.eventId}`);
        sunk.push(e);
      },
    });
    const conn = await startConnected(ctx);
    const event = { type: 'message', channel: 'C1', ts: '1.1', text: 'hi' };
    const id = conn.sendEvent({ eventId: 'Ev1', event });
    await conn.waitForAck(id);
    await vi.waitFor(() => expect(sunk).toHaveLength(1));
    expect(conn.acks).toEqual([id]);
    expect(sunk[0]).toEqual({ eventId: 'Ev1', event });
    const ackIdx = order.indexOf(`send:${JSON.stringify({ envelope_id: id })}`);
    expect(ackIdx).toBeGreaterThanOrEqual(0);
    expect(ackIdx).toBeLessThan(order.indexOf('sink:Ev1'));
  });

  it('acks but does not sink an events_api envelope missing payload.event', async () => {
    const ctx = await setup();
    const conn = await startConnected(ctx);
    const id = conn.sendEvent({ eventId: 'Ev1' });
    await conn.waitForAck(id);
    await sleep(10);
    expect(ctx.sunk).toEqual([]);
    expect(ctx.log.at('warn').length).toBeGreaterThanOrEqual(1);
  });

  it('acks but does not sink other envelope types', async () => {
    const ctx = await setup();
    const conn = await startConnected(ctx);
    conn.sendRaw({ type: 'slash_commands', envelope_id: 'env-slash', payload: { command: '/x' } });
    await conn.waitForAck('env-slash');
    await sleep(10);
    expect(ctx.sunk).toEqual([]);
  });

  it('a throwing sink is logged; the socket keeps acking and delivering', async () => {
    const got: string[] = [];
    const ctx = await setup({
      sink: (e) => {
        got.push(e.eventId);
        if (e.eventId === 'Ev1') throw new Error('sink boom');
      },
    });
    const conn = await startConnected(ctx);
    const a = conn.sendEvent({ eventId: 'Ev1', event: { type: 'message' } });
    const b = conn.sendEvent({ eventId: 'Ev2', event: { type: 'message' } });
    await conn.waitForAck(a);
    await conn.waitForAck(b);
    await vi.waitFor(() => expect(got).toEqual(['Ev1', 'Ev2']));
    expect(ctx.log.at('error').some((c) => c.text.includes('sink boom'))).toBe(true);
    expect(conn.isOpen).toBe(true);
  });
});

describe('socket mode: shared app', () => {
  it('warns and reports slackSharedApp when num_connections exceeds own sockets; clears on a later hello', async () => {
    const ctx = await setup({ server: { autoHello: false } });
    await ctx.client.start();
    const conn = await ctx.server.nextConnection();
    conn.sendHello(2);
    await vi.waitFor(() => expect(ctx.statuses).toHaveLength(1));
    expect(ctx.statuses[0]).toEqual({ slack: 'connected', slackSharedApp: true });
    const warns = ctx.log.at('warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.text).toMatch(/2/);
    expect(warns[0]!.text).toMatch(/another client/i);

    conn.sendHello(1);
    await vi.waitFor(() => expect(ctx.statuses).toHaveLength(2));
    expect(ctx.statuses[1]).toEqual({ slack: 'connected', slackSharedApp: false });
    expect(ctx.log.at('warn')).toHaveLength(1);
  });
});

describe('socket mode: shared-app recheck', () => {
  /** Another Socket Mode client on the same app; from Slack's side, one more connection. */
  async function otherClient(server: FakeSocketModeServer) {
    const ws = new WebSocket(server.url());
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const close = () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', () => resolve());
        ws.close();
      });
    cleanups.push(close);
    return { close };
  }

  it('a periodic handoff detects a client that connected later, and clears once it leaves', async () => {
    const ctx = await setup({ timing: { refreshIntervalMs: 150 } });
    await startConnected(ctx);
    expect(ctx.client.status()).toEqual({ slack: 'connected', slackSharedApp: false });

    const other = await otherClient(ctx.server);
    await vi.waitFor(() => expect(ctx.client.status().slackSharedApp).toBe(true), { timeout: 2000 });
    expect(ctx.opens()).toBeGreaterThanOrEqual(2);
    expect(ctx.log.at('warn').some((w) => /another client/i.test(w.text))).toBe(true);

    await other.close();
    await vi.waitFor(() => expect(ctx.client.status().slackSharedApp).toBe(false), { timeout: 2000 });
    expect(ctx.statuses.every((s) => s.slack === 'connected')).toBe(true);
    expect(ctx.log.at('info').some((l) => /no other client/i.test(l.text))).toBe(true);
  });

  it('logs routine refreshes at debug only, and warns once per shared episode', async () => {
    const ctx = await setup({ timing: { refreshIntervalMs: 100 } });
    await startConnected(ctx);
    const infoAfterConnect = ctx.log.at('info').length;
    await vi.waitFor(() => expect(ctx.opens()).toBeGreaterThanOrEqual(4), { timeout: 2000 });
    expect(ctx.log.at('info')).toHaveLength(infoAfterConnect);
    expect(ctx.log.at('warn')).toHaveLength(0);

    await otherClient(ctx.server);
    const opensAtJoin = ctx.opens();
    await vi.waitFor(() => expect(ctx.opens()).toBeGreaterThanOrEqual(opensAtJoin + 3), { timeout: 2000 });
    expect(ctx.client.status().slackSharedApp).toBe(true);
    expect(ctx.log.at('warn').filter((w) => /another client/i.test(w.text))).toHaveLength(1);
  });

  it('a failed refresh keeps the current socket and tries again next interval', async () => {
    const ctx = await setup({ timing: { refreshIntervalMs: 100 } });
    await startConnected(ctx);
    ctx.api.script('openSocketModeUrl', new Error('ratelimited'));
    await vi.waitFor(() => expect(ctx.opens()).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    expect(ctx.client.status().slack).toBe('connected');
    expect(ctx.statuses.every((s) => s.slack === 'connected')).toBe(true);
  });

  it('stops refreshing after stop()', async () => {
    const ctx = await setup({ timing: { refreshIntervalMs: 60 } });
    await startConnected(ctx);
    await ctx.client.stop();
    const opens = ctx.opens();
    await sleep(200);
    expect(ctx.opens()).toBe(opens);
  });
});

describe('socket mode: graceful handoff', () => {
  it('opens exactly one replacement, keeps acking on the old socket, and closes it after the new hello', async () => {
    const ctx = await setup({ server: { autoHello: false } });
    await ctx.client.start();
    const old = await ctx.server.nextConnection();
    old.sendHello(1);
    await vi.waitFor(() => expect(ctx.statuses).toHaveLength(1));

    old.sendDisconnect('warning');
    old.sendDisconnect('refresh_requested');
    const fresh = await ctx.server.nextConnection();
    await sleep(20);
    expect(ctx.opens()).toBe(2);
    expect(ctx.server.connections).toHaveLength(2);

    const id = old.sendEvent({ eventId: 'EvOld', event: { type: 'message' } });
    await old.waitForAck(id);
    expect(fresh.acks).toEqual([]);
    await vi.waitFor(() => expect(ctx.sunk.map((e) => e.eventId)).toEqual(['EvOld']));
    expect(old.isOpen).toBe(true);

    fresh.sendHello(2);
    expect(await old.closed).toEqual({ code: 1000 });
    expect(fresh.isOpen).toBe(true);
    expect(ctx.client.status()).toEqual({ slack: 'connected', slackSharedApp: false });
    expect(ctx.statuses).toEqual([{ slack: 'connected', slackSharedApp: false }]);

    const id2 = fresh.sendEvent({ eventId: 'EvNew', event: { type: 'message' } });
    await fresh.waitForAck(id2);
    await vi.waitFor(() => expect(ctx.sunk.map((e) => e.eventId)).toEqual(['EvOld', 'EvNew']));
    expect(ctx.opens()).toBe(2);
  });

  it('a failed replacement leaves the active socket serving and does not retry until it closes', async () => {
    const ctx = await setup();
    const conn = await startConnected(ctx);
    ctx.api.script('openSocketModeUrl', new Error('handshake boom'));
    conn.sendDisconnect('warning');
    await vi.waitFor(() => expect(ctx.opens()).toBe(2));
    await sleep(TIMING.backoffBaseMs * 5);
    expect(ctx.opens()).toBe(2);
    expect(ctx.server.connections).toHaveLength(1);
    expect(ctx.log.calls.some((c) => /keeping current connection/.test(c.text))).toBe(true);

    const id = conn.sendEvent({ eventId: 'Ev1', event: { type: 'message' } });
    await conn.waitForAck(id);
    await vi.waitFor(() => expect(ctx.sunk).toHaveLength(1));
    expect(ctx.statuses).toEqual([{ slack: 'connected', slackSharedApp: false }]);

    conn.close(1001);
    const next = await ctx.server.nextConnection();
    expect(ctx.opens()).toBe(3);
    expect(next).toBe(ctx.server.connections[1]);
  });

  it('the active socket dying mid-handoff reports nothing; the replacement takes over on its hello', async () => {
    const ctx = await setup({ server: { autoHello: false } });
    await ctx.client.start();
    const old = await ctx.server.nextConnection();
    old.sendHello(1);
    await vi.waitFor(() => expect(ctx.statuses).toHaveLength(1));

    old.sendDisconnect('refresh_requested');
    const fresh = await ctx.server.nextConnection();
    const infosBefore = ctx.log.calls.length;
    old.close(1001);
    await old.closed;
    // Let the client see the old socket's close before the replacement says hello.
    await vi.waitFor(() =>
      expect(ctx.log.calls.slice(infosBefore).some((c) => /closed/.test(c.text))).toBe(true),
    );
    expect(ctx.client.status().slack).toBe('connected');

    fresh.sendHello(1);
    const id = fresh.sendEvent({ eventId: 'Ev1', event: { type: 'message' } });
    await fresh.waitForAck(id);
    await vi.waitFor(() => expect(ctx.sunk).toHaveLength(1));
    expect(ctx.statuses).toEqual([{ slack: 'connected', slackSharedApp: false }]);
    expect(ctx.opens()).toBe(2);

    // The replacement is now active: its disconnect starts the next handoff.
    fresh.sendDisconnect('warning');
    await ctx.server.nextConnection();
    expect(ctx.opens()).toBe(3);
  });
});

describe('socket mode: liveness', () => {
  it('pings every interval, drops a silent socket after the stale period, and reconnects', async () => {
    const ctx = await setup({ server: { autoPong: false } });
    const first = await startConnected(ctx);
    const t0 = Date.now();
    await first.closed;
    const elapsed = Date.now() - t0;
    expect(first.pings).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeGreaterThanOrEqual(TIMING.staleAfterMs - TIMING.pingIntervalMs);
    await ctx.server.nextConnection();
    await vi.waitFor(() => expect(ctx.statuses).toHaveLength(3));
    expect(ctx.statuses.map((s) => s.slack)).toEqual(['connected', 'disconnected', 'connected']);
  });

  it('pongs keep a quiet socket alive', async () => {
    const ctx = await setup();
    const conn = await startConnected(ctx);
    await sleep(TIMING.staleAfterMs * 2.5);
    expect(conn.isOpen).toBe(true);
    expect(conn.pings).toBeGreaterThanOrEqual(3);
    expect(ctx.opens()).toBe(1);
  });

  it('reconnects when no hello arrives within the stale period', async () => {
    const ctx = await setup({ server: { autoHello: false } });
    await ctx.client.start();
    const first = await ctx.server.nextConnection();
    await first.closed;
    await ctx.server.nextConnection();
    expect(ctx.opens()).toBe(2);
    expect(ctx.statuses).toEqual([]);
  });
});

describe('socket mode: backoff', () => {
  it('backs off 1x, 2x, 4x, 8x base between failed opens, then resets after hello', async () => {
    const base = 25;
    const ctx = await setup({ timing: { backoffBaseMs: base, backoffMaxMs: 1000 } });
    const fail = new Error('open boom');
    ctx.api.script('openSocketModeUrl', fail, fail, fail, fail);
    await ctx.client.start();
    const conn = await ctx.server.nextConnection();
    await vi.waitFor(() => expect(ctx.client.status().slack).toBe('connected'));
    expect(ctx.opens()).toBe(5);

    const gaps = ctx.openTimes.slice(1).map((t, i) => t - ctx.openTimes[i]!);
    const expected = [1, 2, 4, 8].map((k) => k * base);
    gaps.forEach((g, i) => {
      expect(g).toBeGreaterThanOrEqual(expected[i]! - 2);
      expect(g).toBeLessThan(expected[i]! * 2);
    });
    const delays = () =>
      ctx.log.calls.flatMap((c) => (/reconnecting in (\d+) ms/.exec(c.text)?.slice(1) ?? []).map(Number));
    expect(delays()).toEqual(expected);

    const closedAt = Date.now();
    conn.close(1011);
    await ctx.server.nextConnection();
    expect(ctx.openTimes[5]! - closedAt).toBeGreaterThanOrEqual(base - 2);
    expect(delays()).toEqual([...expected, base]);
  });

  it('caps the delay at backoffMaxMs', async () => {
    const ctx = await setup({ timing: { backoffBaseMs: 5, backoffMaxMs: 12 } });
    const fail = new Error('open boom');
    ctx.api.script('openSocketModeUrl', fail, fail, fail, fail);
    await ctx.client.start();
    await ctx.server.nextConnection();
    const delays = ctx.log.calls.flatMap((c) =>
      (/reconnecting in (\d+) ms/.exec(c.text)?.slice(1) ?? []).map(Number),
    );
    expect(delays).toEqual([5, 10, 12, 12]);
  });

  it('start() resolves without rejecting when the first open fails', async () => {
    const ctx = await setup();
    ctx.api.script('openSocketModeUrl', new Error('open boom'));
    await expect(ctx.client.start()).resolves.toBeUndefined();
    expect(ctx.client.status().slack).toBe('disconnected');
    await ctx.server.nextConnection();
  });
});

describe('socket mode: server close without disconnect', () => {
  it('reports disconnected, then reconnects', async () => {
    const ctx = await setup();
    const conn = await startConnected(ctx);
    conn.close(1011);
    await ctx.server.nextConnection();
    await vi.waitFor(() => expect(ctx.statuses).toHaveLength(3));
    expect(ctx.statuses).toEqual([
      { slack: 'connected', slackSharedApp: false },
      { slack: 'disconnected', slackSharedApp: false },
      { slack: 'connected', slackSharedApp: false },
    ]);
  });
});

describe('socket mode: stop', () => {
  it('closes every socket and never reconnects', async () => {
    const ctx = await setup();
    const conn = await startConnected(ctx);
    const statusesBefore = ctx.statuses.length;
    await ctx.client.stop();
    expect(await conn.closed).toEqual({ code: 1000 });
    await sleep(TIMING.backoffMaxMs * 2);
    expect(ctx.server.connections).toHaveLength(1);
    expect(ctx.opens()).toBe(1);
    expect(ctx.statuses).toHaveLength(statusesBefore);
  });

  it('closes both sockets mid-handoff', async () => {
    const ctx = await setup({ server: { autoHello: false } });
    await ctx.client.start();
    const old = await ctx.server.nextConnection();
    old.sendHello(1);
    await vi.waitFor(() => expect(ctx.statuses).toHaveLength(1));
    old.sendDisconnect('warning');
    const fresh = await ctx.server.nextConnection();
    await ctx.client.stop();
    expect(await old.closed).toEqual({ code: 1000 });
    // The replacement may still be mid-handshake on the client side, so its close code varies.
    await fresh.closed;
    expect(fresh.isOpen).toBe(false);
    await sleep(TIMING.backoffMaxMs);
    expect(ctx.opens()).toBe(2);
  });

  it('cancels a pending reconnect', async () => {
    const ctx = await setup({ timing: { backoffBaseMs: 30 } });
    ctx.api.script('openSocketModeUrl', new Error('open boom'));
    await ctx.client.start();
    await ctx.client.stop();
    await sleep(120);
    expect(ctx.opens()).toBe(1);
    expect(ctx.server.connections).toHaveLength(0);
  });

  it('resolves immediately when never started', async () => {
    const ctx = await setup();
    await expect(ctx.client.stop()).resolves.toBeUndefined();
  });
});
