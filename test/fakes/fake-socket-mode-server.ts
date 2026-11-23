import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

/** One client connection to the fake Socket Mode server, seen from Slack's side. */
export interface FakeConn {
  /** Envelope ids the client acked on this connection, in order. */
  readonly acks: string[];
  /** WebSocket pings received from the client on this connection. */
  readonly pings: number;
  /** Resolves when this connection closes (either side), with the close code. */
  readonly closed: Promise<{ code: number }>;
  readonly isOpen: boolean;
  sendHello(numConnections?: number): void;
  sendDisconnect(reason: string): void;
  /** Sends an `events_api` envelope; returns its generated `envelope_id`. */
  sendEvent(e: { eventId?: string; event?: Record<string, unknown> }): string;
  /** Sends `obj` as JSON, or a string as-is. */
  sendRaw(obj: unknown): void;
  waitForAck(envelopeId: string): Promise<void>;
  close(code?: number): void;
}

export interface FakeSocketModeServer {
  /** `ws://127.0.0.1:<port>/` */
  url(): string;
  /** Every connection so far, in arrival order. */
  readonly connections: FakeConn[];
  /** The next connection not yet returned by `nextConnection` (waits if none). */
  nextConnection(): Promise<FakeConn>;
  stop(): Promise<void>;
}

/**
 * A local stand-in for Slack's Socket Mode endpoint on an ephemeral port.
 * `autoHello` (default true) sends `hello` on connect with `num_connections`
 * set to `numConnections`, or to the server's open connection count.
 * `autoPong: false` leaves the client's pings unanswered (`ws` >= 8.14).
 */
export async function startFakeSocketModeServer(
  o: { autoHello?: boolean; autoPong?: boolean; numConnections?: number } = {},
): Promise<FakeSocketModeServer> {
  const autoHello = o.autoHello ?? true;
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: o.autoPong ?? true });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const port = (wss.address() as AddressInfo).port;

  const connections: FakeConn[] = [];
  let handedOut = 0;
  const waiters: ((c: FakeConn) => void)[] = [];
  let envelopeCounter = 0;

  const openCount = () => [...wss.clients].filter((c) => c.readyState === WebSocket.OPEN).length;

  wss.on('connection', (ws) => {
    const acks: string[] = [];
    const ackWaiters = new Map<string, (() => void)[]>();
    let pings = 0;
    const closed = new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code) => resolve({ code }));
    });
    ws.on('error', () => {});
    ws.on('ping', () => {
      pings++;
    });
    ws.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg === 'object' && msg !== null && 'envelope_id' in msg) {
        const id = String((msg as { envelope_id: unknown }).envelope_id);
        acks.push(id);
        for (const w of ackWaiters.get(id) ?? []) w();
        ackWaiters.delete(id);
      }
    });

    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };

    const conn: FakeConn = {
      acks,
      get pings() {
        return pings;
      },
      get isOpen() {
        return ws.readyState === WebSocket.OPEN;
      },
      closed,
      sendHello(numConnections) {
        send({
          type: 'hello',
          num_connections: numConnections ?? o.numConnections ?? openCount(),
          debug_info: { host: 'fake', approximate_connection_time: 18060 },
          connection_info: { app_id: 'A_FAKE' },
        });
      },
      sendDisconnect(reason) {
        send({ type: 'disconnect', reason, debug_info: { host: 'fake' } });
      },
      sendEvent(e) {
        const envelopeId = `env-${++envelopeCounter}`;
        const payload: Record<string, unknown> = { type: 'event_callback' };
        if (e.eventId !== undefined) payload.event_id = e.eventId;
        if (e.event !== undefined) payload.event = e.event;
        send({ type: 'events_api', envelope_id: envelopeId, payload, accepts_response_payload: false });
        return envelopeId;
      },
      sendRaw: send,
      waitForAck(envelopeId) {
        if (acks.includes(envelopeId)) return Promise.resolve();
        return new Promise<void>((resolve) => {
          ackWaiters.set(envelopeId, [...(ackWaiters.get(envelopeId) ?? []), resolve]);
        });
      },
      close(code = 1000) {
        ws.close(code);
      },
    };
    connections.push(conn);
    if (autoHello) conn.sendHello();
    const waiter = waiters.shift();
    if (waiter) {
      handedOut++;
      waiter(conn);
    }
  });

  return {
    url: () => `ws://127.0.0.1:${port}/`,
    connections,
    nextConnection() {
      if (handedOut < connections.length) return Promise.resolve(connections[handedOut++]!);
      return new Promise((resolve) => waiters.push(resolve));
    },
    async stop() {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
