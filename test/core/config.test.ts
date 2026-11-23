import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_LIMITS,
  validateConfig,
  type RelayConfig,
} from '../../src/core/config.js';
import { hashKey } from '../../src/core/keys.js';

const NORTH_HASH = hashKey('prk_north');
const SOUTH_HASH = hashKey('prk_south');
const PORTAL_HASH = hashKey('prk_portal');

function validConfig(): RelayConfig {
  return {
    slack: {
      botToken: 'xoxb-test',
      ingress: { mode: 'events-api', signingSecret: 'secret' },
    },
    sites: [
      { name: 'north', channels: ['C0NORTH1', 'G0NORTH2'], keyHashes: [NORTH_HASH] },
      { name: 'south', channels: ['C0SOUTH1'], keyHashes: [SOUTH_HASH] },
    ],
    viewers: [{ name: 'portal', channels: ['C0NORTH1'], keyHashes: [PORTAL_HASH], canPost: true }],
  };
}

/** Runs validateConfig and returns the ConfigError it throws. */
function problemsOf(config: RelayConfig): ConfigError {
  try {
    validateConfig(config);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected validateConfig to throw');
}

describe('DEFAULT_LIMITS', () => {
  it('holds the Decision 2 values', () => {
    expect(DEFAULT_LIMITS).toEqual({
      resumeWindowMs: 120_000,
      resumeMaxEvents: 200,
      maxEventAgeMs: 300_000,
      historySize: 50,
      handshakeTimeoutMs: 10_000,
      idleTimeoutMs: 90_000,
      maxFrameBytes: 65_536,
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });
});

describe('validateConfig: valid configs', () => {
  it('returns a ResolvedConfig with default limits and a channelOwner map', () => {
    const resolved = validateConfig(validConfig());
    expect(resolved.limits).toEqual(DEFAULT_LIMITS);
    expect(resolved.limits).not.toBe(DEFAULT_LIMITS);
    expect(resolved.channelOwner).toEqual(
      new Map([
        ['C0NORTH1', 'north'],
        ['G0NORTH2', 'north'],
        ['C0SOUTH1', 'south'],
      ]),
    );
    expect(resolved.slack).toEqual(validConfig().slack);
    expect(resolved.sites).toEqual(validConfig().sites);
    expect(resolved.viewers).toEqual(validConfig().viewers);
  });

  it('defaults viewers to [] when omitted', () => {
    const config = validConfig();
    delete config.viewers;
    expect(validateConfig(config).viewers).toEqual([]);
  });

  it('overrides only the limits given', () => {
    const config = { ...validConfig(), limits: { historySize: 20 } };
    expect(validateConfig(config).limits).toEqual({ ...DEFAULT_LIMITS, historySize: 20 });
  });

  it("expands channels '*' to every site channel, sorted", () => {
    const config = validConfig();
    config.viewers = [{ name: 'portal', channels: '*', keyHashes: [], canPost: false }];
    expect(validateConfig(config).viewers[0]!.channels).toEqual(['C0NORTH1', 'C0SOUTH1', 'G0NORTH2']);
  });

  it('allows a site and a viewer with the same name', () => {
    const config = validConfig();
    config.viewers![0]!.name = 'north';
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('allows one entry to list the same hash twice', () => {
    const config = validConfig();
    config.sites[0]!.keyHashes = [NORTH_HASH, NORTH_HASH];
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('accepts socket-mode ingress', () => {
    const config = validConfig();
    config.slack.ingress = { mode: 'socket-mode', appToken: 'xapp-test' };
    expect(validateConfig(config).slack.ingress).toEqual({ mode: 'socket-mode', appToken: 'xapp-test' });
  });

  it('does not mutate its input', () => {
    const config = { ...validConfig(), limits: { historySize: 20 } };
    config.viewers = [{ name: 'portal', channels: '*', keyHashes: [PORTAL_HASH], canPost: false }];
    const copy = structuredClone(config);
    const resolved = validateConfig(config);
    expect(config).toEqual(copy);
    // Resolved arrays are not the caller's arrays.
    expect(resolved.sites).not.toBe(config.sites);
    expect(resolved.sites[0]!.channels).not.toBe(config.sites[0]!.channels);
  });
});

describe('validateConfig: one rule at a time', () => {
  it('rejects a duplicate site name, reported once', () => {
    const config = validConfig();
    config.sites.push({ name: 'north', channels: ['C0OTHER1'], keyHashes: [] });
    config.sites.push({ name: 'north', channels: ['C0OTHER2'], keyHashes: [] });
    const err = problemsOf(config);
    expect(err.problems).toEqual(['site name "north" is used more than once']);
  });

  it('rejects a duplicate viewer name', () => {
    const config = validConfig();
    config.viewers!.push({ name: 'portal', channels: [], keyHashes: [], canPost: false });
    const err = problemsOf(config);
    expect(err.problems).toEqual(['viewer name "portal" is used more than once']);
  });

  it.each(['c0123', 'D0123ABC', 'C01-23', 'C', ''])('rejects the bad channel id %j', (bad) => {
    const config = validConfig();
    config.sites[1]!.channels = [bad];
    config.viewers![0]!.channels = [bad];
    const err = problemsOf(config);
    expect(err.problems).toEqual([
      `site "south" has an invalid channel id ${JSON.stringify(bad)}`,
      `viewer "portal" has an invalid channel id ${JSON.stringify(bad)}`,
    ]);
  });

  it('rejects a site with no channels', () => {
    const config = validConfig();
    config.sites[1]!.channels = [];
    const err = problemsOf(config);
    expect(err.problems).toEqual(['site "south" has no channels']);
  });

  it('rejects a channel listed by two sites', () => {
    const config = validConfig();
    config.sites[1]!.channels.push('C0NORTH1');
    const err = problemsOf(config);
    expect(err.problems).toEqual(['channel C0NORTH1 is listed by sites "north" and "south"']);
  });

  it('names every site that lists a shared channel', () => {
    const config = validConfig();
    config.sites[1]!.channels.push('C0NORTH1');
    config.sites.push({ name: 'east', channels: ['C0NORTH1'], keyHashes: [] });
    const err = problemsOf(config);
    expect(err.problems).toEqual(['channel C0NORTH1 is listed by sites "north", "south" and "east"']);
  });

  it.each([
    'sha256:abc',
    `md5:${'a'.repeat(64)}`,
    `sha256:${'A'.repeat(64)}`,
  ])('rejects the malformed hash %j', (bad) => {
    const config = validConfig();
    config.sites[0]!.keyHashes.push(bad);
    config.viewers![0]!.keyHashes = [bad];
    const err = problemsOf(config);
    expect(err.problems).toEqual([
      `site "north" has a malformed key hash ${JSON.stringify(bad)} (expected "sha256:" + 64 lowercase hex)`,
      `viewer "portal" has a malformed key hash ${JSON.stringify(bad)} (expected "sha256:" + 64 lowercase hex)`,
    ]);
  });

  it('rejects a hash shared by a site and a viewer', () => {
    const config = validConfig();
    config.viewers![0]!.keyHashes = [NORTH_HASH];
    const err = problemsOf(config);
    expect(err.problems).toEqual([`key hash ${NORTH_HASH} is used by site "north" and viewer "portal"`]);
  });

  it('rejects a hash shared by two sites', () => {
    const config = validConfig();
    config.sites[1]!.keyHashes.push(NORTH_HASH);
    const err = problemsOf(config);
    expect(err.problems).toEqual([`key hash ${NORTH_HASH} is used by site "north" and site "south"`]);
  });
});

describe('validateConfig: every problem is listed', () => {
  it('throws one ConfigError listing four broken rules', () => {
    const config = validConfig();
    config.sites[1]!.name = 'north'; // duplicate site name
    config.viewers![0]!.channels = ['bad']; // bad channel id
    config.viewers![0]!.keyHashes = ['sha256:abc']; // malformed hash
    config.sites.push({ name: 'west', channels: [], keyHashes: [] }); // no channels
    const err = problemsOf(config);
    expect(err.problems).toHaveLength(4);
    expect(err.message.startsWith('Invalid relay config:\n')).toBe(true);
    for (const problem of err.problems) expect(err.message).toContain(`\n- ${problem}`);
    expect(err.name).toBe('ConfigError');
    expect(err).toBeInstanceOf(Error);
  });
});
