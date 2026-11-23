// createRelay: validates the config and wires every core module together
// (Spec 001 Decision 12; plan 001, "Interfaces between tasks"):
//   ingress → router.ingest; router → hub (as Delivery, tapped by history and
//   in-process viewers); hub requests → outbound, or history for `history`
//   frames; outbound.onRelayPost → history + router.route.

import { CLOSE, type HistoryFrame, type HistoryResultFrame, type RelayMessage, type ResultError } from '../protocol/types.js';
import { validateConfig, type RelayConfig } from './config.js';
import { createHistory } from './history.js';
import { createEventsApiIngress, type EventsApiResponse } from './ingress/events-api.js';
import { createSocketMode, nextBackoffMs, type SlackStatus } from './ingress/socket-mode.js';
import { consoleLogger, type Logger } from './logger.js';
import { createOutbound } from './outbound.js';
import { createRouter, normalize, type Delivery } from './router.js';
import { createSessionHub, type Principal, type RequestHandler } from './session.js';
import { createSlackApi, SlackApiError, type BotIdentity, type SlackApi } from './slack-api.js';

export interface ViewerHandle {
  /** The last `limit` (≤ historySize) messages in a subscribed channel, oldest first; `[]` otherwise. */
  history(channel: string, limit?: number): RelayMessage[];
  /** Same rules and outcomes as a `post` frame. */
  post(channel: string, text: string, threadTs?: string): Promise<{ ok: boolean; ts?: string; error?: ResultError }>;
  /** Stops delivery to this viewer's listener. Idempotent. */
  close(): void;
}

export interface HealthReport {
  slack: 'connected' | 'disconnected';
  slackSharedApp: boolean;
  ingress: 'events-api' | 'socket-mode';
  sites: { name: string; connected: boolean; lastSeenMs: number | null }[];
  viewers: number;
}

