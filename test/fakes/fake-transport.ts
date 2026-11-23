/** The bare transport the session hub writes to (Spec 001 task 6). */
export interface Transport {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface FakeTransport {
  transport: Transport;
  /** Every frame sent, parsed from JSON, in order. */
  sent: unknown[];
  /** The first `close` call, or null while open. */
  closedWith: { code: number; reason: string } | null;
}

/** In-memory transport for session tests: records sent frames and the close. No network. */
export function createFakeTransport(): FakeTransport {
  const fake: FakeTransport = {
    sent: [],
    closedWith: null,
    transport: {
      send(text) {
        fake.sent.push(JSON.parse(text));
      },
      close(code, reason) {
        fake.closedWith ??= { code, reason };
      },
    },
  };
  return fake;
}
