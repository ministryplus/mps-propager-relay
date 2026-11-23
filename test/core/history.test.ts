import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateConfig, type RelayConfig } from '../../src/core/config.js';
import { createHistory } from '../../src/core/history.js';
import type { Logger } from '../../src/core/logger.js';
import { SlackApiError, type SlackHistoryMessage } from '../../src/core/slack-api.js';
import type { RelayMessage } from '../../src/protocol/types.js';
import { FakeSlackApi } from '../fakes/fake-slack-api.js';

const HASH = (c: string) => 'sha256:' + c.repeat(64);

function makeConfig(historySize = 3): RelayConfig {
  return {
    slack: { botToken: 'xoxb-test', ingress: { mode: 'events-api', signingSecret: 's' } },
    sites: [
      { name: 'north', channels: ['C0NORTH'], keyHashes: [HASH('a')] },
      { name: 'south', channels: ['C0SOUTH'], keyHashes: [HASH('b')] },
    ],
    viewers: [{ name: 'wall', channels: ['C0VIEWONLY'], keyHashes: [HASH('c')], canPost: false }],
    limits: { historySize },
  };
}

function recordingLogger() {
  const calls: { level: string; args: unknown[] }[] = [];
  const rec =
    (level: string) =>
    (...args: unknown[]) =>
      calls.push({ level, args });
  const logger: Logger = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
  return { logger, calls };
}

function msg(channel: string, ts: string, extra: Partial<RelayMessage> = {}): RelayMessage {
  return { eventId: `Ev${ts}`, channel, ts, text: `t${ts}`, kind: 'channel', fromSelf: false, origin: 'slack', ...extra };
}

/** The relay's real conversion is normalize(); a minimal stand-in is enough here. */
function toMessage(channel: string, m: SlackHistoryMessage): RelayMessage | null {
  if (m.subtype === 'channel_join') return null;
  return msg(channel, m.ts, { eventId: `history:${channel}:${m.ts}`, text: m.text ?? '' });
}

function setup(o: { historySize?: number; slackApi?: FakeSlackApi } = {}) {
  const slackApi = o.slackApi ?? new FakeSlackApi();
  const { logger, calls } = recordingLogger();
  const history = createHistory({ config: validateConfig(makeConfig(o.historySize)), slackApi, logger, toMessage });
  return { history, slackApi, calls };
}

const tss = (list: RelayMessage[]) => list.map((m) => m.ts);

describe('history ring', () => {
  it('keeps the last historySize messages per channel, oldest first', () => {
    const { history } = setup();
    for (const ts of ['1.000001', '2.000001', '3.000001', '4.000001']) history.add(msg('C0NORTH', ts));
    history.add(msg('C0SOUTH', '9.000001'));
    expect(tss(history.get('C0NORTH'))).toEqual(['2.000001', '3.000001', '4.000001']);
    expect(tss(history.get('C0SOUTH'))).toEqual(['9.000001']);
  });

  it('orders by ts even when messages arrive out of order (including ts with different integer widths)', () => {
    const { history } = setup({ historySize: 5 });
    for (const ts of ['1700000000.000300', '999999999.000001', '1700000000.000100', '1700000000.000200'])
      history.add(msg('C0NORTH', ts));
    expect(tss(history.get('C0NORTH'))).toEqual([
      '999999999.000001',
      '1700000000.000100',
      '1700000000.000200',
      '1700000000.000300',
    ]);
  });

  it('clamps limit to historySize and returns the newest `limit` messages', () => {
    const { history } = setup();
    for (const ts of ['1.0', '2.0', '3.0']) history.add(msg('C0NORTH', ts));
    expect(tss(history.get('C0NORTH', 2))).toEqual(['2.0', '3.0']);
    expect(tss(history.get('C0NORTH', 100))).toEqual(['1.0', '2.0', '3.0']);
    expect(history.get('C0NORTH', 0)).toEqual([]);
  });

  it('returns a copy', () => {
    const { history } = setup();
    history.add(msg('C0NORTH', '1.0'));
    history.get('C0NORTH').pop();
    expect(history.get('C0NORTH')).toHaveLength(1);
  });

  it('keeps fromSelf messages', () => {
    const { history } = setup();
    history.add(msg('C0NORTH', '1.0', { fromSelf: true }));
    expect(history.get('C0NORTH')[0]?.fromSelf).toBe(true);
  });

  it('holds one entry per ts: a Slack message replaces an earlier entry with the same ts', () => {
    const { history } = setup();
    history.add(msg('C0NORTH', '1.0', { origin: 'relay', eventId: 'relay:1.0' }));
    history.add(msg('C0NORTH', '1.0', { fromSelf: true, eventId: 'Ev-echo' }));
    expect(history.get('C0NORTH')).toEqual([msg('C0NORTH', '1.0', { fromSelf: true, eventId: 'Ev-echo' })]);
  });

  it('a relay-built post does not overwrite a Slack echo that arrived first', () => {
    const { history } = setup();
    history.add(msg('C0NORTH', '1.0', { fromSelf: true, eventId: 'Ev-echo' }));
    history.add(msg('C0NORTH', '1.0', { origin: 'relay', eventId: 'relay:1.0' }));
    expect(history.get('C0NORTH')).toEqual([msg('C0NORTH', '1.0', { fromSelf: true, eventId: 'Ev-echo' })]);
  });

  it('ignores channels with no ring and returns [] for them', () => {
    const { history } = setup();
    history.add(msg('C0UNKNOWN', '1.0'));
    expect(history.get('C0UNKNOWN')).toEqual([]);
  });

  it('keeps a ring for a viewer-only channel', () => {
    const { history } = setup();
    history.add(msg('C0VIEWONLY', '1.0'));
    expect(tss(history.get('C0VIEWONLY'))).toEqual(['1.0']);
  });
});

