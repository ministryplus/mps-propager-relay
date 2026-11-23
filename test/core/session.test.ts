import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateConfig, type RelayLimits } from '../../src/core/config.js';
import { generateKey, hashKey } from '../../src/core/keys.js';
import type { Logger } from '../../src/core/logger.js';
import { createSessionHub, type Principal, type RequestHandler } from '../../src/core/session.js';
import type {
  HistoryFrame,
  HistoryResultFrame,
  PostFrame,
  ReactFrame,
  RelayMessage,
  ReplyFrame,
  ResultFrame,
} from '../../src/protocol/types.js';
import { createFakeTransport } from '../fakes/fake-transport.js';

const EPOCH = 'test-epoch';
const KEYS = { north: generateKey(), south: generateKey(), portal: generateKey(), wall: generateKey() };
const PKG_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

function makeConfig(limits: Partial<RelayLimits> = {}) {
  return validateConfig({
    slack: { botToken: 'xoxb-test', ingress: { mode: 'events-api', signingSecret: 'secret' } },
    sites: [
      { name: 'north', channels: ['C0NORTH'], keyHashes: [hashKey(KEYS.north)] },
      { name: 'south', channels: ['C0SOUTH'], keyHashes: [hashKey(KEYS.south)] },
    ],
    viewers: [
      { name: 'portal', channels: '*', keyHashes: [hashKey(KEYS.portal)], canPost: true },
      { name: 'wall', channels: ['C0NORTH'], keyHashes: [hashKey(KEYS.wall)], canPost: false },
    ],
    limits,
  });
}

type Req = ReplyFrame | ReactFrame | PostFrame | HistoryFrame;
type Answer = ResultFrame | HistoryResultFrame;

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A hub with a scriptable fake RequestHandler. Default answer: ok result echoing the id. */
function setup(limits: Partial<RelayLimits> = {}) {
  const config = makeConfig(limits);
  const calls: { principal: Principal; frame: Req }[] = [];
  let answer: (frame: Req) => Promise<Answer> = async (f) => ({ type: 'result', id: f.id, ok: true, ts: '1.000' });
  const requests: RequestHandler = (principal, frame) => {
    calls.push({ principal, frame });
    return answer(frame);
  };
  const logger = silentLogger();
  const hub = createSessionHub({ config, requests, now: () => Date.now(), logger, epoch: EPOCH });

  function open() {
    const fake = createFakeTransport();
    const conn = hub.openConnection(fake.transport);
    return {
      ...conn,
      fake,
      sent: fake.sent as Record<string, unknown>[],
      frame: (f: unknown) => conn.receive(JSON.stringify(f)),
      types: () => (fake.sent as { type: string }[]).map((f) => f.type),
      messages: () => (fake.sent as { type: string }[]).filter((f) => f.type === 'message') as Record<string, unknown>[],
    };
  }

  function hello(role: 'site' | 'viewer', key: string, extra: Record<string, unknown> = {}) {
    return { type: 'hello', protocol: 1, role, key, client: { name: 'test', version: '0.0.0' }, ...extra };
  }

  /** Open and authenticate as one of the configured names. */
  function login(name: keyof typeof KEYS, extra: Record<string, unknown> = {}) {
    const c = open();
    const role = name === 'north' || name === 'south' ? 'site' : 'viewer';
    c.frame(hello(role, KEYS[name], extra));
    return c;
  }

  return {
    hub,
    config,
    calls,
    logger,
    open,
    hello,
    login,
    setAnswer: (fn: (frame: Req) => Promise<Answer>) => {
      answer = fn;
    },
  };
}

