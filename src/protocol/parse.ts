// Hand-written runtime parser for protocol 1. It matches
// protocol/schema/frame.schema.json field for field; test/protocol/fixtures.test.ts
// keeps the two in step. Unknown fields are tolerated and not copied.
// Config-dependent limits (maxFrameBytes, limit ≤ historySize) are the session's job.

import type {
  ClientFrame,
  ErrorFrame,
  HelloFrame,
  HistoryFrame,
  HistoryResultFrame,
  MessageFrame,
  PingFrame,
  PongFrame,
  PostFrame,
  ReactFrame,
  RelayMessage,
  ReplyFrame,
  ResultError,
  ResultFrame,
  ServerFrame,
  StatusFrame,
  WelcomeFrame,
} from './types.js';

export { CLOSE } from './types.js';

/** A frame that doesn't parse or validate; the session closes with 4000. */
export class ProtocolError extends Error {
  override name = 'ProtocolError';
}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const RESULT_ERROR = /^(not_allowed|invalid|rate_limited|slack:.+)$/;

/** Reads typed fields from one JSON object; `path` names it in error messages. */
class Fields {
  constructor(
    private readonly o: Obj,
    private readonly path: string,
  ) {}

  private fail(key: string, what: string): never {
    throw new ProtocolError(`${this.path}.${key} must be ${what}`);
  }

  has(key: string): boolean {
    return this.o[key] !== undefined;
  }

  string(key: string): string {
    const v = this.o[key];
    return typeof v === 'string' ? v : this.fail(key, 'a string');
  }

  boolean(key: string): boolean {
    const v = this.o[key];
    return typeof v === 'boolean' ? v : this.fail(key, 'a boolean');
  }

  integer(key: string, min?: number): number {
    const v = this.o[key];
    if (!Number.isInteger(v)) this.fail(key, 'an integer');
    const n = v as number;
    if (min !== undefined && n < min) this.fail(key, `an integer ≥ ${min}`);
    return n;
  }

  oneOf<T extends string>(key: string, values: readonly T[]): T {
    const v = this.o[key];
    return (values as readonly unknown[]).includes(v)
      ? (v as T)
      : this.fail(key, `one of ${values.map((x) => JSON.stringify(x)).join(', ')}`);
  }

  object(key: string): Fields {
    const v = this.o[key];
    return isObject(v) ? new Fields(v, `${this.path}.${key}`) : this.fail(key, 'an object');
  }

  array(key: string): unknown[] {
    const v = this.o[key];
    return Array.isArray(v) ? v : this.fail(key, 'an array');
  }

  /** Copies `key` into `out` only when present, so absent optionals stay absent. */
  optional<K extends string, V>(out: { [P in K]?: V }, key: K, read: (key: K) => V): void {
    if (this.has(key)) out[key] = read(key);
  }
}

const ROLES = ['site', 'viewer'] as const;
const KINDS = ['channel', 'thread'] as const;
const ORIGINS = ['slack', 'relay'] as const;
const SLACK_STATES = ['connected', 'disconnected'] as const;

function relayMessage(f: Fields, path: string): RelayMessage {
  const m: RelayMessage = {
    eventId: f.string('eventId'),
    channel: f.string('channel'),
    ts: f.string('ts'),
    text: f.string('text'),
    kind: f.oneOf('kind', KINDS),
    fromSelf: f.boolean('fromSelf'),
    origin: f.oneOf('origin', ORIGINS),
  };
  if (m.kind === 'thread' && !f.has('threadTs')) {
    throw new ProtocolError(`${path}.threadTs is required when kind is "thread"`);
  }
  f.optional(m, 'threadTs', (k) => f.string(k));
  f.optional(m, 'user', (k) => f.string(k));
  f.optional(m, 'botId', (k) => f.string(k));
  return m;
}

