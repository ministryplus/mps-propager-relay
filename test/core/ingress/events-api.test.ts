import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createEventsApiIngress,
  type SlackEventSink,
} from '../../../src/core/ingress/events-api.js';
import type { Logger } from '../../../src/core/logger.js';

const SECRET = 'test-signing-secret';
const TS = '1700000000';
const NOW_MS = 1_700_000_000_000;

const URL_VERIFICATION_BODY =
  '{"type":"url_verification","challenge":"3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P"}';
const URL_VERIFICATION_SIG = 'v0=11f8eb925a98268730c0fd64e8c6c41bb78331ea11d9d5091a31c64443cac605';
const EVENT_CALLBACK_BODY =
  '{"type":"event_callback","event_id":"Ev01","event":{"type":"message","channel":"C0123ABC","ts":"1700000000.000100","text":"1234","user":"U1"}}';
const EVENT_CALLBACK_SIG = 'v0=a9010542f1fb94f034997f3bb41434a8ea1d14f746b25a07bc3c07312d7ec947';

function sign(secret: string, ts: string, body: string): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
}

type Level = 'debug' | 'info' | 'warn' | 'error';
function recordingLogger() {
  const calls: { level: Level; args: unknown[] }[] = [];
  const logger: Logger = {
    debug: (...args) => calls.push({ level: 'debug', args }),
    info: (...args) => calls.push({ level: 'info', args }),
    warn: (...args) => calls.push({ level: 'warn', args }),
    error: (...args) => calls.push({ level: 'error', args }),
  };
  return { logger, calls };
}

function setup(o: { now?: number; sink?: SlackEventSink } = {}) {
  const sunk: Parameters<SlackEventSink>[0][] = [];
  const sink: SlackEventSink = o.sink ?? ((e) => sunk.push(e));
  const { logger, calls } = recordingLogger();
  const ingress = createEventsApiIngress({
    signingSecret: SECRET,
    sink,
    now: () => o.now ?? NOW_MS,
    logger,
  });
  return { ingress, sunk, calls };
}

function headers(sig: string | undefined, ts: string | undefined = TS) {
  return { 'X-Slack-Signature': sig, 'X-Slack-Request-Timestamp': ts };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('events-api ingress: fixed vectors', () => {
  it('url_verification vector returns the challenge as text/plain', async () => {
    const { ingress } = setup();
    const r = await ingress.handle(URL_VERIFICATION_BODY, headers(URL_VERIFICATION_SIG));
    expect(r).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P',
    });
  });

  it('event_callback vector returns 200 and later calls the sink', async () => {
    const { ingress, sunk } = setup();
    const r = await ingress.handle(EVENT_CALLBACK_BODY, headers(EVENT_CALLBACK_SIG));
    expect(r).toEqual({ status: 200 });
    await tick();
    expect(sunk).toEqual([
      {
        eventId: 'Ev01',
        event: { type: 'message', channel: 'C0123ABC', ts: '1700000000.000100', text: '1234', user: 'U1' },
      },
    ]);
  });

  it('the test helper agrees with the fixed vectors', () => {
    expect(sign(SECRET, TS, URL_VERIFICATION_BODY)).toBe(URL_VERIFICATION_SIG);
    expect(sign(SECRET, TS, EVENT_CALLBACK_BODY)).toBe(EVENT_CALLBACK_SIG);
  });
});

describe('events-api ingress: helper-signed', () => {
  it('accepts random bodies signed with the right secret', async () => {
    for (let i = 0; i < 20; i++) {
      const { ingress, sunk } = setup();
      const id = `Ev${randomBytes(6).toString('hex')}`;
      const body = JSON.stringify({
        type: 'event_callback',
        event_id: id,
        event: { type: 'message', text: randomBytes(16).toString('base64') + ' ünï ✓' },
      });
      const r = await ingress.handle(body, headers(sign(SECRET, TS, body)));
      expect(r.status).toBe(200);
      await tick();
      expect(sunk.map((e) => e.eventId)).toEqual([id]);
    }
  });
});

