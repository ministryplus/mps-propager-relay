import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateConfig, type ResolvedConfig } from '../../src/core/config.js';
import { hashKey } from '../../src/core/keys.js';
import type { Logger } from '../../src/core/logger.js';
import { createOutbound } from '../../src/core/outbound.js';
import { SlackApiError } from '../../src/core/slack-api.js';
import type { PostFrame, ReactFrame, RelayMessage, ReplyFrame, ResultFrame } from '../../src/protocol/types.js';
import { FakeSlackApi } from '../fakes/fake-slack-api.js';

const config: ResolvedConfig = validateConfig({
  slack: { botToken: 'xoxb-test', ingress: { mode: 'events-api', signingSecret: 'secret' } },
  sites: [
    { name: 'north', channels: ['C0NORTH'], keyHashes: [hashKey('prk_north')] },
    { name: 'south', channels: ['C0SOUTH'], keyHashes: [hashKey('prk_south')] },
  ],
  viewers: [
    { name: 'portal', channels: '*', keyHashes: [hashKey('prk_portal')], canPost: true },
    { name: 'wall', channels: ['C0NORTH'], keyHashes: [hashKey('prk_wall')], canPost: false },
  ],
});

/** session.ts's Principal (001-6), taken from the signature so this test doesn't depend on where it lives. */
type Principal = Parameters<ReturnType<typeof createOutbound>['request']>[0];

const north: Principal = { role: 'site', name: 'north', channels: ['C0NORTH'], canPost: false };
const portal: Principal = { role: 'viewer', name: 'portal', channels: ['C0NORTH', 'C0SOUTH'], canPost: true };
const wall: Principal = { role: 'viewer', name: 'wall', channels: ['C0NORTH'], canPost: false };

let nextId = 0;
const reply = (threadTs: string, text: string, channel = 'C0NORTH'): ReplyFrame => ({
  type: 'reply',
  id: `r${++nextId}`,
  channel,
  threadTs,
  text,
});
const react = (ts: string, emoji = 'eyes', channel = 'C0NORTH'): ReactFrame => ({
  type: 'react',
  id: `x${++nextId}`,
  channel,
  ts,
  emoji,
});
const post = (text: string, extra: { channel?: string; threadTs?: string } = {}): PostFrame => ({
  type: 'post',
  id: `p${++nextId}`,
  channel: extra.channel ?? 'C0NORTH',
  text,
  ...(extra.threadTs !== undefined ? { threadTs: extra.threadTs } : {}),
});

/** Lets every pending promise callback run (no timers involved). */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A response the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const silentLogger = () => ({
  debug: vi.fn<Logger['debug']>(),
  info: vi.fn<Logger['info']>(),
  warn: vi.fn<Logger['warn']>(),
  error: vi.fn<Logger['error']>(),
});

let slack: FakeSlackApi;
let relayPosts: RelayMessage[];
let logger: ReturnType<typeof silentLogger>;
let outbound: ReturnType<typeof createOutbound>;

beforeEach(() => {
  slack = new FakeSlackApi();
  relayPosts = [];
  logger = silentLogger();
  outbound = createOutbound({ slackApi: slack, config, logger, onRelayPost: (m) => relayPosts.push(m) });
});

const textsSent = (): string[] => slack.callsTo('postMessage').map((c) => (c.args as { text: string }).text);

