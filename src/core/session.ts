// The session hub: owns every client connection and runs protocol 1 on a bare
// transport (Spec 001 Decisions 9 and 10). No HTTP or WebSocket library here;
// the h3 and standalone adapters hand it { send, close } and call receive/closed.

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { ProtocolError, parseClientFrame } from '../protocol/parse.js';
import {
  CLOSE,
  PROTOCOL_VERSION,
  type ClientFrame,
  type HelloFrame,
  type HistoryFrame,
  type HistoryResultFrame,
  type PostFrame,
  type ReactFrame,
  type RelayMessage,
  type ReplyFrame,
  type ResultFrame,
  type ServerFrame,
  type StatusFrame,
} from '../protocol/types.js';
import type { ResolvedConfig } from './config.js';
import { verifyKey } from './keys.js';
import type { Logger } from './logger.js';

// TODO(001-5): replace with `import type { Delivery } from './router.js'` once router.ts lands.
/** Implemented by the session hub; the router calls it (Spec 001 task 5). */
export interface Delivery {
  toSite(site: string, msg: RelayMessage): void;
  toViewers(msg: RelayMessage): void;
}

/** Who is on the other end of an authenticated connection. */
export interface Principal {
  role: 'site' | 'viewer';
  name: string;
  channels: string[];
  canPost: boolean;
}

export type RequestHandler = (
  p: Principal,
  f: ReplyFrame | ReactFrame | PostFrame | HistoryFrame,
) => Promise<ResultFrame | HistoryResultFrame>;

type Transport = { send(text: string): void; close(code: number, reason: string): void };
type SlackStatus = { slack: 'connected' | 'disconnected'; slackSharedApp: boolean };
type RequestFrame = ReplyFrame | ReactFrame | PostFrame | HistoryFrame;

const RELAY_VERSION: string = createRequire(import.meta.url)('../../package.json').version;

/** Which role may send each request type (Decision 9). */
const ALLOWED_ROLE: Record<RequestFrame['type'], Principal['role']> = {
  reply: 'site',
  react: 'site',
  post: 'viewer',
  history: 'viewer',
};

interface Conn {
  t: Transport;
  state: 'awaiting-hello' | 'open' | 'closed';
  principal: Principal | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Viewer connections number their own `message` frames from 1. */
  viewerSeq: number;
}

interface SiteState {
  seq: number;
  buffer: { seq: number; at: number; msg: RelayMessage }[];
  conn: Conn | null;
  lastSeenMs: number | null;
}

