/**
 * The relay's only path to Slack's Web API (spec 001, Decisions 1, 6, 7, 11).
 * Slack's own types stay internal (Decision 1): exported types are the relay's own.
 */

/** `auth.test`'s result: who the relay posts as (Decision 6's echo filter). */
export interface BotIdentity {
  userId: string;
  botId: string;
}

/** The relay's own shape for a `conversations.history` message, with Slack's field names. */
export type SlackHistoryMessage = {
  type?: string;
  subtype?: string;
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
};

export interface SlackApi {
  authTest(): Promise<BotIdentity>;
  postMessage(a: { channel: string; text: string; threadTs?: string }): Promise<{ ts: string }>;
  /** `already_reacted` resolves. */
  addReaction(a: { channel: string; ts: string; emoji: string }): Promise<void>;
  /** Newest first, as Slack returns them. */
  history(a: { channel: string; limit: number }): Promise<SlackHistoryMessage[]>;
  /** `apps.connections.open` with the app token; returns the WebSocket URL. */
  openSocketModeUrl(appToken: string): Promise<string>;
}

/** `code` is Slack's `error` field, `'rate_limited'` (retries exhausted), or `'network'`. */
export class SlackApiError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SlackApiError';
  }
}

export interface SlackApiOptions {
  botToken: string;
  baseUrl?: string;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  timeoutMs?: number;
}

const MAX_RETRIES = 3;
const DEFAULT_RETRY_AFTER_S = 1;

// Internal response shape. Web API response types live in Slack's web-api package, which isn't used.
interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

type Encoding = 'json' | 'form';

export function createSlackApi(options: SlackApiOptions): SlackApi {
  const baseUrl = options.baseUrl ?? 'https://slack.com/api/';
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pausedUntil = new Map<string, number>();

  async function waitOutPause(method: string): Promise<void> {
    for (let until = pausedUntil.get(method) ?? 0; now() < until; until = pausedUntil.get(method) ?? 0) {
      await sleep(until - now());
    }
  }

  async function call(
    method: string,
    params: Record<string, unknown>,
    { token = options.botToken, encoding }: { token?: string; encoding: Encoding },
  ): Promise<SlackResponse> {
    const body =
      encoding === 'json'
        ? JSON.stringify(params)
        : new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString();
    const contentType =
      encoding === 'json' ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded';

    for (let attempt = 0; ; attempt++) {
      await waitOutPause(method);
      let res: Response;
      let text: string;
      try {
        res = await fetch(`${baseUrl}${method}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (cause) {
        throw new SlackApiError('network', `${method}: ${describe(cause)}`);
      }

      if (res.status === 429) {
        if (attempt >= MAX_RETRIES) throw new SlackApiError('rate_limited', `${method}: rate limited`);
        const seconds = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
        const pause = (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_S) * 1000;
        pausedUntil.set(method, Math.max(pausedUntil.get(method) ?? 0, now() + pause));
        continue;
      }
      if (!res.ok) throw new SlackApiError('network', `${method}: HTTP ${res.status}`);

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new SlackApiError('network', `${method}: response is not JSON`);
      }
      if (typeof json !== 'object' || json === null) {
        throw new SlackApiError('network', `${method}: response is not a JSON object`);
      }
      const data = json as SlackResponse;
      if (data.ok !== true) {
        const code = typeof data.error === 'string' ? data.error : 'unknown_error';
        throw new SlackApiError(code, `${method}: ${code}`);
      }
      return data;
    }
  }

  return {
    async authTest() {
      const r = await call('auth.test', {}, { encoding: 'form' });
      if (typeof r.user_id !== 'string' || typeof r.bot_id !== 'string') {
        throw new SlackApiError('network', 'auth.test: response missing user_id or bot_id');
      }
      return { userId: r.user_id, botId: r.bot_id };
    },

    async postMessage({ channel, text, threadTs }) {
      const params: Record<string, unknown> = { channel, text, unfurl_links: false };
      if (threadTs !== undefined) params.thread_ts = threadTs;
      const r = await call('chat.postMessage', params, { encoding: 'json' });
      if (typeof r.ts !== 'string') throw new SlackApiError('network', 'chat.postMessage: response missing ts');
      return { ts: r.ts };
    },

    async addReaction({ channel, ts, emoji }) {
      try {
        await call('reactions.add', { channel, timestamp: ts, name: emoji }, { encoding: 'json' });
      } catch (e) {
        if (e instanceof SlackApiError && e.code === 'already_reacted') return;
        throw e;
      }
    },

    async history({ channel, limit }) {
      const r = await call('conversations.history', { channel, limit }, { encoding: 'form' });
      const messages = Array.isArray(r.messages) ? r.messages : [];
      return messages.filter(isRecord).map(toHistoryMessage);
    },

    async openSocketModeUrl(appToken) {
      const r = await call('apps.connections.open', {}, { token: appToken, encoding: 'form' });
      if (typeof r.url !== 'string') throw new SlackApiError('network', 'apps.connections.open: response missing url');
      return r.url;
    },
  };
}

const HISTORY_FIELDS = ['type', 'subtype', 'text', 'user', 'bot_id', 'thread_ts'] as const;

function toHistoryMessage(m: Record<string, unknown>): SlackHistoryMessage {
  const out: SlackHistoryMessage = { ts: String(m.ts ?? '') };
  for (const k of HISTORY_FIELDS) {
    if (typeof m[k] === 'string') out[k] = m[k];
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = cause.cause instanceof Error ? ` (${cause.cause.message})` : '';
    return `${cause.name}: ${cause.message}${inner}`;
  }
  return String(cause);
}