describe('events-api ingress: bad signatures', () => {
  async function expect401(body: string, sig: string | undefined, ts?: string) {
    const { ingress, sunk } = setup();
    const r = await ingress.handle(body, headers(sig, ts));
    expect(r).toEqual({ status: 401 });
    await tick();
    expect(sunk).toEqual([]);
  }

  it('rejects a signature with the last hex digit changed', async () => {
    const last = EVENT_CALLBACK_SIG.at(-1) === '7' ? '8' : '7';
    await expect401(EVENT_CALLBACK_BODY, EVENT_CALLBACK_SIG.slice(0, -1) + last);
  });

  it('rejects a signature made with another secret', async () => {
    await expect401(EVENT_CALLBACK_BODY, sign('other-secret', TS, EVENT_CALLBACK_BODY));
  });

  it('rejects a short signature without throwing', async () => {
    await expect401(EVENT_CALLBACK_BODY, 'v0=abc');
  });

  it('rejects a body changed by one byte after signing', async () => {
    const sig = sign(SECRET, TS, EVENT_CALLBACK_BODY);
    await expect401(EVENT_CALLBACK_BODY.replace('1234', '1235'), sig);
  });

  it('rejects a signature with a multi-byte character of the same string length', async () => {
    const sig = sign(SECRET, TS, EVENT_CALLBACK_BODY);
    await expect401(EVENT_CALLBACK_BODY, sig.slice(0, -1) + 'é');
  });
});

describe('events-api ingress: timestamps', () => {
  const body = EVENT_CALLBACK_BODY;
  const sig = EVENT_CALLBACK_SIG;

  it('rejects a header 301 s in the past', async () => {
    const { ingress } = setup({ now: NOW_MS + 301_000 });
    expect(await ingress.handle(body, headers(sig))).toEqual({ status: 401 });
  });

  it('rejects a header 301 s in the future', async () => {
    const { ingress } = setup({ now: NOW_MS - 301_000 });
    expect(await ingress.handle(body, headers(sig))).toEqual({ status: 401 });
  });

  it('accepts exactly 300 s either way', async () => {
    for (const now of [NOW_MS + 300_000, NOW_MS - 300_000]) {
      const { ingress } = setup({ now });
      expect((await ingress.handle(body, headers(sig))).status).toBe(200);
    }
  });

  it('rejects a non-numeric timestamp', async () => {
    const { ingress, sunk } = setup();
    const r = await ingress.handle(body, headers(sign(SECRET, 'abc', body), 'abc'));
    expect(r).toEqual({ status: 401 });
    await tick();
    expect(sunk).toEqual([]);
  });
});

describe('events-api ingress: missing headers', () => {
  it.each([
    ['no signature', headers(undefined)],
    ['no timestamp', { 'X-Slack-Signature': EVENT_CALLBACK_SIG }],
    ['empty signature', headers('')],
    ['empty timestamp', headers(EVENT_CALLBACK_SIG, '')],
    ['no headers', {}],
  ])('%s → 401', async (_name, h) => {
    const { ingress, sunk } = setup();
    expect(await ingress.handle(EVENT_CALLBACK_BODY, h)).toEqual({ status: 401 });
    await tick();
    expect(sunk).toEqual([]);
  });
});

describe('events-api ingress: header case', () => {
  it.each([
    ['mixed', 'X-Slack-Signature', 'X-Slack-Request-Timestamp'],
    ['lower', 'x-slack-signature', 'x-slack-request-timestamp'],
    ['upper', 'X-SLACK-SIGNATURE', 'X-SLACK-REQUEST-TIMESTAMP'],
  ])('%s-case header names are accepted', async (_name, sigName, tsName) => {
    const { ingress } = setup();
    const r = await ingress.handle(URL_VERIFICATION_BODY, {
      [sigName]: URL_VERIFICATION_SIG,
      [tsName]: TS,
    });
    expect(r.status).toBe(200);
  });
});

