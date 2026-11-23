import { KEY_HASH_PATTERN } from './keys.js';

// Types from Spec 001 Decision 2.

export interface RelayConfig {
  slack: {
    botToken: string; // xoxb-…; Web API and auth.test
    ingress:
      | { mode: 'events-api'; signingSecret: string }
      | { mode: 'socket-mode'; appToken: string }; // xapp-…, connections:write
  };
  sites: SiteConfig[];
  viewers?: ViewerConfig[];
  limits?: Partial<RelayLimits>;
}

export interface SiteConfig {
  name: string; // "north", unique; shown in logs and welcome
  channels: string[]; // Slack channel ids ("C…"/"G…"); at least one
  keyHashes: string[]; // "sha256:<hex>"; more than one during rotation (Decision 3)
}

export interface ViewerConfig {
  name: string; // "portal"
  channels: string[] | '*'; // '*' = every channel any site owns
  keyHashes: string[]; // unused by in-process viewers
  canPost: boolean;
}

export interface RelayLimits {
  resumeWindowMs: number; // 120_000 (Decision 10)
  resumeMaxEvents: number; // 200 per site
  maxEventAgeMs: number; // 300_000: older messages never reach a site (Decision 5)
  historySize: number; // 50 per channel (Decision 11)
  handshakeTimeoutMs: number; // 10_000
  idleTimeoutMs: number; // 90_000 (Decision 9)
  maxFrameBytes: number; // 65_536
}

export const DEFAULT_LIMITS: RelayLimits = Object.freeze({
  resumeWindowMs: 120_000,
  resumeMaxEvents: 200,
  maxEventAgeMs: 300_000,
  historySize: 50,
  handshakeTimeoutMs: 10_000,
  idleTimeoutMs: 90_000,
  maxFrameBytes: 65_536,
});

/** A viewer whose `'*'` has been expanded to every site-owned channel, sorted. */
export interface ResolvedViewerConfig extends Omit<ViewerConfig, 'channels'> {
  channels: string[];
}

/** What `validateConfig` returns: the config with every default filled in. */
export interface ResolvedConfig {
  slack: RelayConfig['slack'];
  sites: SiteConfig[];
  viewers: ResolvedViewerConfig[]; // [] when config.viewers is absent
  limits: RelayLimits; // { ...DEFAULT_LIMITS, ...config.limits }
  channelOwner: Map<string, string>; // channel id → site name
}

/** Thrown by `validateConfig`; `problems` lists every rule the config breaks. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(['Invalid relay config:', ...problems.map((p) => `- ${p}`)].join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]+$/;

type Entry = { kind: 'site' | 'viewer'; name: string; channels: string[] | '*'; keyHashes: string[] };

/**
 * Checks every Spec 001 Decision 2 rule and returns the resolved config, or
 * throws one `ConfigError` listing every problem. Never mutates `config`.
 */
export function validateConfig(config: RelayConfig): ResolvedConfig {
  const sites = config.sites;
  const viewers = config.viewers ?? [];
  const entries: Entry[] = [
    ...sites.map((s) => ({ kind: 'site' as const, ...s })),
    ...viewers.map((v) => ({ kind: 'viewer' as const, ...v })),
  ];
  const problems: string[] = [];

  // Names unique within each kind (a site and a viewer may share one).
  for (const kind of ['site', 'viewer'] as const) {
    const counts = countBy(entries.filter((e) => e.kind === kind).map((e) => e.name));
    for (const [name, count] of counts) {
      if (count > 1) problems.push(`${kind} name "${name}" is used more than once`);
    }
  }

  // Per-entry checks: channel ids, at least one channel per site, hash format.
  for (const e of entries) {
    const label = `${e.kind} "${e.name}"`;
    if (e.channels !== '*') {
      for (const id of e.channels) {
        if (!CHANNEL_ID_PATTERN.test(id)) problems.push(`${label} has an invalid channel id ${JSON.stringify(id)}`);
      }
    }
    if (e.kind === 'site' && e.channels.length === 0) problems.push(`${label} has no channels`);
    for (const hash of e.keyHashes) {
      if (!KEY_HASH_PATTERN.test(hash)) {
        problems.push(
          `${label} has a malformed key hash ${JSON.stringify(hash)} (expected "sha256:" + 64 lowercase hex)`,
        );
      }
    }
  }

  // Each channel belongs to exactly one site.
  const channelSites = new Map<string, string[]>();
  for (const s of sites) {
    for (const id of new Set(s.channels)) push(channelSites, id, `"${s.name}"`);
  }
  for (const [id, owners] of channelSites) {
    if (owners.length > 1) problems.push(`channel ${id} is listed by sites ${joinNames(owners)}`);
  }

  // A key hash is used by at most one site or viewer (repeats within one entry are fine).
  const hashOwners = new Map<string, string[]>();
  for (const e of entries) {
    for (const hash of new Set(e.keyHashes)) {
      if (KEY_HASH_PATTERN.test(hash)) push(hashOwners, hash, `${e.kind} "${e.name}"`);
    }
  }
  for (const [hash, owners] of hashOwners) {
    if (owners.length > 1) problems.push(`key hash ${hash} is used by ${joinNames(owners)}`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const channelOwner = new Map<string, string>();
  for (const s of sites) for (const id of s.channels) channelOwner.set(id, s.name);
  const allChannels = [...channelOwner.keys()].sort();

  return {
    slack: structuredClone(config.slack),
    sites: sites.map((s) => ({ ...s, channels: [...s.channels], keyHashes: [...s.keyHashes] })),
    viewers: viewers.map((v) => ({
      ...v,
      channels: v.channels === '*' ? [...allChannels] : [...v.channels],
      keyHashes: [...v.keyHashes],
    })),
    limits: { ...DEFAULT_LIMITS, ...config.limits },
    channelOwner,
  };
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** `a` / `a and b` / `a, b and c` */
function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