describe('createOutbound', () => {
  it('sends a site reply into the thread and resolves its ts', async () => {
    const f = reply('1.0', 'hello');
    const result = await outbound.request(north, f);
    expect(slack.calls).toEqual([
      { method: 'postMessage', args: { channel: 'C0NORTH', text: 'hello', threadTs: '1.0' } },
    ]);
    expect(result).toEqual({ type: 'result', id: f.id, ok: true, ts: '1700000000.000001' });
  });

  it('adds a site reaction and resolves ok without ts', async () => {
    const f = react('1.0', 'eyes');
    const result = await outbound.request(north, f);
    expect(slack.calls).toEqual([
      { method: 'addReaction', args: { channel: 'C0NORTH', ts: '1.0', emoji: 'eyes' } },
    ]);
    expect(result).toEqual({ type: 'result', id: f.id, ok: true });
  });

  it.each<[string, Principal, ReplyFrame | ReactFrame | PostFrame]>([
    ['site reply outside its channels', north, reply('1.0', 'x', 'C0SOUTH')],
    ['viewer reply', portal, reply('1.0', 'x')],
    ['viewer react', portal, react('1.0')],
    ['site post', north, post('x')],
    ['viewer post without canPost', wall, post('x')],
    ['viewer post outside its channels', portal, post('x', { channel: 'C0OTHER' })],
  ])('answers not_allowed for a %s without calling Slack', async (_name, p, f) => {
    const result = await outbound.request(p, f);
    expect(result).toEqual({ type: 'result', id: f.id, ok: false, error: 'not_allowed' });
    expect(slack.calls).toEqual([]);
    expect(relayPosts).toEqual([]);
  });

  it.each<[string, Principal, ReplyFrame | ReactFrame | PostFrame]>([
    ['reply with empty text', north, reply('1.0', '')],
    ['post with empty text', portal, post('')],
    ['react with empty ts', north, react('')],
    ['react with empty emoji', north, react('1.0', '')],
  ])('answers invalid for a %s without calling Slack', async (_name, p, f) => {
    const result = await outbound.request(p, f);
    expect(result).toEqual({ type: 'result', id: f.id, ok: false, error: 'invalid' });
    expect(slack.calls).toEqual([]);
  });

  it('runs replies to one thread one at a time, in order', async () => {
    const first = deferred<{ ts: string }>();
    slack.script('postMessage', () => first.promise);
    const order: string[] = [];
    const results = ['A1', 'A2', 'A3'].map((t) =>
      outbound.request(north, reply('1.0', t)).then((r) => {
        order.push(t);
        return r;
      }),
    );
    await flush();
    expect(textsSent()).toEqual(['A1']);

    first.resolve({ ts: '9.1' });
    const [r1, r2, r3] = await Promise.all(results);
    expect(textsSent()).toEqual(['A1', 'A2', 'A3']);
    expect(order).toEqual(['A1', 'A2', 'A3']);
    expect([r1.ts, r2.ok, r3.ok]).toEqual(['9.1', true, true]);
  });

  it('does not let a failure block the next request in the thread', async () => {
    slack.script('postMessage', new SlackApiError('channel_not_found'));
    const a = outbound.request(north, reply('1.0', 'A1'));
    const b = outbound.request(north, reply('1.0', 'A2'));
    expect(await a).toMatchObject({ ok: false, error: 'slack:channel_not_found' });
    expect(await b).toMatchObject({ ok: true });
    expect(textsSent()).toEqual(['A1', 'A2']);
  });

  it('waits for the previous request to reject before starting the next', async () => {
    const first = deferred<{ ts: string }>();
    slack.script('postMessage', () => first.promise);
    const a = outbound.request(north, reply('1.0', 'A1'));
    const b = outbound.request(north, reply('1.0', 'A2'));
    await flush();
    expect(textsSent()).toEqual(['A1']);
    first.reject(new SlackApiError('network'));
    expect(await a).toMatchObject({ ok: false, error: 'slack:network' });
    expect(await b).toMatchObject({ ok: true });
  });

  it('runs different threads independently', async () => {
    const first = deferred<{ ts: string }>();
    slack.script('postMessage', () => first.promise);
    const a1 = outbound.request(north, reply('1.0', 'A1'));
    const a2 = outbound.request(north, reply('1.0', 'A2'));
    const b1 = outbound.request(north, reply('2.0', 'B1'));
    expect(await b1).toMatchObject({ ok: true });
    expect(textsSent()).toEqual(['A1', 'B1']);
    first.resolve({ ts: '9.1' });
    await Promise.all([a1, a2]);
    expect(textsSent()).toEqual(['A1', 'B1', 'A2']);
  });

  it('queues a reaction on a thread parent behind that thread’s reply', async () => {
    const first = deferred<{ ts: string }>();
    slack.script('postMessage', () => first.promise);
    const a = outbound.request(north, reply('1.0', 'A1'));
    const x = outbound.request(north, react('1.0', 'white_check_mark'));
    await flush();
    expect(slack.callsTo('addReaction')).toEqual([]);
    first.resolve({ ts: '9.1' });
    await Promise.all([a, x]);
    expect(slack.calls.map((c) => c.method)).toEqual(['postMessage', 'addReaction']);
  });

  it('queues top-level posts per channel and threaded posts with the thread', async () => {
    const top = deferred<{ ts: string }>();
    slack.script('postMessage', () => top.promise);
    const p1 = outbound.request(portal, post('P1'));
    const p2 = outbound.request(portal, post('P2'));
    await flush();
    expect(textsSent()).toEqual(['P1']);
    top.resolve({ ts: '9.1' });
    await Promise.all([p1, p2]);
    expect(textsSent()).toEqual(['P1', 'P2']);

    const thread = deferred<{ ts: string }>();
    slack.script('postMessage', () => thread.promise);
    const r = outbound.request(north, reply('1.0', 'R1'));
    const tp = outbound.request(portal, post('T1', { threadTs: '1.0' }));
    await flush();
    expect(textsSent()).toEqual(['P1', 'P2', 'R1']);
    thread.resolve({ ts: '9.2' });
    await Promise.all([r, tp]);
    expect(textsSent()).toEqual(['P1', 'P2', 'R1', 'T1']);
    expect(slack.callsTo('postMessage')[3]?.args).toEqual({ channel: 'C0NORTH', text: 'T1', threadTs: '1.0' });
    expect(slack.callsTo('postMessage')[0]?.args).toEqual({ channel: 'C0NORTH', text: 'P1' });
  });

  it.each<[string, Error, string]>([
    ['rate limit', new SlackApiError('rate_limited'), 'rate_limited'],
    ['network failure', new SlackApiError('network'), 'slack:network'],
    ['plain Error', new Error('boom'), 'slack:unknown'],
  ])('maps a %s to %s', async (_name, err, code) => {
    slack.script('postMessage', err);
    const f = reply('1.0', 'x');
    const result = await outbound.request(north, f);
    expect(result).toEqual({ type: 'result', id: f.id, ok: false, error: code });
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('"x"');
  });

  it('logs an unknown error with its stack', async () => {
    const err = new Error('boom');
    slack.script('addReaction', err);
    const result = await outbound.request(north, react('1.0'));
    expect(result).toMatchObject({ ok: false, error: 'slack:unknown' });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), err.stack);
  });

  it('never rejects, even if onRelayPost throws', async () => {
    const throwing = createOutbound({
      slackApi: slack,
      config,
      logger,
      onRelayPost: () => {
        throw new Error('route failed');
      },
    });
    const f = post('5678');
    const result: ResultFrame = await throwing.request(portal, f);
    expect(result).toEqual({ type: 'result', id: f.id, ok: true, ts: '1700000000.000001' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('hands a successful top-level viewer post to onRelayPost', async () => {
    const result = await outbound.request(portal, post('5678'));
    expect(relayPosts).toHaveLength(1);
    const msg = relayPosts[0]!;
    expect(msg).toEqual({
      eventId: `relay:${result.ts}`,
      channel: 'C0NORTH',
      ts: result.ts,
      text: '5678',
      kind: 'channel',
      fromSelf: false,
      origin: 'relay',
    });
    expect(Object.keys(msg)).not.toContain('threadTs');
    expect(Object.keys(msg)).not.toContain('user');
    expect(Object.keys(msg)).not.toContain('botId');
  });

  it('hands a successful threaded viewer post to onRelayPost as a thread message', async () => {
    const result = await outbound.request(portal, post('5678', { threadTs: '1.0' }));
    expect(relayPosts).toEqual([
      {
        eventId: `relay:${result.ts}`,
        channel: 'C0NORTH',
        ts: result.ts,
        text: '5678',
        kind: 'thread',
        threadTs: '1.0',
        fromSelf: false,
        origin: 'relay',
      },
    ]);
  });

  it('calls onRelayPost before resolving the result', async () => {
    let seenAtResolve = -1;
    await outbound.request(portal, post('5678')).then(() => (seenAtResolve = relayPosts.length));
    expect(seenAtResolve).toBe(1);
  });

  it('never calls onRelayPost for a failed post, a reply, or a react', async () => {
    slack.script('postMessage', new SlackApiError('channel_not_found'));
    await outbound.request(portal, post('5678'));
    await outbound.request(north, reply('1.0', 'x'));
    await outbound.request(north, react('1.0'));
    expect(relayPosts).toEqual([]);
  });
});
