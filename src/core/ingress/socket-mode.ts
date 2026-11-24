import { WebSocket } from 'ws';
import type { Logger } from '../logger.js';
import type { SlackApi } from '../slack-api.js';
import type { SlackEventSink } from './events-api.js';

/** Same shape as the argument of `hub.setSlackStatus`, so the relay passes it straight through. */
export type SlackStatus = { slack: 'connected' | 'disconnected'; slackSharedApp: boolean };

/** Test seam; production uses the defaults (Spec 001 Decision 4). */
export interface SocketModeTiming {
  pingIntervalMs: number;
  staleAfterMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /**
   * How often a healthy connection is handed off to a fresh socket. Slack
   * reports `num_connections` only in `hello`, so this is how the relay
   * notices a client that joined the app after it (or one that left).
   */
  refreshIntervalMs: number;
}

const DEFAULT_TIMING: SocketModeTiming = {
  pingIntervalMs: 10_000,
  staleAfterMs: 30_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  refreshIntervalMs: 300_000,
};

/** The next reconnect delay: `base` after 0, then doubling, capped at `max`. */
export function nextBackoffMs(currentMs: number, baseMs: number, maxMs: number): number {
  return currentMs <= 0 ? Math.min(baseMs, maxMs) : Math.min(currentMs * 2, maxMs);
}

export interface Watchdog {
  noteActivity(): void;
  stop(): void;
}

/**
 * Per-socket liveness check. Every `pingIntervalMs` it looks at the time since
 * the last noted activity: at or past `staleAfterMs` it stops and calls
 * `expire`; otherwise it calls `ping`. Armed on creation, so a socket that
 * never opens or never says `hello` expires too.
 */
export function createWatchdog(o: {
  pingIntervalMs: number;
  staleAfterMs: number;
  ping(): void;
  expire(reason: string): void;
}): Watchdog {
  let last = Date.now();
  const timer = setInterval(() => {
    const idle = Date.now() - last;
    if (idle >= o.staleAfterMs) {
      clearInterval(timer);
      o.expire(`no frame or pong for ${idle} ms`);
    } else {
      o.ping();
    }
  }, o.pingIntervalMs);
  return {
    noteActivity: () => {
      last = Date.now();
    },
    stop: () => clearInterval(timer),
  };
}

