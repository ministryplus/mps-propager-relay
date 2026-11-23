import type { RelayMessage } from '../protocol/types.js';
import type { BotIdentity } from './slack-api.js';

/** Message subtypes that can still page (Spec 001 Decision 5); `undefined` is a plain message. */
const KEPT_SUBTYPES: ReadonlySet<string | undefined> = new Set([
  undefined,
  'thread_broadcast',
  'file_share',
  'bot_message',
]);

/**
 * Shapes a Slack `message` event into a `RelayMessage`, or returns `null` for
 * anything that should never reach a client. Ported from ProPager's
 * `SlackClient::extractMessageEvent` minus the channel check, which the router
 * does before calling this.
 */
export function normalize(
  e: { eventId: string; event: Record<string, unknown> },
  botIdentity: BotIdentity | null,
): RelayMessage | null {
  const ev = e.event;
  if (ev.type !== 'message') return null;
  const subtype = typeof ev.subtype === 'string' ? ev.subtype : ev.subtype === undefined ? undefined : null;
  if (subtype === null || !KEPT_SUBTYPES.has(subtype)) return null;

  const channel = nonEmpty(ev.channel);
  const ts = nonEmpty(ev.ts);
  if (channel === undefined || ts === undefined) return null;

  const user = nonEmpty(ev.user);
  const botId = nonEmpty(ev.bot_id);

  const msg: RelayMessage = {
    eventId: e.eventId,
    channel,
    ts,
    text: typeof ev.text === 'string' ? ev.text : '',
    kind: 'channel',
    fromSelf: isOwnMessage(botIdentity, user, botId),
    origin: 'slack',
  };

  // Thread rule (ported from SlackClient::onSocketFrame): a reply carries a
  // thread_ts different from its own ts. A thread_broadcast ("also send to
  // channel") routes as a thread reply on purpose (mps-propager Spec 003
  // Decision 6). A parent carrying thread_ts === ts stays a channel message.
  const threadTs = nonEmpty(ev.thread_ts);
  if (threadTs !== undefined && threadTs !== ts) {
    msg.kind = 'thread';
    msg.threadTs = threadTs;
  }
  if (user !== undefined) msg.user = user;
  if (botId !== undefined) msg.botId = botId;
  return msg;
}

/** Port of `SlackClient::isOwnMessage` (Decision 6); an empty id never matches. */
function isOwnMessage(id: BotIdentity | null, user: string | undefined, botId: string | undefined): boolean {
  if (id === null) return false;
  return (id.userId !== '' && id.userId === user) || (id.botId !== '' && id.botId === botId);
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
