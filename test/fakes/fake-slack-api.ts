import type { BotIdentity, SlackApi, SlackHistoryMessage } from '../../src/core/slack-api.js';

type Method = keyof SlackApi;
type Args<M extends Method> = Parameters<SlackApi[M]>[0];
type Result<M extends Method> = Awaited<ReturnType<SlackApi[M]>>;

/** A scripted answer: a value, an Error (rejected), or a function (e.g. to hold the call open). */
export type FakeResponse<M extends Method> = Result<M> | Error | ((args: Args<M>) => Promise<Result<M>>);

export interface FakeCall {
  method: Method;
  args: unknown;
}

/** In-memory `SlackApi` for tests: records calls, answers with defaults or scripted responses. No timers, no network. */
export class FakeSlackApi implements SlackApi {
  readonly calls: FakeCall[] = [];
  private readonly queues = new Map<Method, unknown[]>();
  private readonly histories = new Map<string, SlackHistoryMessage[]>();
  private tsCounter = 0;

  /** Queue one-shot responses for `method`, used in order before falling back to the default. */
  script<M extends Method>(method: M, ...responses: FakeResponse<M>[]): this {
    this.queues.set(method, [...(this.queues.get(method) ?? []), ...responses]);
    return this;
  }

  /** Messages `history()` returns for `channel` (newest first, as Slack sends them). */
  setHistory(channel: string, messages: SlackHistoryMessage[]): this {
    this.histories.set(channel, messages);
    return this;
  }

  callsTo(method: Method): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  authTest(): Promise<BotIdentity> {
    return this.answer('authTest', undefined, async () => ({ userId: 'U_BOT', botId: 'B_BOT' }));
  }

  postMessage(a: Args<'postMessage'>): Promise<{ ts: string }> {
    return this.answer('postMessage', a, async () => ({
      ts: `1700000000.${String(++this.tsCounter).padStart(6, '0')}`,
    }));
  }

  addReaction(a: Args<'addReaction'>): Promise<void> {
    return this.answer('addReaction', a, async () => undefined);
  }

  history(a: Args<'history'>): Promise<SlackHistoryMessage[]> {
    return this.answer('history', a, async () => (this.histories.get(a.channel) ?? []).slice(0, a.limit));
  }

  openSocketModeUrl(appToken: string): Promise<string> {
    return this.answer('openSocketModeUrl', appToken, async () => 'ws://127.0.0.1:0/fake');
  }

  private async answer<M extends Method>(
    method: M,
    args: Args<M>,
    fallback: () => Promise<Result<M>>,
  ): Promise<Result<M>> {
    this.calls.push({ method, args });
    const queue = this.queues.get(method);
    if (!queue || queue.length === 0) return fallback();
    const next = queue.shift() as FakeResponse<M>;
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return (next as (a: Args<M>) => Promise<Result<M>>)(args);
    return next;
  }
}
