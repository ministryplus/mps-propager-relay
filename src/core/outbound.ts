/**
 * The only path from a client's `reply`, `react`, or `post` to Slack (Spec 001 Decisions 7 and 8).
 * Checks the caller may make the request, serializes requests per thread, and maps every outcome
 * to exactly one `ResultFrame`. 429 retries live in `SlackApi`; this only maps their outcome.
 */
import type { PostFrame, ReactFrame, RelayMessage, ReplyFrame, ResultFrame, ResultError } from '../protocol/types.js';
import type { ResolvedConfig } from './config.js';
import type { Logger } from './logger.js';
import type { Principal } from './session.js';
import { SlackApiError, type SlackApi } from './slack-api.js';

type OutboundFrame = ReplyFrame | ReactFrame | PostFrame;

export function createOutbound(o: {
  slackApi: SlackApi;
  config: ResolvedConfig;
  logger: Logger;
  onRelayPost(msg: RelayMessage): void;
}): { request(p: Principal, f: ReplyFrame | ReactFrame | PostFrame): Promise<ResultFrame> } {
  const { slackApi, logger } = o;
  /** Each key's last queued job; removed once that job settles and nothing follows it. */
  const tails = new Map<string, Promise<void>>();

  function enqueue(key: string, job: () => Promise<ResultFrame>): Promise<ResultFrame> {
    const prev = tails.get(key) ?? Promise.resolve();
    const result = prev.then(job);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  }

  async function send(p: Principal, f: OutboundFrame): Promise<ResultFrame> {
    try {
      if (f.type === 'react') {
        await slackApi.addReaction({ channel: f.channel, ts: f.ts, emoji: f.emoji });
        return { type: 'result', id: f.id, ok: true };
      }
      const { ts } = await slackApi.postMessage({
        channel: f.channel,
        text: f.text,
        ...(f.threadTs !== undefined ? { threadTs: f.threadTs } : {}),
      });
      if (f.type === 'post') relayPost(f, ts);
      return { type: 'result', id: f.id, ok: true, ts };
    } catch (err) {
      const error = errorCode(err);
      if (error === 'slack:unknown') {
        logger.error(`outbound ${f.type} in ${f.channel} from ${p.name} failed unexpectedly`, stackOf(err));
      }
      logger.warn(`outbound ${f.type} in ${f.channel} from ${p.name} failed: ${error}`);
      return { type: 'result', id: f.id, ok: false, error };
    }
  }

  function relayPost(f: PostFrame, ts: string): void {
    const msg: RelayMessage = {
      eventId: `relay:${ts}`,
      channel: f.channel,
      ts,
      text: f.text,
      kind: f.threadTs ? 'thread' : 'channel',
      ...(f.threadTs ? { threadTs: f.threadTs } : {}),
      fromSelf: false,
      origin: 'relay',
    };
    try {
      o.onRelayPost(msg);
    } catch (err) {
      logger.error(`onRelayPost failed for ${msg.eventId}`, stackOf(err));
    }
  }

  return {
    request(p, f) {
      if (!allowed(p, f)) {
        logger.debug(`outbound ${f.type} in ${f.channel} from ${p.role} ${p.name}: not_allowed`);
        return Promise.resolve(fail(f, 'not_allowed'));
      }
      if (!valid(f)) return Promise.resolve(fail(f, 'invalid'));
      return enqueue(queueKey(f), () => send(p, f));
    },
  };
}

/** Decision 7's permission table. */
function allowed(p: Principal, f: OutboundFrame): boolean {
  const roleOk = f.type === 'post' ? p.role === 'viewer' && p.canPost : p.role === 'site';
  return roleOk && p.channels.includes(f.channel);
}

/** A frame that parsed but can't be sent. */
function valid(f: OutboundFrame): boolean {
  return f.type === 'react' ? f.ts !== '' && f.emoji !== '' : f.text !== '';
}

/** One request in flight per thread (Decision 7); a reaction shares its message's thread queue. */
function queueKey(f: OutboundFrame): string {
  switch (f.type) {
    case 'reply':
      return `${f.channel}:${f.threadTs}`;
    case 'react':
      return `${f.channel}:${f.ts}`;
    case 'post':
      return f.threadTs !== undefined ? `${f.channel}:${f.threadTs}` : f.channel;
  }
}

function errorCode(err: unknown): ResultError {
  if (!(err instanceof SlackApiError)) return 'slack:unknown';
  return err.code === 'rate_limited' ? 'rate_limited' : `slack:${err.code}`;
}

function fail(f: OutboundFrame, error: ResultError): ResultFrame {
  return { type: 'result', id: f.id, ok: false, error };
}

function stackOf(err: unknown): unknown {
  return err instanceof Error ? err.stack : err;
}
