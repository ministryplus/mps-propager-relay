import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  createRelay,
  hashKey,
  type Relay,
  type RelayConfig,
  type RelayMessage,
} from '../../src/core/index.js';
import type { SlackEventSink } from '../../src/core/ingress/events-api.js';
import type { SlackStatus } from '../../src/core/ingress/socket-mode.js';
import type { Logger } from '../../src/core/logger.js';
import { FakeSlackApi } from '../fakes/fake-slack-api.js';
import { createFakeTransport, type FakeTransport } from '../fakes/fake-transport.js';

// Socket Mode is stubbed: 001-9 tests the real client against a fake server.
const socketStub = vi.hoisted(() => ({
  opts: null as null | { appToken: string; sink: SlackEventSink; onStatus(s: SlackStatus): void },
  started: 0,
  stopped: 0,
}));
vi.mock('../../src/core/ingress/socket-mode.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/ingress/socket-mode.js')>();
  return {
    ...real,
    createSocketMode: (o: NonNullable<typeof socketStub.opts>) => {
      socketStub.opts = o;
      return {
        start: async () => void socketStub.started++,
        stop: async () => void socketStub.stopped++,
        status: () => ({ slack: 'disconnected', slackSharedApp: false }),
      };
    },
  };
});

const SECRET = 'test-signing-secret';
const NOW_MS = 1_700_000_060_000;
const KEYS = { north: 'prk_north', south: 'prk_south', portal: 'prk_portal', wall: 'prk_wall' };
const NORTH = 'C0NORTH';
const SOUTH = 'C0SOUTH';

function makeConfig(over: Partial<RelayConfig> = {}): RelayConfig {
  return {
    slack: { botToken: 'xoxb-test', ingress: { mode: 'events-api', signingSecret: SECRET } },
    sites: [
      { name: 'north', channels: [NORTH], keyHashes: [hashKey(KEYS.north)] },
      { name: 'south', channels: [SOUTH], keyHashes: [hashKey(KEYS.south)] },
    ],
    viewers: [
      { name: 'portal', channels: '*', keyHashes: [hashKey(KEYS.portal)], canPost: true },
      { name: 'wall', channels: [NORTH], keyHashes: [hashKey(KEYS.wall)], canPost: false },
    ],
    limits: { historySize: 5 },
    ...over,
  };
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const tick = () => new Promise<void>((r) => setImmediate(r));
const flush = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

let eventCounter = 0;
function signed(event: Record<string, unknown>, eventId = `Ev${++eventCounter}`) {
  const body = JSON.stringify({ type: 'event_callback', event_id: eventId, event });
  const ts = String(Math.floor(NOW_MS / 1000));
  const sig = 'v0=' + createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex');
  return [body, { 'X-Slack-Signature': sig, 'X-Slack-Request-Timestamp': ts }] as const;
}

let msgCounter = 0;
/** A fresh Slack `ts` 10 s before NOW (well inside maxEventAgeMs). */
function freshTs() {
  return `1700000050.${String(++msgCounter).padStart(6, '0')}`;
}

type Client = FakeTransport & { conn: ReturnType<Relay['openConnection']>; frame(f: unknown): void };

function setup(o: { config?: RelayConfig; slackApi?: FakeSlackApi } = {}) {
  const slackApi = o.slackApi ?? new FakeSlackApi();
  const relay = createRelay({ config: o.config ?? makeConfig(), slackApi, logger: silent, now: () => NOW_MS });
  relays.push(relay);

  function connect(role: 'site' | 'viewer', key: string, extra: Record<string, unknown> = {}): Client {
    const fake = createFakeTransport();
    const conn = relay.openConnection(fake.transport);
    const c: Client = { ...fake, conn, frame: (f) => conn.receive(JSON.stringify(f)) };
    // Keep `sent`/`closedWith` live (they're on `fake`).
    Object.defineProperty(c, 'closedWith', { get: () => fake.closedWith });
    c.frame({ type: 'hello', protocol: 1, role, key, client: { name: 'test', version: '0.0.0' }, ...extra });
    return c;
  }

  async function event(ev: Record<string, unknown>, eventId?: string) {
    const [body, headers] = signed(ev, eventId);
    const r = await relay.handleSlackEvent(body, headers);
    await flush();
    return r;
  }

  return { relay, slackApi, connect, event };
}

const relays: Relay[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  socketStub.opts = null;
  socketStub.started = socketStub.stopped = 0;
});

afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop();
  vi.useRealTimers();
});

const ofType = (c: { sent: unknown[] }, type: string) =>
  c.sent.filter((f): f is Record<string, unknown> => (f as { type: string }).type === type);

describe('createRelay', () => {
  it('1. throws ConfigError for an invalid config before any Slack call', () => {
    const slackApi = new FakeSlackApi();
    const config = makeConfig();
    config.sites[1]!.channels = [NORTH];
    expect(() => createRelay({ config, slackApi, logger: silent })).toThrow(ConfigError);
    expect(slackApi.calls).toEqual([]);
  });

  it('start() runs once: auth.test once, a second call returns the same promise', async () => {
    const { relay, slackApi } = setup();
    const p = relay.start();
    expect(relay.start()).toBe(p);
    await p;
    expect(slackApi.callsTo('authTest')).toHaveLength(1);
  });

  it('2. page round trip over the Events API', async () => {
    const { relay, slackApi, connect, event } = setup();
    await relay.start();
    const a = connect('site', KEYS.north);
    const b = connect('site', KEYS.south);
    expect(a.sent[0]).toMatchObject({ type: 'welcome', role: 'site', name: 'north', channels: [NORTH] });
    expect(a.sent[1]).toEqual({ type: 'status', slack: 'connected', slackSharedApp: false });

    const ts = freshTs();
    expect(await event({ type: 'message', channel: NORTH, ts, text: '1234', user: 'U1' })).toEqual({ status: 200 });
    expect(ofType(a, 'message')).toEqual([
      expect.objectContaining({ type: 'message', seq: 1, kind: 'channel', channel: NORTH, ts, text: '1234' }),
    ]);
    expect(ofType(b, 'message')).toEqual([]);

    a.frame({ type: 'reply', id: 'r1', channel: NORTH, threadTs: ts, text: 'Got it' });
    await flush();
    expect(slackApi.callsTo('postMessage').map((c) => c.args)).toEqual([
      { channel: NORTH, text: 'Got it', threadTs: ts },
    ]);
    expect(ofType(a, 'result')).toEqual([{ type: 'result', id: 'r1', ok: true, ts: expect.any(String) }]);
  });

  it('3. echo filter: the bot’s own message skips the site but reaches viewers and history', async () => {
    const { relay, connect, event } = setup();
    await relay.start();
    const a = connect('site', KEYS.north);
    const v = connect('viewer', KEYS.portal);
    const ts = freshTs();
    await event({ type: 'message', channel: NORTH, ts, text: 'on screen', user: 'U_BOT' });

    expect(ofType(a, 'message')).toEqual([]);
    expect(ofType(v, 'message')).toEqual([expect.objectContaining({ ts, fromSelf: true, seq: 1 })]);
    const view = relay.viewer({ name: 'portal' }, () => {});
    expect(view.history(NORTH)).toEqual([expect.objectContaining({ ts, fromSelf: true })]);
  });

  it('4. a viewer post pages the site at once; the echo is filtered and kept once in history', async () => {
    const { relay, connect, event } = setup();
    await relay.start();
    const a = connect('site', KEYS.north);
    const got: RelayMessage[] = [];
    const view = relay.viewer({ name: 'portal' }, (m) => got.push(m));

    const r = await view.post(NORTH, '5678');
    expect(r).toEqual({ ok: true, ts: expect.any(String) });
    const ts = r.ts!;
    expect(ofType(a, 'message')).toEqual([
      expect.objectContaining({ seq: 1, ts, text: '5678', origin: 'relay', eventId: `relay:${ts}` }),
    ]);
    expect(got).toEqual([]);
    expect(view.history(NORTH)).toEqual([expect.objectContaining({ ts, origin: 'relay' })]);

    await event({ type: 'message', channel: NORTH, ts, text: '5678', bot_id: 'B_BOT', user: 'U_BOT' });
    expect(ofType(a, 'message')).toHaveLength(1);
    expect(got).toEqual([expect.objectContaining({ ts, fromSelf: true, origin: 'slack' })]);
    expect(view.history(NORTH)).toEqual([expect.objectContaining({ ts, fromSelf: true, origin: 'slack' })]);
  });

  it('4b. a viewer post with threadTs pages the site as a thread message', async () => {
    const { relay, connect, slackApi } = setup();
    await relay.start();
    const a = connect('site', KEYS.north);
    const view = relay.viewer({ name: 'portal' }, () => {});
    const parent = freshTs();
    expect(await view.post(NORTH, 'reply', parent)).toMatchObject({ ok: true });
    expect(slackApi.callsTo('postMessage')[0]!.args).toEqual({ channel: NORTH, text: 'reply', threadTs: parent });
    expect(ofType(a, 'message')[0]).toMatchObject({ kind: 'thread', threadTs: parent });
  });

  it('5. in-process viewer rules', async () => {
    const { relay, slackApi, event } = setup();
    await relay.start();

    const wall = relay.viewer({ name: 'wall' }, () => {});
    expect(await wall.post(NORTH, 'x')).toEqual({ ok: false, error: 'not_allowed' });
    expect(slackApi.callsTo('postMessage')).toEqual([]);

    expect(() => relay.viewer({ name: 'nope' }, () => {})).toThrow(/nope/);
    expect(() => relay.viewer({ name: 'wall', channels: [NORTH, SOUTH] }, () => {})).toThrow(/C0SOUTH/);

    // A narrowed viewer only sees, posts to, and reads its own channels.
    const narrow = relay.viewer({ name: 'portal', channels: [SOUTH] }, () => {});
    expect(await narrow.post(NORTH, 'x')).toEqual({ ok: false, error: 'not_allowed' });

    const tss = [freshTs(), freshTs(), freshTs()];
    for (const ts of tss) await event({ type: 'message', channel: NORTH, ts, text: ts, user: 'U1' });
    expect(wall.history(NORTH).map((m) => m.ts)).toEqual(tss);
    expect(wall.history(NORTH, 2).map((m) => m.ts)).toEqual(tss.slice(1));
    expect(narrow.history(NORTH)).toEqual([]);
  });

  it('in-process viewers get every message in their channels only, and a throwing listener is isolated', async () => {
    const { relay, event } = setup();
    await relay.start();
    const wallGot: RelayMessage[] = [];
    relay.viewer({ name: 'portal' }, () => {
      throw new Error('listener bug');
    });
    const wall = relay.viewer({ name: 'wall' }, (m) => wallGot.push(m));

    await event({ type: 'message', channel: NORTH, ts: freshTs(), text: 'n', user: 'U1' });
    await event({ type: 'message', channel: SOUTH, ts: freshTs(), text: 's', user: 'U1' });
    await event({ type: 'message', channel: NORTH, ts: '1600000000.000001', text: 'stale', user: 'U1' });
    expect(wallGot.map((m) => m.text)).toEqual(['n', 'stale']);

    wall.close();
    wall.close();
    await event({ type: 'message', channel: NORTH, ts: freshTs(), text: 'after close', user: 'U1' });
    expect(wallGot).toHaveLength(2);
  });

  it('6. a history frame gets backfilled plus live messages, oldest first, only for its channels', async () => {
    const slackApi = new FakeSlackApi().setHistory(NORTH, [
      { type: 'message', ts: '1700000002.000000', text: 'old 2', user: 'U1' },
      { type: 'message', ts: '1700000001.000500', text: 'thread reply', user: 'U1', thread_ts: '1700000001.000000' },
      { type: 'message', ts: '1700000001.000400', text: 'joined', subtype: 'channel_join', user: 'U1' },
      { type: 'message', ts: '1700000001.000000', text: 'old 1', bot_id: 'B_BOT' },
    ]);
    const { relay, connect, event } = setup({ slackApi });
    await relay.start();
    const live = freshTs();
    await event({ type: 'message', channel: NORTH, ts: live, text: 'live', user: 'U1' });

    const v = connect('viewer', KEYS.portal);
    v.frame({ type: 'history', id: 'h1', channel: NORTH });
    v.frame({ type: 'history', id: 'h2', channel: NORTH, limit: 2 });
    await flush();
    const [h1, h2] = ofType(v, 'history_result');
    expect(h1).toMatchObject({ type: 'history_result', id: 'h1', channel: NORTH });
    const msgs = h1!.messages as RelayMessage[];
    expect(msgs.map((m) => m.text)).toEqual(['old 1', 'thread reply', 'old 2', 'live']);
    expect(msgs[0]).toMatchObject({ fromSelf: true, eventId: 'history:C0NORTH:1700000001.000000' });
    expect(msgs[1]).toMatchObject({ kind: 'thread', threadTs: '1700000001.000000' });
    expect((h2!.messages as RelayMessage[]).map((m) => m.text)).toEqual(['old 2', 'live']);

    await event({ type: 'message', channel: SOUTH, ts: freshTs(), text: 'south', user: 'U1' });
    const w = connect('viewer', KEYS.wall);
    w.frame({ type: 'history', id: 'h3', channel: SOUTH });
    await flush();
    expect(ofType(w, 'history_result')).toEqual([{ type: 'history_result', id: 'h3', channel: SOUTH, messages: [] }]);
  });

  it('7. a site resumes across a reconnect', async () => {
    const { relay, connect, event } = setup();
    await relay.start();
    const a = connect('site', KEYS.north);
    const epoch = (a.sent[0] as { epoch: string }).epoch;
    await event({ type: 'message', channel: NORTH, ts: freshTs(), text: 'one', user: 'U1' });
    expect(ofType(a, 'message').map((m) => m.seq)).toEqual([1]);

    a.conn.closed();
    await event({ type: 'message', channel: NORTH, ts: freshTs(), text: 'two', user: 'U1' });
    await event({ type: 'message', channel: NORTH, ts: freshTs(), text: 'three', user: 'U1' });

    const a2 = connect('site', KEYS.north, { resume: { epoch, seq: 1 } });
    expect(a2.sent[0]).toMatchObject({ type: 'welcome', resumed: true, epoch });
    expect(ofType(a2, 'message').map((m) => [m.seq, m.text])).toEqual([
      [2, 'two'],
      [3, 'three'],
    ]);
  });

  it('8. auth.test failure: retried with backoff; bot messages are held back until it succeeds', async () => {
    const slackApi = new FakeSlackApi().script('authTest', new Error('network down'));
    const { relay, connect, event } = setup({ slackApi });
    await expect(relay.start()).resolves.toBeUndefined();
    expect(slackApi.callsTo('history')).toEqual([]);

    const a = connect('site', KEYS.north);
    expect(a.sent[1]).toEqual({ type: 'status', slack: 'disconnected', slackSharedApp: false });
    expect(relay.health().slack).toBe('disconnected');
    await event({ type: 'message', channel: NORTH, ts: freshTs(), text: 'from a bot', bot_id: 'B_OTHER' });
    expect(ofType(a, 'message')).toEqual([]);

    await vi.advanceTimersByTimeAsync(999);
    expect(slackApi.callsTo('authTest')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(slackApi.callsTo('authTest')).toHaveLength(2);
    expect(ofType(a, 'status').at(-1)).toEqual({ type: 'status', slack: 'connected', slackSharedApp: false });
    expect(relay.health().slack).toBe('connected');
    expect(slackApi.callsTo('history').length).toBeGreaterThan(0);

    await event({ type: 'message', channel: NORTH, ts: freshTs(), text: 'from another bot', bot_id: 'B_OTHER' });
    expect(ofType(a, 'message').map((m) => m.text)).toEqual(['from another bot']);
  });

  it('stop() cancels a pending auth.test retry', async () => {
    const slackApi = new FakeSlackApi().script('authTest', new Error('down'));
    const { relay } = setup({ slackApi });
    await relay.start();
    await relay.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(slackApi.callsTo('authTest')).toHaveLength(1);
  });

  it('9. Socket Mode: status comes from the client, events reach the router, handleSlackEvent is 404', async () => {
    const config = makeConfig({
      slack: { botToken: 'xoxb-test', ingress: { mode: 'socket-mode', appToken: 'xapp-test' } },
    });
    const { relay, connect } = setup({ config });
    await relay.start();
    expect(socketStub.started).toBe(1);
    expect(socketStub.opts!.appToken).toBe('xapp-test');

    const [body, headers] = signed({ type: 'message', channel: NORTH, ts: freshTs(), text: 'x', user: 'U1' });
    expect(await relay.handleSlackEvent(body, headers)).toEqual({ status: 404 });

    const a = connect('site', KEYS.north);
    // auth.test succeeded, but in Socket Mode only the socket decides "connected".
    expect(a.sent[1]).toEqual({ type: 'status', slack: 'disconnected', slackSharedApp: false });

    socketStub.opts!.onStatus({ slack: 'connected', slackSharedApp: true });
    expect(a.sent.at(-1)).toEqual({ type: 'status', slack: 'connected', slackSharedApp: true });
    expect(relay.health()).toMatchObject({ slack: 'connected', slackSharedApp: true, ingress: 'socket-mode' });

    const ts = freshTs();
    socketStub.opts!.sink({ eventId: 'EvSock', event: { type: 'message', channel: NORTH, ts, text: '42', user: 'U1' } });
    expect(ofType(a, 'message')).toEqual([expect.objectContaining({ ts, text: '42' })]);

    await relay.stop();
    expect(socketStub.stopped).toBe(1);
  });

  it('10. health() and stop()', async () => {
    const { relay, connect, event } = setup();
    expect(relay.health()).toEqual({
      slack: 'disconnected',
      slackSharedApp: false,
      ingress: 'events-api',
      sites: [
        { name: 'north', connected: false, lastSeenMs: null },
        { name: 'south', connected: false, lastSeenMs: null },
      ],
      viewers: 0,
    });
    await relay.start();
    const a = connect('site', KEYS.north);
    const b = connect('site', KEYS.south);
    const v = connect('viewer', KEYS.portal);
    const got: RelayMessage[] = [];
    relay.viewer({ name: 'portal' }, (m) => got.push(m));

    expect(relay.health()).toEqual({
      slack: 'connected',
      slackSharedApp: false,
      ingress: 'events-api',
      sites: [
        { name: 'north', connected: true, lastSeenMs: NOW_MS },
        { name: 'south', connected: true, lastSeenMs: NOW_MS },
      ],
      viewers: 2,
    });

    await relay.stop();
    for (const c of [a, b, v]) expect(c.closedWith).toEqual({ code: 1001, reason: 'relay shutting down' });
    await expect(relay.stop()).resolves.toBeUndefined();

    await event({ type: 'message', channel: NORTH, ts: freshTs(), text: 'late', user: 'U1' });
    expect(got).toEqual([]);
  });
});