interface Sock {
  id: number;
  ws: WebSocket;
  watchdog: Watchdog;
  hello: boolean;
  /** Opened by a routine refresh rather than a reconnect or Slack's `disconnect`; logs quietly. */
  refresh: boolean;
  /** Set once the socket is retired, stopped, or its close has been handled; its events are ignored. */
  done: boolean;
  closed: Promise<void>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The Socket Mode half of Slack ingress (Spec 001 Decision 4). Ports
 * ProPager's `SlackClient` make-before-break handoff and liveness rules:
 * acks every envelope on its own socket before processing, hands
 * `events_api` events to `sink`, opens a replacement on `disconnect` and
 * switches on its `hello`, pings and expires stale sockets, and backs off
 * between failed connects. Reports status changes through `onStatus`.
 */
export function createSocketMode(o: {
  appToken: string;
  slackApi: SlackApi;
  sink: SlackEventSink;
  logger: Logger;
  onStatus(s: SlackStatus): void;
  timing?: Partial<SocketModeTiming>;
}): { start(): Promise<void>; stop(): Promise<void>; status(): SlackStatus } {
  const { appToken, slackApi, sink, logger } = o;
  const timing: SocketModeTiming = { ...DEFAULT_TIMING, ...o.timing };

  let active: Sock | null = null;
  let pending: Sock | null = null;
  let opening = false;
  let backoffMs = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let nextId = 0;
  let status: SlackStatus = { slack: 'disconnected', slackSharedApp: false };

  function setStatus(next: SlackStatus): void {
    if (next.slack === status.slack && next.slackSharedApp === status.slackSharedApp) return;
    status = next;
    o.onStatus({ ...status });
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    backoffMs = nextBackoffMs(backoffMs, timing.backoffBaseMs, timing.backoffMaxMs);
    logger.info(`socket mode: reconnecting in ${backoffMs} ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void requestConnection(false);
    }, backoffMs);
  }

  /** (Re)starts the countdown to the next routine handoff. */
  function armRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (stopped) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      armRefresh(); // a refresh that fails or never says hello still gets another try
      if (!active || pending || opening) return;
      logger.debug(`socket mode: refreshing socket ${active.id} to recheck for other clients`);
      void requestConnection(true, true);
    }, timing.refreshIntervalMs);
  }

  /** Opens a socket; resolves once it has opened or its failure has been handled. */
  async function requestConnection(graceful: boolean, refresh = false): Promise<void> {
    opening = true;
    let url: string;
    try {
      url = await slackApi.openSocketModeUrl(appToken);
    } catch (err) {
      opening = false;
      if (stopped) return;
      if (graceful && active) {
        (refresh ? logger.debug : logger.warn)('socket mode: replacement handshake failed; keeping current connection', err);
      } else {
        logger.error('socket mode: apps.connections.open failed', err);
        scheduleReconnect();
      }
      return;
    }
    opening = false;
    if (stopped) return;

    const sock = createSock(url, refresh);
    if (graceful && active) {
      pending = sock;
    } else {
      // A graceful attempt whose active socket died meanwhile becomes the active one.
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      active = sock;
    }
    await new Promise<void>((resolve) => {
      sock.ws.once('open', () => resolve());
      void sock.closed.then(resolve);
    });
  }

  function createSock(url: string, refresh: boolean): Sock {
    const ws = new WebSocket(url);
    const id = ++nextId;
    const sock: Sock = {
      id,
      ws,
      hello: false,
      refresh,
      done: false,
      closed: new Promise<void>((resolve) => ws.once('close', () => resolve())),
      watchdog: createWatchdog({
        pingIntervalMs: timing.pingIntervalMs,
        staleAfterMs: timing.staleAfterMs,
        ping: () => {
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        },
        expire: (reason) => {
          if (sock.done) return;
          logger.warn(`socket mode: socket ${id} expired (${reason}); dropping it`);
          ws.terminate();
          onSockClosed(sock);
        },
      }),
    };
    ws.on('error', (err) => {
      if (!sock.done) logger.warn(`socket mode: socket ${id} error`, err);
    });
    // Pongs prove the link only after hello; before it, a socket that pongs but
    // never says hello must still expire (the watchdog doubles as the hello deadline).
    ws.on('pong', () => {
      if (!sock.done && sock.hello) sock.watchdog.noteActivity();
    });
    ws.on('message', (data) => {
      if (!sock.done) onFrame(sock, data.toString());
    });
    ws.on('close', (code) => {
      if (sock.done) return;
      logger.info(`socket mode: socket ${id} closed (${code})`);
      onSockClosed(sock);
    });
    return sock;
  }

  function onFrame(sock: Sock, text: string): void {
    sock.watchdog.noteActivity();
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      logger.warn(`socket mode: unparseable frame on socket ${sock.id}`);
      return;
    }
    if (!isObject(msg)) {
      logger.warn(`socket mode: non-object frame on socket ${sock.id}`);
      return;
    }
    // Ack first, on the socket the envelope arrived on.
    if (typeof msg.envelope_id === 'string') {
      sock.ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
    }

    switch (msg.type) {
      case 'hello':
        onHello(sock, msg);
        return;
      case 'disconnect':
        logger.info(`socket mode: disconnect (${String(msg.reason)}) on socket ${sock.id}`);
        if (sock === active && !pending && !opening) void requestConnection(true);
        return;
      case 'events_api': {
        const payload = isObject(msg.payload) ? msg.payload : undefined;
        const eventId = payload?.event_id;
        const event = payload?.event;
        if (typeof eventId !== 'string' || !isObject(event)) {
          logger.warn('socket mode: events_api envelope without payload.event_id or payload.event; skipped');
          return;
        }
        try {
          sink({ eventId, event });
        } catch (err) {
          logger.error(`socket mode: sink threw for ${eventId}`, err);
        }
        return;
      }
      default:
        logger.debug(`socket mode: ignoring ${String(msg.type)} envelope`);
    }
  }

  function onHello(sock: Sock, msg: Record<string, unknown>): void {
    sock.hello = true;
    backoffMs = 0;
    const debugInfo = isObject(msg.debug_info) ? msg.debug_info : undefined;
    if (debugInfo?.approximate_connection_time !== undefined) {
      (sock.refresh ? logger.debug : logger.info)(
        `socket mode: hello on socket ${sock.id}; approximate connection time ${String(debugInfo.approximate_connection_time)} s`,
      );
    }
    const own = [active, pending].filter((s) => s && s.ws.readyState === WebSocket.OPEN).length;
    const reported = typeof msg.num_connections === 'number' ? msg.num_connections : own;
    const shared = reported > own;
    // A shared app warns once when it starts (or on a fresh connect), not on every refresh.
    if (shared && (!status.slackSharedApp || !sock.refresh)) {
      logger.warn(
        `socket mode: Slack reports ${reported} connections but this relay has ${own}; ` +
          'another client on this app is taking some of the events',
      );
    }
    if (!shared && status.slackSharedApp && (sock === pending || sock === active)) {
      logger.info('socket mode: no other client on this app any more');
    }
    if (sock === pending) promotePending();
    if (sock === active) {
      setStatus({ slack: 'connected', slackSharedApp: shared });
      armRefresh();
    }
  }

  function retire(sock: Sock): void {
    sock.done = true;
    sock.watchdog.stop();
    sock.ws.close(1000);
  }

  function promotePending(): void {
    const old = active;
    active = pending;
    pending = null;
    if (old) {
      (active!.refresh ? logger.debug : logger.info)(`socket mode: switched to socket ${active!.id}; closing socket ${old.id}`);
      retire(old);
    }
  }

  function onSockClosed(sock: Sock): void {
    if (sock.done) return;
    sock.done = true;
    sock.watchdog.stop();
    if (sock === pending) {
      pending = null;
      if (!active) {
        setStatus({ ...status, slack: 'disconnected' });
        scheduleReconnect();
      } else {
        (sock.refresh ? logger.debug : logger.warn)(
          'socket mode: replacement handshake failed; keeping current connection',
        );
      }
    } else if (sock === active) {
      active = null;
      if (pending) return; // it takes over on its hello
      setStatus({ ...status, slack: 'disconnected' });
      scheduleReconnect();
    }
  }

  return {
    async start() {
      stopped = false;
      await requestConnection(false);
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      const socks = [active, pending].filter((s): s is Sock => s !== null);
      active = null;
      pending = null;
      for (const s of socks) retire(s);
      await Promise.all(socks.map((s) => s.closed));
    },
    status: () => ({ ...status }),
  };
}
