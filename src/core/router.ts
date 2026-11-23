import type { RelayMessage } from '../protocol/types.js';
import type { ResolvedConfig } from './config.js';
import type { SlackEventSink } from './ingress/events-api.js';
import type { Logger } from './logger.js';
import { normalize } from './normalize.js';
import type { BotIdentity } from './slack-api.js';

export { normalize };

/** Where routed messages go; implemented by the session hub (task 6). */
export interface Delivery {
  toSite(site: string, msg: RelayMessage): void;
  toViewers(msg: RelayMessage): void;
}

/** Event ids are remembered this long (Spec 001 Decision 5). */
export const DEDUPE_TTL_MS = 600_000;
/** At most this many event ids are remembered. */
export const DEDUPE_MAX = 5_000;

/**
 * Inbound path: configured-channel check → normalize → dedupe → viewers →
 * age → echo filter → owning site (Spec 001 Decisions 5, 6, 8). Knows nothing
 * about sockets or sessions.
 */
export function createRouter(o: { config: ResolvedConfig; delivery: Delivery; now(): number; logger: Logger }): {
  setBotIdentity(id: BotIdentity): void;
  ingest: SlackEventSink;
  route(msg: RelayMessage): void;
} {
  const { config, delivery, now, logger } = o;

  // Every site channel plus every channel a viewer lists ('*' is already
  // expanded to site channels by validateConfig).
  const channels = new Set<string>(config.channelOwner.keys());
  for (const v of config.viewers) for (const c of v.channels) channels.add(c);

  let identity: BotIdentity | null = null;
  const seen = new Map<string, number>(); // eventId → first seen (insertion order = age order)

  function isDuplicate(eventId: string): boolean {
    const t = now();
    for (const [id, at] of seen) {
      if (t - at <= DEDUPE_TTL_MS) break;
      seen.delete(id);
    }
    if (seen.has(eventId)) return true;
    seen.set(eventId, t);
    while (seen.size > DEDUPE_MAX) seen.delete(seen.keys().next().value as string);
    return false;
  }

  function route(msg: RelayMessage): void {
    if (isDuplicate(msg.eventId)) {
      logger.debug('router: duplicate event_id', msg.eventId);
      return;
    }

    // Viewers get everything; a relay-originated post reaches them as Slack's echo instead (Decision 8).
    if (msg.origin !== 'relay') delivery.toViewers(msg);

    const ageMs = now() - Number(msg.ts) * 1000;
    if (ageMs > config.limits.maxEventAgeMs) {
      logger.debug('router: stale, viewers only', msg.eventId, `${ageMs}ms`);
      return;
    }

    if (msg.fromSelf) {
      logger.debug('router: ignoring own message', msg.eventId);
      return;
    }
    if (identity === null && msg.botId !== undefined) {
      logger.debug('router: ignoring bot message (bot ids unknown)', msg.eventId);
      return;
    }

    const site = config.channelOwner.get(msg.channel);
    if (site !== undefined) delivery.toSite(site, msg);
  }

  const ingest: SlackEventSink = (e) => {
    const channel = e.event.channel;
    if (typeof channel !== 'string' || !channels.has(channel)) {
      logger.debug('router: ignoring event in unconfigured channel', channel);
      return;
    }
    const msg = normalize(e, identity);
    if (msg === null) {
      logger.debug('router: ignoring event', e.event.type, e.event.subtype ?? '');
      return;
    }
    route(msg);
  };

  return {
    setBotIdentity(id) {
      identity = id;
    },
    ingest,
    route,
  };
}
