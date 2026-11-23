import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from '../logger.js';

/**
 * Receives one Slack event (the inner `event` of an `event_callback`, or of a
 * Socket Mode `events_api` envelope) with its `event_id`. Shared by both
 * ingress modes; the router (001-5) dedupes on `eventId`.
 */
export type SlackEventSink = (e: { eventId: string; event: Record<string, unknown> }) => void;

export interface EventsApiResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Slack rejects requests whose timestamp is more than this far from now. */
const MAX_SKEW_S = 300;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The Events API half of Slack ingress (Spec 001 Decision 4), with no HTTP
 * library: verifies Slack's request signature, answers `url_verification`,
 * and acknowledges `event_callback` with 200 before handing the event to
 * `sink` on a later turn of the event loop. Keeps no state between calls.
 */
export function createEventsApiIngress(o: {
  signingSecret: string;
  sink: SlackEventSink;
  now(): number;
  logger: Logger;
}): {
  handle(rawBody: string, headers: Record<string, string | undefined>): Promise<EventsApiResponse>;
} {
  const { signingSecret, sink, now, logger } = o;

  /** Returns a failure reason, or undefined when the request is authentic. */
  function verify(rawBody: string, signature: string | undefined, tsHeader: string | undefined) {
    if (!signature || !tsHeader) return 'missing signature headers';
    if (!/^\d+$/.test(tsHeader)) return 'bad timestamp';
    if (Math.abs(now() / 1000 - Number(tsHeader)) > MAX_SKEW_S) return 'stale timestamp';
    const expected = Buffer.from(
      'v0=' + createHmac('sha256', signingSecret).update(`v0:${tsHeader}:${rawBody}`).digest('hex'),
      'utf8',
    );
    const actual = Buffer.from(signature, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return 'bad signature';
    }
    return undefined;
  }

  function dispatch(rawBody: string): EventsApiResponse {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      logger.warn('events-api: verified body is not JSON; ignoring');
      return { status: 200 };
    }
    if (!isObject(payload)) {
      logger.warn('events-api: verified body is not a JSON object; ignoring');
      return { status: 200 };
    }

    if (payload.type === 'url_verification') {
      const { challenge } = payload;
      if (typeof challenge !== 'string') logger.warn('events-api: url_verification without a string challenge');
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: typeof challenge === 'string' ? challenge : '',
      };
    }

    if (payload.type === 'event_callback') {
      const { event_id: eventId, event } = payload;
      if (typeof eventId !== 'string' || eventId === '' || !isObject(event)) {
        logger.warn('events-api: malformed event_callback; ignoring', {
          eventId: typeof eventId === 'string' ? eventId : undefined,
        });
        return { status: 200 };
      }
      // setImmediate, not a microtask: the caller's await resumes (and the 200
      // goes out) before the sink runs, so routing never delays the ack.
      setImmediate(() => {
        try {
          sink({ eventId, event });
        } catch (err) {
          logger.error('events-api: sink threw', { eventId, err });
        }
      });
      return { status: 200 };
    }

    logger.debug('events-api: ignoring payload type', String(payload.type));
    return { status: 200 };
  }

  return {
    async handle(rawBody, headers) {
      const lower: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
      const tsHeader = lower['x-slack-request-timestamp'];

      const failure = verify(rawBody, lower['x-slack-signature'], tsHeader);
      if (failure) {
        logger.warn(`events-api: rejected request: ${failure}`, { timestamp: tsHeader });
        return { status: 401 };
      }
      return dispatch(rawBody);
    },
  };
}
