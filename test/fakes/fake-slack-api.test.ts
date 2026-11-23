import { describe, expect, it } from 'vitest';
import { SlackApiError } from '../../src/core/slack-api.js';
import { FakeSlackApi } from './fake-slack-api.js';

describe('FakeSlackApi', () => {
  it('answers with defaults', async () => {
    const slack = new FakeSlackApi();
    await expect(slack.authTest()).resolves.toEqual({ userId: 'U_BOT', botId: 'B_BOT' });
    await expect(slack.postMessage({ channel: 'C', text: 'a' })).resolves.toEqual({ ts: '1700000000.000001' });
    await expect(slack.postMessage({ channel: 'C', text: 'b' })).resolves.toEqual({ ts: '1700000000.000002' });
    await expect(slack.addReaction({ channel: 'C', ts: '1', emoji: 'x' })).resolves.toBeUndefined();
    await expect(slack.history({ channel: 'C', limit: 10 })).resolves.toEqual([]);
    await expect(slack.openSocketModeUrl('xapp')).resolves.toBe('ws://127.0.0.1:0/fake');
  });

  it('uses scripted values and errors once, in order, then falls back', async () => {
    const slack = new FakeSlackApi();
    slack.script('postMessage', { ts: 'S1' }, new SlackApiError('channel_not_found'), { ts: 'S2' });
    await expect(slack.postMessage({ channel: 'C', text: '1' })).resolves.toEqual({ ts: 'S1' });
    await expect(slack.postMessage({ channel: 'C', text: '2' })).rejects.toMatchObject({ code: 'channel_not_found' });
    await expect(slack.postMessage({ channel: 'C', text: '3' })).resolves.toEqual({ ts: 'S2' });
    await expect(slack.postMessage({ channel: 'C', text: '4' })).resolves.toEqual({ ts: '1700000000.000001' });
  });

  it('holds a call open with a function response', async () => {
    const slack = new FakeSlackApi();
    let release!: (v: { ts: string }) => void;
    slack.script('postMessage', () => new Promise<{ ts: string }>((r) => (release = r)));
    let done = false;
    const p = slack.postMessage({ channel: 'C', text: 'held' }).then((v) => {
      done = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    expect(slack.callsTo('postMessage')).toHaveLength(1);
    release({ ts: 'late' });
    await expect(p).resolves.toEqual({ ts: 'late' });
  });

  it('passes args to a function response', async () => {
    const slack = new FakeSlackApi();
    slack.script('postMessage', async (a) => ({ ts: `echo-${a.text}` }));
    await expect(slack.postMessage({ channel: 'C', text: 'x' })).resolves.toEqual({ ts: 'echo-x' });
  });

  it('records calls in order', async () => {
    const slack = new FakeSlackApi();
    await slack.authTest();
    await slack.addReaction({ channel: 'C', ts: '1', emoji: 'eyes' });
    await slack.postMessage({ channel: 'C', text: 'hi', threadTs: '1' });
    await slack.openSocketModeUrl('xapp-1');
    expect(slack.calls).toEqual([
      { method: 'authTest', args: undefined },
      { method: 'addReaction', args: { channel: 'C', ts: '1', emoji: 'eyes' } },
      { method: 'postMessage', args: { channel: 'C', text: 'hi', threadTs: '1' } },
      { method: 'openSocketModeUrl', args: 'xapp-1' },
    ]);
    expect(slack.callsTo('postMessage')).toEqual([
      { method: 'postMessage', args: { channel: 'C', text: 'hi', threadTs: '1' } },
    ]);
  });

  it('records a call even when it is scripted to fail', async () => {
    const slack = new FakeSlackApi();
    slack.script('addReaction', new SlackApiError('invalid_name'));
    await expect(slack.addReaction({ channel: 'C', ts: '1', emoji: '?' })).rejects.toBeInstanceOf(SlackApiError);
    expect(slack.callsTo('addReaction')).toHaveLength(1);
  });

  it('serves history per channel, up to limit', async () => {
    const slack = new FakeSlackApi();
    slack.setHistory('C1', [{ ts: '3' }, { ts: '2' }, { ts: '1' }]);
    await expect(slack.history({ channel: 'C1', limit: 2 })).resolves.toEqual([{ ts: '3' }, { ts: '2' }]);
    await expect(slack.history({ channel: 'C2', limit: 2 })).resolves.toEqual([]);
  });
});
