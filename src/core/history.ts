// The per-channel history ring and its startup backfill (Spec 001 Decision 11).

import type { RelayMessage } from '../protocol/types.js';
import type { ResolvedConfig } from './config.js';
import { nextBackoffMs } from './ingress/socket-mode.js';
import type { Logger } from './logger.js';
import { SlackApiError, type SlackApi, type SlackHistoryMessage } from './slack-api.js';

export interface History {
  /** Records a routed message; one entry per `channel` + `ts` (see `insert`). */
  add(msg: RelayMessage): void;
  /** A copy of the last `min(limit ?? historySize, historySize)` messages, oldest first; `[]` for an unknown channel. */
  get(channel: string, limit?: number): RelayMessage[];
  /** One attempt per channel; a failed channel retries in the background. Never rejects. */
  backfill(): Promise<void>;
  /** Cancels every pending backfill retry. */
  stop(): void;
}

const DEFAULT_TIMING = { backoffBaseMs: 1_000, backoffMaxMs: 60_000 };

export function createHistory(o: {
  config: ResolvedConfig;
  slackApi: SlackApi;
  logger: Logger;
  toMessage(channel: string, m: SlackHistoryMessage): RelayMessage | null;
  timing?: { backoffBaseMs: number; backoffMaxMs: number };
}): History {
  const { config, slackApi, logger } = o;
  const size = config.limits.historySize;
  const timing = o.timing ?? DEFAULT_TIMING;

  // Every channel a message can be routed in: site channels plus viewer-only ones.
  const rings = new Map<string, RelayMessage[]>();
  for (const c of config.channelOwner.keys()) rings.set(c, []);
  for (const v of config.viewers) for (const c of v.channels) if (!rings.has(c)) rings.set(c, []);

  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  /**
   * Adds `msg` in `ts` order. An entry with the same `ts` is replaced only when
   * `replace` says so; past capacity the oldest entry is dropped.
   */
  function insert(msg: RelayMessage, replace: (existing: RelayMessage) => boolean): void {
    const ring = rings.get(msg.channel);
    if (!ring) return;
    const at = ring.findIndex((m) => m.ts === msg.ts);
    if (at !== -1) {
      if (replace(ring[at]!)) ring[at] = msg;
      return;
    }
    let i = ring.length;
    while (i > 0 && compareTs(ring[i - 1]!.ts, msg.ts) > 0) i--;
    ring.splice(i, 0, msg);
    if (ring.length > size) ring.splice(0, ring.length - size);
  }

  async function attempt(channel: string, backoffMs: number): Promise<void> {
    retryTimers.delete(channel);
    try {
      const messages = await slackApi.history({ channel, limit: size });
      if (stopped) return;
      for (const m of messages) {
        const msg = o.toMessage(channel, m);
        // Backfill never overwrites: a live message with the same ts arrived first and wins.
        if (msg) insert(msg, () => false);
      }
      logger.debug(`history: backfilled ${channel} (${messages.length} messages)`);
    } catch (err) {
      if (stopped) return;
      const next = nextBackoffMs(backoffMs, timing.backoffBaseMs, timing.backoffMaxMs);
      logger.warn(`history: backfill of ${channel} failed: ${errorCode(err)}; retrying in ${next} ms`);
      retryTimers.set(
        channel,
        setTimeout(() => void attempt(channel, next), next),
      );
    }
  }

  return {
    add(msg) {
      // A Slack message (e.g. the echo of a relay post) replaces the entry with
      // its ts; a relay-built post never overwrites an echo that beat it here.
      insert(msg, () => msg.origin === 'slack');
    },

    get(channel, limit) {
      const ring = rings.get(channel);
      if (!ring) return [];
      const n = Math.min(limit ?? size, size);
      return n > 0 ? ring.slice(-n) : [];
    },

    async backfill() {
      if (stopped) return;
      await Promise.all([...rings.keys()].map((c) => attempt(c, 0)));
    },

    stop() {
      stopped = true;
      for (const t of retryTimers.values()) clearTimeout(t);
      retryTimers.clear();
    },
  };
}

/**
 * Orders Slack `ts` strings ("<seconds>.<micros>") without going through a
 * float, which can't hold all 16 digits exactly.
 */
export function compareTs(a: string, b: string): number {
  const [ai = '', af = ''] = a.split('.');
  const [bi = '', bf = ''] = b.split('.');
  if (ai.length !== bi.length) return ai.length - bi.length;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const w = Math.max(af.length, bf.length);
  const ap = af.padEnd(w, '0');
  const bp = bf.padEnd(w, '0');
  return ap === bp ? 0 : ap < bp ? -1 : 1;
}

function errorCode(err: unknown): string {
  if (err instanceof SlackApiError) return err.code;
  return err instanceof Error ? err.message : String(err);
}
