import { beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/core/config.js';
import { hashKey } from '../../src/core/keys.js';
import type { Logger } from '../../src/core/logger.js';
import { createRouter, type Delivery } from '../../src/core/router.js';
import type { RelayMessage } from '../../src/protocol/types.js';

type Call = { to: 'site'; site: string; msg: RelayMessage } | { to: 'viewers'; msg: RelayMessage };

const config = validateConfig({
  slack: { botToken: 'xoxb-test', ingress: { mode: 'events-api', signingSecret: 's' } },
  sites: [
    { name: 'north', channels: ['C0NORTH'], keyHashes: [hashKey('prk_north')] },
    { name: 'south', channels: ['C0SOUTH'], keyHashes: [hashKey('prk_south')] },
  ],
  viewers: [
    { name: 'portal', channels: '*', keyHashes: [hashKey('prk_portal')], canPost: true },
    { name: 'wall', channels: ['C0VIEWONLY'], keyHashes: [hashKey('prk_wall')], canPost: false },
  ],
});

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let t: number;
let calls: Call[];
let seq: number;
let router: ReturnType<typeof createRouter>;

const delivery: Delivery = {
  toSite: (site, msg) => calls.push({ to: 'site', site, msg }),
  toViewers: (msg) => calls.push({ to: 'viewers', msg }),
};

/** A Slack message event whose ts is `ageMs` before now(). */
function slack(event: Record<string, unknown> = {}, o: { eventId?: string; ageMs?: number } = {}) {
  return {
    eventId: o.eventId ?? `Ev${++seq}`,
    event: {
      type: 'message',
      channel: 'C0NORTH',
      ts: ((t - (o.ageMs ?? 0)) / 1000).toFixed(6),
      text: 'hello',
      user: 'UHUMAN',
      ...event,
    },
  };
}

function summary() {
  return calls.map((c) => (c.to === 'site' ? `site:${c.site}` : 'viewers'));
}

beforeEach(() => {
  t = 1_800_000_000_000;
  calls = [];
  seq = 0;
  router = createRouter({ config, delivery, now: () => t, logger: silent });
});

describe('router: routing', () => {
  it('sends a fresh human message to its site and to viewers', () => {
    router.ingest(slack({ channel: 'C0NORTH' }));
    expect(summary().sort()).toEqual(['site:north', 'viewers']);
    router.ingest(slack({ channel: 'C0SOUTH' }));
    expect(summary().slice(2).sort()).toEqual(['site:south', 'viewers']);
  });

  it('delivers the normalized message', () => {
    router.ingest(slack({ text: 'page 42' }, { eventId: 'EvX' }));
    const site = calls.find((c) => c.to === 'site')!;
    expect(site.msg).toMatchObject({ eventId: 'EvX', channel: 'C0NORTH', text: 'page 42', origin: 'slack' });
  });

  it('drops a channel nobody is configured for', () => {
    router.ingest(slack({ channel: 'C0OTHER' }));
    expect(calls).toEqual([]);
  });

  it('sends a viewer-only channel to viewers only', () => {
    router.ingest(slack({ channel: 'C0VIEWONLY' }));
    expect(summary()).toEqual(['viewers']);
  });

  it('drops events that do not normalize', () => {
    router.ingest(slack({ subtype: 'message_changed' }));
    expect(calls).toEqual([]);
  });
});

describe('router: dedupe', () => {
  it('drops a repeated event_id', () => {
    router.ingest(slack({}, { eventId: 'Ev1' }));
    router.ingest(slack({}, { eventId: 'Ev1' }));
    expect(summary().sort()).toEqual(['site:north', 'viewers']);
  });

  it('accepts the id again after 10 minutes', () => {
    router.ingest(slack({}, { eventId: 'Ev1' }));
    t += 600_000;
    router.ingest(slack({}, { eventId: 'Ev1' }));
    expect(calls).toHaveLength(2);
    t += 1;
    router.ingest(slack({}, { eventId: 'Ev1' }));
    expect(calls).toHaveLength(4);
  });

  it('a duplicate does not refresh its entry', () => {
    router.ingest(slack({}, { eventId: 'Ev1' }));
    t += 300_000;
    router.ingest(slack({}, { eventId: 'Ev1' }));
    t += 300_001;
    router.ingest(slack({}, { eventId: 'Ev1' }));
    expect(calls).toHaveLength(4);
  });

  it('accepts the id again after 5,000 newer ids', () => {
    router.ingest(slack({}, { eventId: 'first' }));
    for (let i = 0; i < 5_000; i++) router.ingest(slack({}, { eventId: `n${i}` }));
    calls = [];
    router.ingest(slack({}, { eventId: 'first' }));
    expect(summary().sort()).toEqual(['site:north', 'viewers']);
  });

  it('remembers ids while under the bound', () => {
    router.ingest(slack({}, { eventId: 'first' }));
    for (let i = 0; i < 4_999; i++) router.ingest(slack({}, { eventId: `n${i}` }));
    calls = [];
    router.ingest(slack({}, { eventId: 'first' }));
    expect(calls).toEqual([]);
  });
});

describe('router: age', () => {
  it('sends a stale message to viewers only', () => {
    router.ingest(slack({}, { ageMs: 301_000 }));
    expect(summary()).toEqual(['viewers']);
  });

  it('a message exactly maxEventAgeMs old still reaches its site', () => {
    router.ingest(slack({}, { ageMs: config.limits.maxEventAgeMs }));
    expect(summary().sort()).toEqual(['site:north', 'viewers']);
  });
});

describe('router: echo filter', () => {
  it('own messages reach viewers with fromSelf but never a site', () => {
    router.setBotIdentity({ userId: 'UBOT', botId: 'BBOT' });
    router.ingest(slack({ user: 'UBOT' }));
    router.ingest(slack({ user: undefined, bot_id: 'BBOT', subtype: 'bot_message' }));
    expect(summary()).toEqual(['viewers', 'viewers']);
    expect(calls.every((c) => c.msg.fromSelf)).toBe(true);
  });

  it("another bot's message reaches its site once the identity is known", () => {
    router.setBotIdentity({ userId: 'UBOT', botId: 'BBOT' });
    router.ingest(slack({ user: undefined, bot_id: 'BOTHER', subtype: 'bot_message' }));
    expect(summary().sort()).toEqual(['site:north', 'viewers']);
  });

  it('before the identity is known, any bot message reaches viewers only', () => {
    router.ingest(slack({ user: undefined, bot_id: 'BOTHER', subtype: 'bot_message' }));
    expect(summary()).toEqual(['viewers']);
    calls = [];
    router.ingest(slack({ user: 'UHUMAN' }));
    expect(summary().sort()).toEqual(['site:north', 'viewers']);
  });
});

describe('router: relay-originated', () => {
  function relayMsg(ageMs = 0): RelayMessage {
    const ts = ((t - ageMs) / 1000).toFixed(6);
    return { eventId: `relay:${ts}`, channel: 'C0NORTH', ts, text: 'posted', kind: 'channel', fromSelf: false, origin: 'relay' };
  }

  it('goes to the owning site only', () => {
    router.route(relayMsg());
    expect(summary()).toEqual(['site:north']);
  });

  it('is deduped', () => {
    const m = relayMsg();
    router.route(m);
    router.route(m);
    expect(summary()).toEqual(['site:north']);
  });

  it('is subject to age', () => {
    router.route(relayMsg(400_000));
    expect(calls).toEqual([]);
  });
});