function msg(n: number, channel = 'C0NORTH'): RelayMessage {
  return {
    eventId: `Ev${n}`,
    channel,
    ts: `1700000000.00000${n}`,
    text: `message ${n}`,
    kind: 'channel',
    user: 'U1',
    fromSelf: false,
    origin: 'slack',
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('handshake timeout', () => {
  it('sends error then closes 4004 when no hello arrives in time', () => {
    const t = setup();
    const c = t.open();
    vi.advanceTimersByTime(t.config.limits.handshakeTimeoutMs - 1);
    expect(c.fake.closedWith).toBeNull();
    vi.advanceTimersByTime(1);
    expect(c.sent).toEqual([{ type: 'error', code: 4004, message: 'no hello' }]);
    expect(c.fake.closedWith).toEqual({ code: 4004, reason: 'no hello' });
  });

  it('a hello just before the deadline gets welcome and no close', () => {
    const t = setup();
    const c = t.open();
    vi.advanceTimersByTime(t.config.limits.handshakeTimeoutMs - 1);
    c.frame(t.hello('site', KEYS.north));
    vi.advanceTimersByTime(t.config.limits.handshakeTimeoutMs * 2);
    expect(c.types()).toEqual(['welcome', 'status']);
    expect(c.fake.closedWith).toBeNull();
  });
});

describe('bad frames', () => {
  it('closes 4000 on unparseable JSON, after an error frame', () => {
    const t = setup();
    const c = t.open();
    c.receive('not json');
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toMatchObject({ type: 'error', code: 4000 });
    expect(c.fake.closedWith?.code).toBe(4000);
  });

  it('closes 4000 when the first frame is not hello', () => {
    const t = setup();
    const c = t.open();
    c.frame({ type: 'ping' });
    expect(c.sent).toEqual([{ type: 'error', code: 4000, message: 'expected hello' }]);
    expect(c.fake.closedWith?.code).toBe(4000);
  });

  it('closes 4000 on a frame over maxFrameBytes', () => {
    const t = setup({ maxFrameBytes: 100 });
    const c = t.open();
    const base = JSON.stringify({ type: 'ping', pad: '' });
    const text = JSON.stringify({ type: 'ping', pad: 'x'.repeat(101 - base.length) });
    expect(Buffer.byteLength(text)).toBe(101);
    c.receive(text);
    expect(c.sent).toEqual([{ type: 'error', code: 4000, message: 'frame too large' }]);
    expect(c.fake.closedWith?.code).toBe(4000);
  });

  it('counts bytes, not characters', () => {
    const t = setup({ maxFrameBytes: 100 });
    const c = t.open();
    // 45 two-byte characters: under 100 characters, over 100 bytes.
    c.receive(JSON.stringify({ type: 'ping', pad: 'é'.repeat(45) }));
    expect(c.fake.closedWith?.code).toBe(4000);
  });

  it('closes 4000 on a second hello', () => {
    const t = setup();
    const c = t.login('north');
    c.frame(t.hello('site', KEYS.north));
    expect(c.sent.at(-1)).toEqual({ type: 'error', code: 4000, message: 'unexpected hello' });
    expect(c.fake.closedWith?.code).toBe(4000);
    expect(t.hub.health().sites[0]).toMatchObject({ name: 'north', connected: false });
  });

  it('ignores frames after the connection is closed', () => {
    const t = setup();
    const c = t.open();
    c.receive('not json');
    const count = c.sent.length;
    c.frame(t.hello('site', KEYS.north));
    expect(c.sent).toHaveLength(count);
  });
});

describe('auth', () => {
  it('rejects a wrong key with 4001', () => {
    const t = setup();
    const c = t.open();
    c.frame(t.hello('site', generateKey()));
    expect(c.sent).toEqual([{ type: 'error', code: 4001, message: 'key rejected' }]);
    expect(c.fake.closedWith?.code).toBe(4001);
  });

  it("rejects a site key used with role 'viewer'", () => {
    const t = setup();
    const c = t.open();
    c.frame(t.hello('viewer', KEYS.north));
    expect(c.fake.closedWith?.code).toBe(4001);
  });

  it('answers protocol 2 with an error frame, then 4002', () => {
    const t = setup();
    const c = t.open();
    c.frame({ ...t.hello('site', KEYS.north), protocol: 2 });
    expect(c.sent).toEqual([{ type: 'error', code: 4002, message: 'protocol 1 required' }]);
    expect(c.fake.closedWith?.code).toBe(4002);
  });

  it('never logs the key', () => {
    const t = setup();
    t.login('north');
    t.open().frame(t.hello('site', 'prk_wrong'));
    const logged = JSON.stringify(
      Object.values(t.logger).flatMap((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls),
    );
    expect(logged).not.toContain(KEYS.north);
    expect(logged).not.toContain('prk_wrong');
  });
});

describe('welcome', () => {
  it('a site gets welcome, then status', () => {
    const t = setup();
    const c = t.login('north');
    expect(c.sent).toEqual([
      {
        type: 'welcome',
        protocol: 1,
        role: 'site',
        name: 'north',
        channels: ['C0NORTH'],
        epoch: EPOCH,
        resumed: false,
        relay: { version: PKG_VERSION },
      },
      { type: 'status', slack: 'disconnected', slackSharedApp: false },
    ]);
  });

  it("a viewer on '*' gets every site channel", () => {
    const t = setup();
    const c = t.login('portal');
    expect(c.sent[0]).toMatchObject({
      type: 'welcome',
      role: 'viewer',
      name: 'portal',
      channels: ['C0NORTH', 'C0SOUTH'],
      resumed: false,
    });
  });

  it('generates a random epoch when none is injected', () => {
    const config = makeConfig();
    const make = () =>
      createSessionHub({ config, requests: vi.fn(), now: () => Date.now(), logger: silentLogger() });
    const epochOf = (hub: ReturnType<typeof make>) => {
      const fake = createFakeTransport();
      hub.openConnection(fake.transport).receive(
        JSON.stringify({ type: 'hello', protocol: 1, role: 'site', key: KEYS.north, client: { name: 't', version: '1' } }),
      );
      return (fake.sent[0] as { epoch: string }).epoch;
    };
    const a = epochOf(make());
    const b = epochOf(make());
    expect(a).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe('replace', () => {
  it('a second site connection replaces the first with 4003', () => {
    const t = setup();
    const first = t.login('north');
    const second = t.login('north');
    expect(first.sent.at(-1)).toEqual({ type: 'error', code: 4003, message: 'replaced by a newer connection' });
    expect(first.fake.closedWith?.code).toBe(4003);
    expect(second.fake.closedWith).toBeNull();
    expect(t.logger.warn).toHaveBeenCalled();

    t.hub.toSite('north', msg(1));
    expect(first.messages()).toHaveLength(0);
    expect(second.messages()).toHaveLength(1);

    first.closed();
    expect(t.hub.health().sites.find((s) => s.name === 'north')?.connected).toBe(true);
    t.hub.toSite('north', msg(2));
    expect(second.messages()).toHaveLength(2);
  });

  it('several viewer connections coexist', () => {
    const t = setup();
    const a = t.login('portal');
    const b = t.login('portal');
    t.hub.toViewers(msg(1));
    expect(a.messages()).toHaveLength(1);
    expect(b.messages()).toHaveLength(1);
    expect(a.fake.closedWith).toBeNull();
    expect(t.hub.health().viewers).toBe(2);
  });
});

describe('ping and idle', () => {
  it('answers ping with pong', () => {
    const t = setup();
    const c = t.login('north');
    c.frame({ type: 'ping' });
    expect(c.sent.at(-1)).toEqual({ type: 'pong' });
  });

  it('stays open while pinged every 30 s, then closes 4005 after idleTimeoutMs of silence', () => {
    const t = setup();
    const c = t.login('north');
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(30_000);
      c.frame({ type: 'ping' });
    }
    expect(c.fake.closedWith).toBeNull();
    vi.advanceTimersByTime(t.config.limits.idleTimeoutMs - 1);
    expect(c.fake.closedWith).toBeNull();
    vi.advanceTimersByTime(1);
    expect(c.sent.at(-1)).toEqual({ type: 'error', code: 4005, message: 'idle' });
    expect(c.fake.closedWith?.code).toBe(4005);
    expect(t.hub.health().sites[0]?.connected).toBe(false);
  });

  it('any valid frame resets the idle timer', () => {
    const t = setup();
    const c = t.login('north');
    vi.advanceTimersByTime(t.config.limits.idleTimeoutMs - 1);
    c.frame({ type: 'react', id: 'r1', channel: 'C0NORTH', ts: '1.0', emoji: 'eyes' });
    vi.advanceTimersByTime(t.config.limits.idleTimeoutMs - 1);
    expect(c.fake.closedWith).toBeNull();
  });
});

describe('seq and delivery', () => {
  it('numbers each site message 1, 2, 3 with every RelayMessage field; other sites get none', () => {
    const t = setup();
    const north = t.login('north');
    const south = t.login('south');
    const thread: RelayMessage = { ...msg(3), kind: 'thread', threadTs: '1.000', botId: 'B1', user: undefined };
    delete thread.user;
    t.hub.toSite('north', msg(1));
    t.hub.toSite('north', msg(2));
    t.hub.toSite('north', thread);
    expect(north.messages()).toEqual([
      { type: 'message', seq: 1, ...msg(1) },
      { type: 'message', seq: 2, ...msg(2) },
      { type: 'message', seq: 3, ...thread },
    ]);
    expect(south.messages()).toHaveLength(0);
  });

  it('viewers get only messages in their channels, numbered per connection', () => {
    const t = setup();
    const portal = t.login('portal');
    const wall = t.login('wall');
    const north = t.login('north');
    t.hub.toViewers(msg(1, 'C0SOUTH'));
    t.hub.toViewers(msg(2, 'C0NORTH'));
    expect(portal.messages()).toEqual([
      { type: 'message', seq: 1, ...msg(1, 'C0SOUTH') },
      { type: 'message', seq: 2, ...msg(2, 'C0NORTH') },
    ]);
    expect(wall.messages()).toEqual([{ type: 'message', seq: 1, ...msg(2, 'C0NORTH') }]);
    expect(north.messages()).toHaveLength(0);
  });

  it('logs and ignores an unknown site', () => {
    const t = setup();
    expect(() => t.hub.toSite('nowhere', msg(1))).not.toThrow();
    expect(t.logger.warn).toHaveBeenCalled();
  });

  it('does not deliver to a connection still in handshake', () => {
    const t = setup();
    const pending = t.open();
    t.hub.toViewers(msg(1));
    expect(pending.sent).toHaveLength(0);
  });
});

describe('resume', () => {
  it('replays buffered messages after a matching resume', () => {
    const t = setup();
    const a = t.login('north');
    t.hub.toSite('north', msg(1));
    t.hub.toSite('north', msg(2));
    a.closed();
    expect(t.hub.health().sites[0]?.connected).toBe(false);
    t.hub.toSite('north', msg(3));
    t.hub.toSite('north', msg(4));

    const b = t.login('north', { resume: { epoch: EPOCH, seq: 2 } });
    expect(b.types()).toEqual(['welcome', 'status', 'message', 'message']);
    expect(b.sent[0]).toMatchObject({ resumed: true });
    expect(b.messages().map((m) => m.seq)).toEqual([3, 4]);
    expect(b.messages()[0]).toMatchObject(msg(3));
  });

  it('resumes with nothing replayed when the client saw the latest seq', () => {
    const t = setup();
    const a = t.login('north');
    t.hub.toSite('north', msg(1));
    t.hub.toSite('north', msg(2));
    a.closed();
    const b = t.login('north', { resume: { epoch: EPOCH, seq: 2 } });
    expect(b.sent[0]).toMatchObject({ resumed: true });
    expect(b.types()).toEqual(['welcome', 'status']);
  });

  it('a wrong epoch answers resumed: false and replays nothing', () => {
    const t = setup();
    t.hub.toSite('north', msg(1));
    t.hub.toSite('north', msg(2));
    const b = t.login('north', { resume: { epoch: 'other', seq: 1 } });
    expect(b.sent[0]).toMatchObject({ resumed: false });
    expect(b.types()).toEqual(['welcome', 'status']);
  });

  it('no resume answers resumed: false and replays nothing', () => {
    const t = setup();
    t.hub.toSite('north', msg(1));
    const b = t.login('north');
    expect(b.sent[0]).toMatchObject({ resumed: false });
    expect(b.types()).toEqual(['welcome', 'status']);
  });

  it('an expired seq + 1 answers resumed: false', () => {
    const t = setup();
    t.login('north').closed();
    t.hub.toSite('north', msg(1));
    vi.advanceTimersByTime(t.config.limits.resumeWindowMs + 1);
    const b = t.login('north', { resume: { epoch: EPOCH, seq: 0 } });
    expect(b.sent[0]).toMatchObject({ resumed: false });
    expect(b.types()).toEqual(['welcome', 'status']);
  });

  it('an evicted seq + 1 answers resumed: false; later messages keep the next seq', () => {
    const t = setup({ resumeMaxEvents: 10 });
    t.hub.toSite('north', msg(1));
    const a = t.login('north');
    a.closed();
    for (let i = 0; i < 15; i++) t.hub.toSite('north', msg(2));
    const b = t.login('north', { resume: { epoch: EPOCH, seq: 1 } });
    expect(b.sent[0]).toMatchObject({ resumed: false });
    expect(b.messages()).toHaveLength(0);
    t.hub.toSite('north', msg(3));
    expect(b.messages().map((m) => m.seq)).toEqual([17]);
  });

  it('keeps at most resumeMaxEvents, replaying from the oldest kept', () => {
    const t = setup({ resumeMaxEvents: 3 });
    for (let i = 1; i <= 5; i++) t.hub.toSite('north', msg(i));
    const b = t.login('north', { resume: { epoch: EPOCH, seq: 2 } });
    expect(b.sent[0]).toMatchObject({ resumed: true });
    expect(b.messages().map((m) => m.seq)).toEqual([3, 4, 5]);
  });

  it('viewers never resume', () => {
    const t = setup();
    t.hub.toViewers(msg(1));
    const v = t.login('portal', { resume: { epoch: EPOCH, seq: 0 } });
    expect(v.sent[0]).toMatchObject({ resumed: false });
  });
});

describe('requests', () => {
  it('a site reply reaches the handler with its Principal; the result comes back', async () => {
    const t = setup();
    const north = t.login('north');
    const reply = { type: 'reply', id: 'r1', channel: 'C0NORTH', threadTs: '1.000', text: 'hi' };
    north.frame(reply);
    await flush();
    expect(t.calls).toEqual([
      { principal: { role: 'site', name: 'north', channels: ['C0NORTH'], canPost: false }, frame: reply },
    ]);
    expect(north.sent.at(-1)).toEqual({ type: 'result', id: 'r1', ok: true, ts: '1.000' });
  });

  it('a viewer history gets its history_result', async () => {
    const t = setup();
    t.setAnswer(async (f) => ({ type: 'history_result', id: f.id, channel: f.channel, messages: [msg(1)] }));
    const portal = t.login('portal');
    portal.frame({ type: 'history', id: 'h1', channel: 'C0NORTH', limit: 5 });
    await flush();
    expect(t.calls[0]?.principal).toEqual({
      role: 'viewer',
      name: 'portal',
      channels: ['C0NORTH', 'C0SOUTH'],
      canPost: true,
    });
    expect(portal.sent.at(-1)).toEqual({ type: 'history_result', id: 'h1', channel: 'C0NORTH', messages: [msg(1)] });
  });

  it('wrong-role requests get not_allowed and never reach the handler', async () => {
    const t = setup();
    const portal = t.login('portal');
    const north = t.login('north');
    portal.frame({ type: 'reply', id: 'a', channel: 'C0NORTH', threadTs: '1.0', text: 'x' });
    portal.frame({ type: 'react', id: 'b', channel: 'C0NORTH', ts: '1.0', emoji: 'eyes' });
    north.frame({ type: 'post', id: 'c', channel: 'C0NORTH', text: 'x' });
    north.frame({ type: 'history', id: 'd', channel: 'C0NORTH' });
    await flush();
    expect(t.calls).toHaveLength(0);
    expect(portal.sent.slice(-2)).toEqual([
      { type: 'result', id: 'a', ok: false, error: 'not_allowed' },
      { type: 'result', id: 'b', ok: false, error: 'not_allowed' },
    ]);
    expect(north.sent.slice(-2)).toEqual([
      { type: 'result', id: 'c', ok: false, error: 'not_allowed' },
      { type: 'result', id: 'd', ok: false, error: 'not_allowed' },
    ]);
  });

  it('a rejecting handler produces one ok: false result', async () => {
    const t = setup();
    t.setAnswer(async () => {
      throw new Error('boom');
    });
    const portal = t.login('portal');
    portal.frame({ type: 'post', id: 'p1', channel: 'C0NORTH', text: 'x' });
    await flush();
    const results = portal.sent.filter((f) => f.type === 'result');
    expect(results).toEqual([{ type: 'result', id: 'p1', ok: false, error: 'invalid' }]);
    expect(t.logger.error).toHaveBeenCalled();
  });

  it('drops a result that resolves after the connection closed', async () => {
    const t = setup();
    let resolve!: (a: Answer) => void;
    t.setAnswer(() => new Promise((r) => (resolve = r)));
    const north = t.login('north');
    north.frame({ type: 'react', id: 'r1', channel: 'C0NORTH', ts: '1.0', emoji: 'eyes' });
    north.closed();
    const count = north.sent.length;
    resolve({ type: 'result', id: 'r1', ok: true });
    await flush();
    expect(north.sent).toHaveLength(count);
  });

  it('drops a result for a replaced connection', async () => {
    const t = setup();
    let resolve!: (a: Answer) => void;
    t.setAnswer(() => new Promise((r) => (resolve = r)));
    const first = t.login('north');
    first.frame({ type: 'react', id: 'r1', channel: 'C0NORTH', ts: '1.0', emoji: 'eyes' });
    const second = t.login('north');
    const counts = [first.sent.length, second.sent.length];
    resolve({ type: 'result', id: 'r1', ok: true });
    await flush();
    expect([first.sent.length, second.sent.length]).toEqual(counts);
  });
});

describe('status', () => {
  it('sends status to every authenticated connection only on change', () => {
    const t = setup();
    const north = t.login('north');
    const portal = t.login('portal');
    const pending = t.open();
    const before = [north.sent.length, portal.sent.length];

    t.hub.setSlackStatus({ slack: 'connected', slackSharedApp: false });
    expect(north.sent.slice(before[0])).toEqual([{ type: 'status', slack: 'connected', slackSharedApp: false }]);
    expect(portal.sent.slice(before[1])).toEqual([{ type: 'status', slack: 'connected', slackSharedApp: false }]);
    expect(pending.sent).toHaveLength(0);

    t.hub.setSlackStatus({ slack: 'connected', slackSharedApp: false });
    expect(north.sent.length).toBe(before[0]! + 1);

    t.hub.setSlackStatus({ slack: 'connected', slackSharedApp: true });
    expect(north.sent.at(-1)).toEqual({ type: 'status', slack: 'connected', slackSharedApp: true });

    const late = t.login('wall');
    expect(late.sent[1]).toEqual({ type: 'status', slack: 'connected', slackSharedApp: true });
  });
});

describe('health and closeAll', () => {
  it('reports connections and lastSeenMs', () => {
    const t = setup();
    expect(t.hub.health()).toEqual({
      sites: [
        { name: 'north', connected: false, lastSeenMs: null },
        { name: 'south', connected: false, lastSeenMs: null },
      ],
      viewers: 0,
    });
    const north = t.login('north');
    t.login('portal');
    vi.advanceTimersByTime(5_000);
    north.frame({ type: 'ping' });
    const seen = Date.now();
    vi.advanceTimersByTime(1_000);
    expect(t.hub.health()).toEqual({
      sites: [
        { name: 'north', connected: true, lastSeenMs: seen },
        { name: 'south', connected: false, lastSeenMs: null },
      ],
      viewers: 1,
    });
    north.closed();
    expect(t.hub.health().sites[0]).toEqual({ name: 'north', connected: false, lastSeenMs: seen });
  });

  it('closeAll closes every connection, including ones in handshake, without an error frame', () => {
    const t = setup();
    const conns = [t.login('north'), t.login('portal'), t.open()];
    const counts = conns.map((c) => c.sent.length);
    t.hub.closeAll(1001, 'shutting down');
    for (const [i, c] of conns.entries()) {
      expect(c.fake.closedWith).toEqual({ code: 1001, reason: 'shutting down' });
      expect(c.sent).toHaveLength(counts[i]!);
    }
    expect(t.hub.health().viewers).toBe(0);
    expect(t.hub.health().sites[0]?.connected).toBe(false);
    // No timers left to fire on closed connections.
    vi.advanceTimersByTime(t.config.limits.idleTimeoutMs * 2);
    for (const [i, c] of conns.entries()) expect(c.sent).toHaveLength(counts[i]!);
  });
});
