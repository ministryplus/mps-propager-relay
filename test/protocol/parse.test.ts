import { describe, expect, it } from 'vitest';
import { ProtocolError, parseClientFrame, parseServerFrame } from '../../src/protocol/parse.js';
import { CLOSE } from '../../src/protocol/types.js';

const hello = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'hello',
    protocol: 1,
    role: 'site',
    key: 'prk_abc',
    client: { name: 'ProPager', version: '0.6.0' },
    ...extra,
  });

describe('parseClientFrame', () => {
  it('accepts any integer protocol ≥ 1 so the session can answer 4002', () => {
    const frame = parseClientFrame(hello({ protocol: 2 }));
    expect(frame).toMatchObject({ type: 'hello', protocol: 2 });
  });

  it('rejects protocol 0 and non-integer protocols', () => {
    expect(() => parseClientFrame(hello({ protocol: 0 }))).toThrow(ProtocolError);
    expect(() => parseClientFrame(hello({ protocol: 1.5 }))).toThrow(ProtocolError);
  });

  it('accepts unknown fields and drops them, including nested ones', () => {
    const frame = parseClientFrame(
      hello({
        extra: true,
        client: { name: 'ProPager', version: '0.6.0', os: 'mac' },
        resume: { epoch: 'k3v9', seq: 0, more: 1 },
      }),
    );
    expect(frame).toEqual({
      type: 'hello',
      protocol: 1,
      role: 'site',
      key: 'prk_abc',
      client: { name: 'ProPager', version: '0.6.0' },
      resume: { epoch: 'k3v9', seq: 0 },
    });
  });

  it('omits absent optional fields rather than setting them undefined', () => {
    const frame = parseClientFrame('{"type":"history","id":"h1","channel":"C0123ABC"}');
    expect(Object.keys(frame).sort()).toEqual(['channel', 'id', 'type']);
  });

  it('turns a JSON syntax error into ProtocolError', () => {
    expect(() => parseClientFrame('{')).toThrow(ProtocolError);
    expect(() => parseClientFrame('{')).not.toThrow(SyntaxError);
  });

  it('rejects null and primitives', () => {
    for (const text of ['null', '1', '"hello"', 'true']) {
      expect(() => parseClientFrame(text)).toThrow(ProtocolError);
    }
  });

  it('names the failing field in the message', () => {
    expect(() =>
      parseClientFrame('{"type":"reply","id":"r1","channel":"C0123ABC","text":"hi"}'),
    ).toThrow('reply.threadTs must be a string');
  });
});

describe('parseServerFrame', () => {
  it('drops unknown fields inside history_result messages', () => {
    const frame = parseServerFrame(
      JSON.stringify({
        type: 'history_result',
        id: 'h1',
        channel: 'C0123ABC',
        messages: [
          {
            eventId: 'Ev1',
            channel: 'C0123ABC',
            ts: '1732291200.000100',
            text: 'x',
            kind: 'channel',
            fromSelf: false,
            origin: 'slack',
            blocks: [],
          },
        ],
      }),
    );
    expect(frame.type === 'history_result' && frame.messages[0]).not.toHaveProperty('blocks');
  });

  it('requires error when ok is false', () => {
    expect(() => parseServerFrame('{"type":"result","id":"r1","ok":false}')).toThrow(
      ProtocolError,
    );
  });
});

describe('CLOSE', () => {
  it('matches the Decision 9 close-code table', () => {
    expect(CLOSE).toEqual({
      GOING_AWAY: 1001,
      BAD_FRAME: 4000,
      UNAUTHORIZED: 4001,
      UNSUPPORTED_PROTOCOL: 4002,
      REPLACED: 4003,
      HANDSHAKE_TIMEOUT: 4004,
      IDLE: 4005,
    });
  });
});
