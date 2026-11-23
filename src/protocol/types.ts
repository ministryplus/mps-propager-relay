// Protocol 1 (Spec 001 Decisions 5, 7, 9). protocol/README.md is the reference;
// protocol/schema/frame.schema.json is the same contract as JSON Schema.

export const PROTOCOL_VERSION = 1;

/** Close codes (Spec 001 Decision 9). */
export const CLOSE = {
  GOING_AWAY: 1001,
  BAD_FRAME: 4000,
  UNAUTHORIZED: 4001,
  UNSUPPORTED_PROTOCOL: 4002,
  REPLACED: 4003,
  HANDSHAKE_TIMEOUT: 4004,
  IDLE: 4005,
} as const;

/** A Slack message as the relay delivers it (Spec 001 Decision 5). */
export interface RelayMessage {
  /** Slack event_id; "relay:<ts>" for relay-originated posts (Decision 8). */
  eventId: string;
  channel: string;
  ts: string;
  text: string;
  kind: 'channel' | 'thread';
  /** Set when kind === 'thread'. */
  threadTs?: string;
  user?: string;
  botId?: string;
  /** Posted by the relay's own bot (Decision 6). */
  fromSelf: boolean;
  origin: 'slack' | 'relay';
}

/** `result.error` values (Decision 7). */
export type ResultError = 'not_allowed' | 'invalid' | 'rate_limited' | `slack:${string}`;

// Client → relay

export interface HelloFrame {
  type: 'hello';
  /** Any integer ≥ 1 parses; the session answers 4002 unless it is PROTOCOL_VERSION. */
  protocol: number;
  role: 'site' | 'viewer';
  key: string;
  client: { name: string; version: string };
  resume?: { epoch: string; seq: number };
}

export interface ReplyFrame {
  type: 'reply';
  id: string;
  channel: string;
  threadTs: string;
  text: string;
}

export interface ReactFrame {
  type: 'react';
  id: string;
  channel: string;
  ts: string;
  emoji: string;
}

export interface PostFrame {
  type: 'post';
  id: string;
  channel: string;
  text: string;
  threadTs?: string;
}

export interface HistoryFrame {
  type: 'history';
  id: string;
  channel: string;
  limit?: number;
}

export interface PingFrame {
  type: 'ping';
}

// Relay → client

export interface WelcomeFrame {
  type: 'welcome';
  protocol: 1;
  role: 'site' | 'viewer';
  name: string;
  channels: string[];
  epoch: string;
  resumed: boolean;
  relay: { version: string };
}

export type MessageFrame = RelayMessage & { type: 'message'; seq: number };

export interface ResultFrame {
  type: 'result';
  id: string;
  ok: boolean;
  ts?: string;
  error?: ResultError;
}

export interface HistoryResultFrame {
  type: 'history_result';
  id: string;
  channel: string;
  /** Oldest first. */
  messages: RelayMessage[];
}

export interface StatusFrame {
  type: 'status';
  slack: 'connected' | 'disconnected';
  slackSharedApp: boolean;
}

export interface PongFrame {
  type: 'pong';
}

export interface ErrorFrame {
  type: 'error';
  /** The close code that follows, e.g. 4002. */
  code: number;
  message: string;
}

export type ClientFrame = HelloFrame | ReplyFrame | ReactFrame | PostFrame | HistoryFrame | PingFrame;
export type ServerFrame =
  | WelcomeFrame
  | MessageFrame
  | ResultFrame
  | HistoryResultFrame
  | StatusFrame
  | PongFrame
  | ErrorFrame;