describe('history backfill', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('fetches every channel with limit historySize and merges with live messages (live kept, duplicates skipped)', async () => {
    const slackApi = new FakeSlackApi().setHistory('C0NORTH', [
      { ts: '3.0', text: 'from slack 3' },
      { ts: '2.0', text: 'from slack 2' },
      { ts: '1.5', text: 'joined', subtype: 'channel_join' },
    ]);
    const { history } = setup({ historySize: 5, slackApi });
    history.add(msg('C0NORTH', '3.0', { text: 'live 3' }));
    history.add(msg('C0NORTH', '4.0', { text: 'live 4' }));

    await history.backfill();

    expect(slackApi.callsTo('history').map((c) => c.args)).toEqual(
      expect.arrayContaining([
        { channel: 'C0NORTH', limit: 5 },
        { channel: 'C0SOUTH', limit: 5 },
        { channel: 'C0VIEWONLY', limit: 5 },
      ]),
    );
    expect(history.get('C0NORTH').map((m) => m.text)).toEqual(['from slack 2', 'live 3', 'live 4']);
  });

  it('logs a failed channel, retries it after the backoff, and fills it when it succeeds', async () => {
    const slackApi = new FakeSlackApi()
      .setHistory('C0SOUTH', [{ ts: '5.0', text: 'south' }])
      .script('history', new SlackApiError('ratelimited'));
    const { history, calls } = setup({ slackApi });

    await history.backfill(); // the first history() call fails (whichever channel)
    const failed = calls.find((c) => c.level === 'warn');
    expect(failed).toBeDefined();
    expect(failed!.args.join(' ')).toContain('ratelimited');
    const failedChannel = (slackApi.callsTo('history')[0]!.args as { channel: string }).channel;
    expect(failed!.args.join(' ')).toContain(failedChannel);
    expect(slackApi.callsTo('history')).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(999);
    expect(slackApi.callsTo('history')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(slackApi.callsTo('history')).toHaveLength(4);
    expect((slackApi.callsTo('history')[3]!.args as { channel: string }).channel).toBe(failedChannel);
    expect(history.get('C0SOUTH').map((m) => m.text)).toEqual(['south']);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(slackApi.callsTo('history')).toHaveLength(4);
  });

  it('backs off 1 s doubling for repeated failures of one channel', async () => {
    const slackApi = new FakeSlackApi();
    let tries = 0;
    const real = slackApi.history.bind(slackApi);
    slackApi.history = (a) => {
      if (a.channel !== 'C0SOUTH') return real(a);
      tries++;
      return tries <= 3 ? Promise.reject(new SlackApiError('network')) : real(a);
    };
    const { history } = setup({ slackApi });
    const southTries = () => tries;

    await history.backfill();
    expect(southTries()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); // retry 1 fails
    expect(southTries()).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(southTries()).toBe(2);
    await vi.advanceTimersByTimeAsync(1); // retry 2 fails, after 2 s
    expect(southTries()).toBe(3);
    await vi.advanceTimersByTimeAsync(3999);
    expect(southTries()).toBe(3);
    await vi.advanceTimersByTimeAsync(1); // retry 3 succeeds, after 4 s
    expect(southTries()).toBe(4);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(southTries()).toBe(4);
  });

  it('never rejects, even when every channel fails', async () => {
    const err = new Error('boom');
    const slackApi = new FakeSlackApi().script('history', err, err, err);
    const { history, calls } = setup({ slackApi });
    await expect(history.backfill()).resolves.toBeUndefined();
    expect(calls.filter((c) => c.level === 'warn')).toHaveLength(3);
    history.stop();
  });

  it('stop() cancels pending retries', async () => {
    const slackApi = new FakeSlackApi().script('history', new SlackApiError('network'));
    const { history } = setup({ slackApi });
    await history.backfill();
    history.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(slackApi.callsTo('history')).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