export interface Relay {
  /** auth.test, history backfill, Socket Mode connect (if configured). Runs once; never rejects for a Slack failure. */
  start(): Promise<void>;
  /** Closes every connection with 1001 and stops ingress and retries. Idempotent. */
  stop(): Promise<void>;
  handleSlackEvent(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<{ status: number; headers?: Record<string, string>; body?: string }>;
  openConnection(transport: { send(text: string): void; close(code: number, reason: string): void }): {
    receive(text: string): void;
    closed(): void;
  };
  viewer(opts: { name: string; channels?: string[] }, listener: (m: RelayMessage) => void): ViewerHandle;
  health(): HealthReport;
}

/** auth.test retry schedule (Decision 4's numbers; the spec gives none for auth.test). */
const AUTH_BACKOFF = { baseMs: 1_000, maxMs: 60_000 };

export function createRelay(options: {
  config: RelayConfig;
  logger?: Logger;
  slackApi?: SlackApi;
  now?: () => number;
}): Relay {
  const resolved = validateConfig(options.config);
  const logger = options.logger ?? consoleLogger;
  const now = options.now ?? Date.now;
  const slackApi = options.slackApi ?? createSlackApi({ botToken: resolved.slack.botToken });
  const ingressConfig = resolved.slack.ingress;

  let botIdentity: BotIdentity | null = null;
  let slackStatus: SlackStatus = { slack: 'disconnected', slackSharedApp: false };
  let stopped = false;

  const history = createHistory({
    config: resolved,
    slackApi,
    logger,
    // Backfill goes through normalize so the subtype filter, thread rule, and fromSelf match live messages.
    toMessage: (channel, m) =>
      normalize({ eventId: `history:${channel}:${m.ts}`, event: { ...m, type: 'message', channel } }, botIdentity),
  });

  // In-process viewers (Decision 11): no key, channels and canPost from config.viewers.
  const inProcess = new Set<{ channels: Set<string>; listener: (m: RelayMessage) => void }>();
  function deliverInProcess(m: RelayMessage): void {
    if (stopped) return;
    for (const v of inProcess) {
      if (!v.channels.has(m.channel)) continue;
      try {
        v.listener(m);
      } catch (err) {
        logger.error(`in-process viewer listener threw for ${m.eventId}`, err);
      }
    }
  }

  function historyResult(p: Principal, f: HistoryFrame): HistoryResultFrame {
    const subscribed = p.role === 'viewer' && p.channels.includes(f.channel);
    if (!subscribed) logger.debug(`history ${f.id} from ${p.role} "${p.name}" for unsubscribed ${f.channel}: empty`);
    return {
      type: 'history_result',
      id: f.id,
      channel: f.channel,
      messages: subscribed ? history.get(f.channel, f.limit) : [],
    };
  }

  const requests: RequestHandler = (p, f) =>
    f.type === 'history' ? Promise.resolve(historyResult(p, f)) : outbound.request(p, f);

  const hub = createSessionHub({ config: resolved, requests, now, logger });

  // History taps toViewers: the router calls it for every accepted message
  // (stale or fromSelf included) except origin:'relay' copies.
  const delivery: Delivery = {
    toSite: (s, m) => hub.toSite(s, m),
    toViewers: (m) => {
      history.add(m);
      hub.toViewers(m);
      deliverInProcess(m);
    },
  };

  const router = createRouter({ config: resolved, delivery, now, logger });

  const outbound = createOutbound({
    slackApi,
    config: resolved,
    logger,
    // History records the post at once; Slack's echo (same ts) later replaces it.
    onRelayPost: (m) => {
      history.add(m);
      router.route(m);
    },
  });

  function setStatus(s: SlackStatus): void {
    slackStatus = { slack: s.slack, slackSharedApp: s.slackSharedApp };
    hub.setSlackStatus(slackStatus);
  }
  setStatus(slackStatus);

  const eventsApi =
    ingressConfig.mode === 'events-api'
      ? createEventsApiIngress({ signingSecret: ingressConfig.signingSecret, sink: router.ingest, now, logger })
      : null;
  const socketMode =
    ingressConfig.mode === 'socket-mode'
      ? createSocketMode({ appToken: ingressConfig.appToken, slackApi, sink: router.ingest, logger, onStatus: setStatus })
      : null;

  let authTimer: ReturnType<typeof setTimeout> | null = null;

  /** One auth.test attempt; on success sets the identity and backfills, on failure schedules the next. */
  async function authenticate(backoffMs: number): Promise<void> {
    authTimer = null;
    let id: BotIdentity;
    try {
      id = await slackApi.authTest();
    } catch (err) {
      if (stopped) return;
      const next = nextBackoffMs(backoffMs, AUTH_BACKOFF.baseMs, AUTH_BACKOFF.maxMs);
      const code = err instanceof SlackApiError ? err.code : err instanceof Error ? err.message : String(err);
      logger.error(`auth.test failed: ${code}; retrying in ${next} ms (bot messages are held back from sites)`);
      authTimer = setTimeout(() => void authenticate(next), next);
      return;
    }
    if (stopped) return;
    botIdentity = id;
    router.setBotIdentity(id);
    logger.info(`auth.test ok: bot user ${id.userId}, bot id ${id.botId}`);
    if (eventsApi) setStatus({ slack: 'connected', slackSharedApp: false });
    await history.backfill();
  }

  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  return {
    start() {
      startPromise ??= (async () => {
        const socket = socketMode?.start().catch((err: unknown) => logger.error('socket mode: start failed', err));
        await Promise.all([authenticate(0), socket]);
      })();
      return startPromise;
    },

    stop() {
      stopPromise ??= (async () => {
        stopped = true;
        if (authTimer) clearTimeout(authTimer);
        authTimer = null;
        history.stop();
        await socketMode?.stop();
        hub.closeAll(CLOSE.GOING_AWAY, 'relay shutting down');
      })();
      return stopPromise;
    },

    handleSlackEvent(rawBody, headers): Promise<EventsApiResponse> {
      if (!eventsApi) {
        logger.debug('handleSlackEvent called in socket-mode; answering 404');
        return Promise.resolve({ status: 404 });
      }
      return eventsApi.handle(rawBody, headers);
    },

    openConnection(transport) {
      return hub.openConnection(transport);
    },

    viewer(opts, listener) {
      const configured = resolved.viewers.find((v) => v.name === opts.name);
      if (!configured) throw new Error(`relay.viewer: no viewer named "${opts.name}" in config.viewers`);
      const allowed = new Set(configured.channels); // '*' already expanded by validateConfig
      if (opts.channels) {
        const extra = opts.channels.filter((c) => !allowed.has(c));
        if (extra.length > 0) {
          throw new Error(`relay.viewer: viewer "${opts.name}" is not configured for ${extra.join(', ')}`);
        }
      }
      const channels = [...new Set(opts.channels ?? configured.channels)];
      const principal: Principal = { role: 'viewer', name: configured.name, channels, canPost: configured.canPost };
      const entry = { channels: new Set(channels), listener };
      inProcess.add(entry);
      let n = 0;

      return {
        history(channel, limit) {
          return entry.channels.has(channel) ? history.get(channel, limit) : [];
        },
        async post(channel, text, threadTs) {
          const r = await outbound.request(principal, {
            type: 'post',
            id: `inproc:${++n}`,
            channel,
            text,
            ...(threadTs !== undefined ? { threadTs } : {}),
          });
          return {
            ok: r.ok,
            ...(r.ts !== undefined ? { ts: r.ts } : {}),
            ...(r.error !== undefined ? { error: r.error } : {}),
          };
        },
        close() {
          inProcess.delete(entry);
        },
      };
    },

    health() {
      const h = hub.health();
      return {
        slack: slackStatus.slack,
        slackSharedApp: slackStatus.slackSharedApp,
        ingress: ingressConfig.mode,
        sites: h.sites,
        viewers: h.viewers + inProcess.size,
      };
    },
  };
}
