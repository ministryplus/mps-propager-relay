// @ministryplus/propager-relay/h3: h3 v1 event handlers over the framework-free
// core (Spec 001 Decision 12). A host mounts them as routes; a Nitro host as
// route files (church-portal draft ADR Decision 1), with WebSockets enabled.

import {
  defineEventHandler,
  defineWebSocketHandler,
  getRequestHeaders,
  readRawBody,
  setResponseHeader,
  setResponseStatus,
  type EventHandler,
} from 'h3';
import type { Relay } from '../core/index.js';

export interface RelayHandlers {
  /** `POST` Slack Events API endpoint. Reads the raw body: the signature covers the raw bytes. */
  slackEvents: EventHandler;
  /** Site and viewer WebSocket (crossws hooks); a plain HTTP request gets 426. */
  socket: EventHandler;
  /** The `HealthReport` as JSON: 200 when Slack is connected, else 503. */
  health: EventHandler;
}

export function createRelayHandlers(relay: Relay): RelayHandlers {
  const slackEvents = defineEventHandler(async (event) => {
    const rawBody = (await readRawBody(event, 'utf8')) ?? '';
    const headers = getRequestHeaders(event); // Node lowercases header names
    const r = await relay.handleSlackEvent(rawBody, headers);
    setResponseStatus(event, r.status);
    for (const [name, value] of Object.entries(r.headers ?? {})) setResponseHeader(event, name, value);
    return r.body ?? '';
  });

  // One relay connection per crossws peer, keyed by the peer's id.
  const connections = new Map<string, ReturnType<Relay['openConnection']>>();
  const socket = defineWebSocketHandler({
    open(peer) {
      connections.set(
        peer.id,
        relay.openConnection({
          send: (text) => void peer.send(text),
          close: (code, reason) => peer.close(code, reason),
        }),
      );
    },
    message(peer, message) {
      connections.get(peer.id)?.receive(message.text());
    },
    close(peer) {
      connections.get(peer.id)?.closed();
      connections.delete(peer.id);
    },
    error() {
      // Nothing to do: the hub logs protocol errors, and the close hook that
      // follows a socket error does the cleanup.
    },
  });

  const health = defineEventHandler((event) => {
    const report = relay.health();
    setResponseStatus(event, report.slack === 'connected' ? 200 : 503);
    return report;
  });

  return { slackEvents, socket, health };
}