const clientParsers: { [T in ClientFrame['type']]: (f: Fields) => Extract<ClientFrame, { type: T }> } = {
  hello(f): HelloFrame {
    const client = f.object('client');
    const out: HelloFrame = {
      type: 'hello',
      protocol: f.integer('protocol', 1),
      role: f.oneOf('role', ROLES),
      key: f.string('key'),
      client: { name: client.string('name'), version: client.string('version') },
    };
    if (f.has('resume')) {
      const r = f.object('resume');
      out.resume = { epoch: r.string('epoch'), seq: r.integer('seq', 0) };
    }
    return out;
  },
  reply: (f): ReplyFrame => ({
    type: 'reply',
    id: f.string('id'),
    channel: f.string('channel'),
    threadTs: f.string('threadTs'),
    text: f.string('text'),
  }),
  react: (f): ReactFrame => ({
    type: 'react',
    id: f.string('id'),
    channel: f.string('channel'),
    ts: f.string('ts'),
    emoji: f.string('emoji'),
  }),
  post(f): PostFrame {
    const out: PostFrame = {
      type: 'post',
      id: f.string('id'),
      channel: f.string('channel'),
      text: f.string('text'),
    };
    f.optional(out, 'threadTs', (k) => f.string(k));
    return out;
  },
  history(f): HistoryFrame {
    const out: HistoryFrame = { type: 'history', id: f.string('id'), channel: f.string('channel') };
    f.optional(out, 'limit', (k) => f.integer(k, 1));
    return out;
  },
  ping: (): PingFrame => ({ type: 'ping' }),
};

const serverParsers: { [T in ServerFrame['type']]: (f: Fields) => Extract<ServerFrame, { type: T }> } = {
  welcome(f): WelcomeFrame {
    if (f.integer('protocol') !== 1) throw new ProtocolError('welcome.protocol must be 1');
    const relay = f.object('relay');
    return {
      type: 'welcome',
      protocol: 1,
      role: f.oneOf('role', ROLES),
      name: f.string('name'),
      channels: f.array('channels').map((c, i) => {
        if (typeof c !== 'string') throw new ProtocolError(`welcome.channels[${i}] must be a string`);
        return c;
      }),
      epoch: f.string('epoch'),
      resumed: f.boolean('resumed'),
      relay: { version: relay.string('version') },
    };
  },
  message: (f): MessageFrame => ({
    type: 'message',
    seq: f.integer('seq', 1),
    ...relayMessage(f, 'message'),
  }),
  result(f): ResultFrame {
    const out: ResultFrame = { type: 'result', id: f.string('id'), ok: f.boolean('ok') };
    f.optional(out, 'ts', (k) => f.string(k));
    f.optional(out, 'error', (k) => {
      const e = f.string(k);
      if (!RESULT_ERROR.test(e)) {
        throw new ProtocolError(
          'result.error must be "not_allowed", "invalid", "rate_limited" or "slack:<code>"',
        );
      }
      return e as ResultError;
    });
    if (!out.ok && out.error === undefined) {
      throw new ProtocolError('result.error is required when ok is false');
    }
    return out;
  },
  history_result: (f): HistoryResultFrame => ({
    type: 'history_result',
    id: f.string('id'),
    channel: f.string('channel'),
    messages: f.array('messages').map((m, i) => {
      const path = `history_result.messages[${i}]`;
      if (!isObject(m)) throw new ProtocolError(`${path} must be an object`);
      return relayMessage(new Fields(m, path), path);
    }),
  }),
  status: (f): StatusFrame => ({
    type: 'status',
    slack: f.oneOf('slack', SLACK_STATES),
    slackSharedApp: f.boolean('slackSharedApp'),
  }),
  pong: (): PongFrame => ({ type: 'pong' }),
  error: (f): ErrorFrame => ({
    type: 'error',
    code: f.integer('code'),
    message: f.string('message'),
  }),
};

function parseWith<F>(
  text: string,
  parsers: Record<string, (f: Fields) => F>,
  direction: string,
): F {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ProtocolError(`frame is not JSON: ${(err as Error).message}`);
  }
  if (!isObject(json)) throw new ProtocolError('frame must be a JSON object');
  const type = json.type;
  if (typeof type !== 'string') throw new ProtocolError('frame.type must be a string');
  if (!Object.hasOwn(parsers, type)) {
    throw new ProtocolError(`unknown ${direction} frame type "${type}"`);
  }
  return parsers[type]!(new Fields(json, type));
}

/** Parses a client → relay frame. Throws ProtocolError (→ close 4000). */
export function parseClientFrame(text: string): ClientFrame {
  return parseWith<ClientFrame>(text, clientParsers, 'client');
}

/** Parses a relay → client frame; for tests and dev:site. Throws ProtocolError. */
export function parseServerFrame(text: string): ServerFrame {
  return parseWith<ServerFrame>(text, serverParsers, 'server');
}