describe('events-api ingress: asynchronous sink', () => {
  it('calls the sink only after handle() has resolved, exactly once', async () => {
    const { ingress, sunk } = setup();
    const r = await ingress.handle(EVENT_CALLBACK_BODY, headers(EVENT_CALLBACK_SIG));
    expect(r.status).toBe(200);
    expect(sunk).toHaveLength(0);
    await tick();
    expect(sunk).toHaveLength(1);
    await tick();
    expect(sunk).toHaveLength(1);
  });

  it('a throwing sink does not throw out of handle() and is logged at error', async () => {
    const { ingress, calls } = setup({
      sink: () => {
        throw new Error('boom');
      },
    });
    const r = await ingress.handle(EVENT_CALLBACK_BODY, headers(EVENT_CALLBACK_SIG));
    expect(r).toEqual({ status: 200 });
    await tick();
    expect(calls.some((c) => c.level === 'error')).toBe(true);
  });

  it('a malformed event_callback gets 200 and no sink call', async () => {
    for (const payload of [
      { type: 'event_callback', event: { type: 'message' } },
      { type: 'event_callback', event_id: '', event: { type: 'message' } },
      { type: 'event_callback', event_id: 'Ev02' },
      { type: 'event_callback', event_id: 'Ev02', event: 'nope' },
      { type: 'event_callback', event_id: 'Ev02', event: [1] },
    ]) {
      const { ingress, sunk, calls } = setup();
      const body = JSON.stringify(payload);
      expect(await ingress.handle(body, headers(sign(SECRET, TS, body)))).toEqual({ status: 200 });
      await tick();
      expect(sunk).toEqual([]);
      expect(calls.some((c) => c.level === 'warn')).toBe(true);
    }
  });
});

describe('events-api ingress: other bodies', () => {
  it.each([
    ['app_rate_limited', '{"type":"app_rate_limited"}'],
    ['unknown type', '{"type":"something_new"}'],
    ['not json', 'not json'],
    ['json array', '[1,2]'],
    ['json null', 'null'],
  ])('%s → 200, sink not called', async (_name, body) => {
    const { ingress, sunk } = setup();
    expect(await ingress.handle(body, headers(sign(SECRET, TS, body)))).toEqual({ status: 200 });
    await tick();
    expect(sunk).toEqual([]);
  });

  it('url_verification without a string challenge → 200, empty body, warn', async () => {
    const { ingress, calls } = setup();
    const body = '{"type":"url_verification"}';
    const r = await ingress.handle(body, headers(sign(SECRET, TS, body)));
    expect(r).toEqual({ status: 200, headers: { 'content-type': 'text/plain' }, body: '' });
    expect(calls.some((c) => c.level === 'warn')).toBe(true);
  });
});

describe('events-api ingress: logging', () => {
  it('failure logs carry the reason but never the body or signature', async () => {
    const marker = 'SECRET-MARKER-7f3a';
    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev9', event: { text: marker } });
    const badSig = sign('wrong', TS, body);
    const cases: [Record<string, string | undefined>, string, number][] = [
      [headers(badSig), 'bad signature', NOW_MS],
      [headers(undefined), 'missing signature headers', NOW_MS],
      [headers(sign(SECRET, TS, body)), 'stale timestamp', NOW_MS + 999_000],
    ];
    for (const [h, reason, now] of cases) {
      const { ingress, calls } = setup({ now });
      expect((await ingress.handle(body, h)).status).toBe(401);
      const logged = JSON.stringify(calls.map((c) => c.args.map(String)));
      expect(logged).toContain(reason);
      expect(logged).not.toContain(marker);
      expect(logged).not.toContain(badSig.slice(3));
      expect(calls.every((c) => c.level === 'warn')).toBe(true);
    }
  });

  it('an unparseable signed body is not logged', async () => {
    const marker = 'NOT-JSON-MARKER-91';
    const body = `garbage ${marker}`;
    const { ingress, calls } = setup();
    expect((await ingress.handle(body, headers(sign(SECRET, TS, body)))).status).toBe(200);
    expect(JSON.stringify(calls.map((c) => c.args.map(String)))).not.toContain(marker);
  });
});
