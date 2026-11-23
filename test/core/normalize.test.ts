import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/core/normalize.js';
import type { BotIdentity } from '../../src/core/slack-api.js';

const BOT: BotIdentity = { userId: 'UBOT', botId: 'BBOT' };

function ev(event: Record<string, unknown>, eventId = 'Ev1') {
  return { eventId, event: { type: 'message', channel: 'C0NORTH', ts: '2.0', text: 'hi', user: 'U1', ...event } };
}

describe('normalize: subtypes', () => {
  it.each([undefined, 'thread_broadcast', 'file_share', 'bot_message'])('keeps subtype %s', (subtype) => {
    const e = ev(subtype === undefined ? {} : { subtype });
    expect(normalize(e, null)).not.toBeNull();
  });

  it.each(['message_changed', 'message_deleted', 'channel_join'])('drops subtype %s', (subtype) => {
    expect(normalize(ev({ subtype }), null)).toBeNull();
  });

  it('drops a non-message event type', () => {
    expect(normalize(ev({ type: 'reaction_added' }), null)).toBeNull();
  });
});

describe('normalize: thread rule', () => {
  it('no thread_ts is a channel message', () => {
    const m = normalize(ev({}), null)!;
    expect(m.kind).toBe('channel');
    expect('threadTs' in m).toBe(false);
  });

  it('thread_ts different from ts is a thread reply', () => {
    const m = normalize(ev({ thread_ts: '1.0', ts: '2.0' }), null)!;
    expect(m.kind).toBe('thread');
    expect(m.threadTs).toBe('1.0');
  });

  it('thread_broadcast is still a thread reply', () => {
    const m = normalize(ev({ thread_ts: '1.0', ts: '2.0', subtype: 'thread_broadcast' }), null)!;
    expect(m.kind).toBe('thread');
    expect(m.threadTs).toBe('1.0');
  });

  it('a parent with thread_ts === ts is a channel message', () => {
    const m = normalize(ev({ thread_ts: '2.0', ts: '2.0' }), null)!;
    expect(m.kind).toBe('channel');
    expect('threadTs' in m).toBe(false);
  });

  it('an empty thread_ts is a channel message', () => {
    expect(normalize(ev({ thread_ts: '' }), null)!.kind).toBe('channel');
  });
});

describe('normalize: fields', () => {
  it('maps every field', () => {
    const m = normalize(ev({ bot_id: 'BX', text: 'page me' }, 'Ev42'), null);
    expect(m).toEqual({
      eventId: 'Ev42',
      channel: 'C0NORTH',
      ts: '2.0',
      text: 'page me',
      kind: 'channel',
      user: 'U1',
      botId: 'BX',
      fromSelf: false,
      origin: 'slack',
    });
  });

  it('missing text becomes empty string', () => {
    const { text: _t, ...event } = ev({ subtype: 'file_share' }).event;
    expect(normalize({ eventId: 'E', event }, null)!.text).toBe('');
  });

  it('omits user and botId when absent or empty', () => {
    const m = normalize(ev({ user: '', bot_id: undefined }), null)!;
    expect('user' in m).toBe(false);
    expect('botId' in m).toBe(false);
  });

  it.each(['ts', 'channel'])('missing %s returns null', (field) => {
    const { event } = ev({});
    delete (event as Record<string, unknown>)[field];
    expect(normalize({ eventId: 'E', event }, null)).toBeNull();
    expect(normalize(ev({ [field]: '' }), null)).toBeNull();
  });
});

describe('normalize: fromSelf', () => {
  it('true when user matches the bot user id', () => {
    expect(normalize(ev({ user: 'UBOT' }), BOT)!.fromSelf).toBe(true);
  });

  it('true when bot_id matches the bot id', () => {
    expect(normalize(ev({ user: undefined, bot_id: 'BBOT', subtype: 'bot_message' }), BOT)!.fromSelf).toBe(true);
  });

  it('false for another bot', () => {
    expect(normalize(ev({ user: undefined, bot_id: 'BOTHER' }), BOT)!.fromSelf).toBe(false);
  });

  it('false with no identity', () => {
    expect(normalize(ev({ user: 'UBOT', bot_id: 'BBOT' }), null)!.fromSelf).toBe(false);
  });

  it('an empty bot id never matches a message without bot_id', () => {
    expect(normalize(ev({ user: 'U1' }), { userId: 'UBOT', botId: '' })!.fromSelf).toBe(false);
  });

  it('an empty user id never matches a message without user', () => {
    expect(normalize(ev({ user: undefined, bot_id: 'BX' }), { userId: '', botId: 'BBOT' })!.fromSelf).toBe(false);
  });
});