export function createSessionHub(o: {
  config: ResolvedConfig;
  requests: RequestHandler;
  now(): number;
  logger: Logger;
  epoch?: string;
}): Delivery & {
  openConnection(t: { send(text: string): void; close(code: number, reason: string): void }): {
    receive(text: string): void;
    closed(): void;
  };
  setSlackStatus(s: { slack: 'connected' | 'disconnected'; slackSharedApp: boolean }): void;
  health(): { sites: { name: string; connected: boolean; lastSeenMs: number | null }[]; viewers: number };
  closeAll(code: number, reason: string): void;
} {
  const { config, logger, now } = o;
  const limits = config.limits;
  const epoch = o.epoch ?? randomBytes(9).toString('base64url');
  let slackStatus: SlackStatus = { slack: 'disconnected', slackSharedApp: false };

  const sites = new Map<string, SiteState>(
    config.sites.map((s) => [s.name, { seq: 0, buffer: [], conn: null, lastSeenMs: null }]),
  );
  const viewers = new Set<Conn>();
  /** Every connection not yet closed, including those in handshake (for closeAll). */
  const live = new Set<Conn>();

  const send = (c: Conn, frame: ServerFrame) => c.t.send(JSON.stringify(frame));
  const statusFrame = (): StatusFrame => ({ type: 'status', ...slackStatus });

  function clearTimers(c: Conn) {
    if (c.handshakeTimer) clearTimeout(c.handshakeTimer);
    if (c.idleTimer) clearTimeout(c.idleTimer);
    c.handshakeTimer = c.idleTimer = null;
  }

  /** Forget a connection: timers, viewer set, and its site slot if it still holds it. */
  function release(c: Conn) {
    clearTimers(c);
    c.state = 'closed';
    live.delete(c);
    viewers.delete(c);
    if (c.principal?.role === 'site') {
      const site = sites.get(c.principal.name);
      if (site?.conn === c) site.conn = null;
    }
  }

  function close(c: Conn, code: number, reason: string) {
    if (c.state === 'closed') return;
    release(c);
    c.t.close(code, reason);
  }

  /** Fatal close: `error` frame first (Decision 9), then the close code. */
  function fail(c: Conn, code: number, message: string) {
    if (c.state === 'closed') return;
    send(c, { type: 'error', code, message });
    close(c, code, message);
  }

  function prune(site: SiteState) {
    const cutoff = now() - limits.resumeWindowMs;
    let drop = 0;
    while (drop < site.buffer.length && site.buffer[drop]!.at < cutoff) drop++;
    drop = Math.max(drop, site.buffer.length - limits.resumeMaxEvents);
    if (drop > 0) site.buffer.splice(0, drop);
  }

  function resetIdle(c: Conn) {
    if (c.idleTimer) clearTimeout(c.idleTimer);
    c.idleTimer = setTimeout(() => fail(c, CLOSE.IDLE, 'idle'), limits.idleTimeoutMs);
  }

  function findPrincipal(hello: HelloFrame): Principal | null {
    if (hello.role === 'site') {
      const s = config.sites.find((e) => verifyKey(hello.key, e.keyHashes));
      return s ? { role: 'site', name: s.name, channels: [...s.channels], canPost: false } : null;
    }
    // validateConfig has already expanded '*' to every site-owned channel.
    const v = config.viewers.find((e) => verifyKey(hello.key, e.keyHashes));
    return v ? { role: 'viewer', name: v.name, channels: [...v.channels], canPost: v.canPost } : null;
  }

  function handshake(c: Conn, hello: HelloFrame) {
    if (hello.protocol !== PROTOCOL_VERSION) {
      fail(c, CLOSE.UNSUPPORTED_PROTOCOL, 'protocol 1 required');
      return;
    }
    const principal = findPrincipal(hello);
    const who = `${hello.client.name}/${hello.client.version}`;
    if (!principal) {
      logger.warn(`rejected ${hello.role} key from ${who}`);
      fail(c, CLOSE.UNAUTHORIZED, 'key rejected');
      return;
    }

    c.principal = principal;
    c.state = 'open';
    if (c.handshakeTimer) clearTimeout(c.handshakeTimer);
    c.handshakeTimer = null;
    resetIdle(c);
    logger.info(`${principal.role} "${principal.name}" connected (${who})`);

    let resumed = false;
    let replayFrom = 0;
    if (principal.role === 'site') {
      const site = sites.get(principal.name)!;
      site.lastSeenMs = now();
      if (site.conn) {
        logger.warn(`site "${principal.name}" replaced by a newer connection`);
        fail(site.conn, CLOSE.REPLACED, 'replaced by a newer connection');
      }
      site.conn = c;

      prune(site);
      const r = hello.resume;
      if (r && r.epoch === epoch) {
        resumed = r.seq === site.seq || site.buffer.some((e) => e.seq === r.seq + 1);
        replayFrom = r.seq;
      }
      if (r && !resumed) logger.info(`site "${principal.name}" could not resume from seq ${r.seq}; a gap is possible`);
    } else {
      viewers.add(c);
    }

    send(c, {
      type: 'welcome',
      protocol: 1,
      role: principal.role,
      name: principal.name,
      channels: principal.channels,
      epoch,
      resumed,
      relay: { version: RELAY_VERSION },
    });
    send(c, statusFrame());
    if (resumed) {
      for (const e of sites.get(principal.name)!.buffer) {
        if (e.seq > replayFrom) send(c, { type: 'message', seq: e.seq, ...e.msg });
      }
    }
  }

  function request(c: Conn, principal: Principal, frame: RequestFrame) {
    if (ALLOWED_ROLE[frame.type] !== principal.role) {
      send(c, { type: 'result', id: frame.id, ok: false, error: 'not_allowed' });
      return;
    }
    const answer = (result: ResultFrame | HistoryResultFrame) => {
      if (c.state !== 'open') {
        logger.debug(`dropped ${result.type} ${frame.id} for a closed ${principal.role} "${principal.name}"`);
        return;
      }
      send(c, result);
    };
    o.requests(principal, frame).then(answer, (err: unknown) => {
      logger.error(`${frame.type} ${frame.id} from ${principal.role} "${principal.name}" failed:`, err);
      answer({ type: 'result', id: frame.id, ok: false, error: 'invalid' });
    });
  }

  function receive(c: Conn, text: string) {
    if (c.state === 'closed') return;
    if (Buffer.byteLength(text, 'utf8') > limits.maxFrameBytes) {
      fail(c, CLOSE.BAD_FRAME, 'frame too large');
      return;
    }
    let frame: ClientFrame;
    try {
      frame = parseClientFrame(text);
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      fail(c, CLOSE.BAD_FRAME, err.message);
      return;
    }

    if (c.state === 'awaiting-hello') {
      if (frame.type !== 'hello') fail(c, CLOSE.BAD_FRAME, 'expected hello');
      else handshake(c, frame);
      return;
    }

    const principal = c.principal!;
    resetIdle(c);
    if (principal.role === 'site') sites.get(principal.name)!.lastSeenMs = now();

    switch (frame.type) {
      case 'hello':
        fail(c, CLOSE.BAD_FRAME, 'unexpected hello');
        return;
      case 'ping':
        send(c, { type: 'pong' });
        return;
      default:
        request(c, principal, frame);
    }
  }

  return {
    openConnection(t) {
      const c: Conn = { t, state: 'awaiting-hello', principal: null, handshakeTimer: null, idleTimer: null, viewerSeq: 0 };
      live.add(c);
      c.handshakeTimer = setTimeout(() => fail(c, CLOSE.HANDSHAKE_TIMEOUT, 'no hello'), limits.handshakeTimeoutMs);
      return {
        receive: (text) => receive(c, text),
        closed: () => {
          if (c.state !== 'closed') release(c);
        },
      };
    },

    toSite(name, msg) {
      const site = sites.get(name);
      if (!site) {
        logger.warn(`toSite: unknown site "${name}"; message ${msg.eventId} dropped`);
        return;
      }
      const seq = ++site.seq;
      site.buffer.push({ seq, at: now(), msg });
      prune(site);
      if (site.conn?.state === 'open') send(site.conn, { type: 'message', seq, ...msg });
    },

    toViewers(msg) {
      for (const c of viewers) {
        if (c.principal!.channels.includes(msg.channel)) send(c, { type: 'message', seq: ++c.viewerSeq, ...msg });
      }
    },

    setSlackStatus(s) {
      if (s.slack === slackStatus.slack && s.slackSharedApp === slackStatus.slackSharedApp) return;
      slackStatus = { slack: s.slack, slackSharedApp: s.slackSharedApp };
      for (const c of live) if (c.state === 'open') send(c, statusFrame());
    },

    health() {
      return {
        sites: config.sites.map((s) => {
          const site = sites.get(s.name)!;
          return { name: s.name, connected: site.conn !== null, lastSeenMs: site.lastSeenMs };
        }),
        viewers: viewers.size,
      };
    },

    closeAll(code, reason) {
      for (const c of [...live]) close(c, code, reason);
    },
  };
}
