import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, hashKey, verifyKey } from '../../src/core/index.js';
import { run } from '../../src/standalone/cli.js';
import { loadConfig } from '../../src/standalone/index.js';

const HASH = hashKey('prk_test');
const FILE = { sites: [{ name: 'north', channels: ['C0123ABC'], keyHashes: [HASH] }] };

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).problems;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('defaults to events-api with the bot token and signing secret from env', () => {
    const config = loadConfig(FILE, { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_SIGNING_SECRET: 'sec' });
    expect(config).toEqual({
      slack: { botToken: 'xoxb-1', ingress: { mode: 'events-api', signingSecret: 'sec' } },
      sites: FILE.sites,
    });
  });

  it('defaults to socket-mode when SLACK_APP_TOKEN is set', () => {
    const config = loadConfig(FILE, { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' });
    expect(config.slack.ingress).toEqual({ mode: 'socket-mode', appToken: 'xapp-1' });
  });

  it('lets file.ingress override the default', () => {
    const config = loadConfig(
      { ...FILE, ingress: 'events-api' },
      { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', SLACK_SIGNING_SECRET: 'sec' },
    );
    expect(config.slack.ingress).toEqual({ mode: 'events-api', signingSecret: 'sec' });
  });

  it('passes viewers and limits through', () => {
    const viewers = [{ name: 'portal', channels: '*' as const, keyHashes: [hashKey('prk_v')], canPost: true }];
    const config = loadConfig(
      { ...FILE, viewers, limits: { historySize: 10 } },
      { SLACK_BOT_TOKEN: 'x', SLACK_SIGNING_SECRET: 's' },
    );
    expect(config.viewers).toEqual(viewers);
    expect(config.limits).toEqual({ historySize: 10 });
  });

  it('lists every missing variable at once (events-api)', () => {
    const problems = problemsOf(() => loadConfig(FILE, {}));
    expect(problems.join('\n')).toMatch(/SLACK_BOT_TOKEN/);
    expect(problems.join('\n')).toMatch(/SLACK_SIGNING_SECRET/);
    expect(problems).toHaveLength(2);
  });

  it('lists every missing variable at once (socket-mode from the file)', () => {
    const problems = problemsOf(() => loadConfig({ ...FILE, ingress: 'socket-mode' }, { SLACK_SIGNING_SECRET: 's' }));
    expect(problems.join('\n')).toMatch(/SLACK_BOT_TOKEN/);
    expect(problems.join('\n')).toMatch(/SLACK_APP_TOKEN/);
    expect(problems).toHaveLength(2);
  });

  it('treats an empty variable as missing', () => {
    const problems = problemsOf(() => loadConfig(FILE, { SLACK_BOT_TOKEN: '', SLACK_SIGNING_SECRET: 's' }));
    expect(problems).toEqual([expect.stringMatching(/SLACK_BOT_TOKEN/)]);
  });

  it('rejects secrets in the file, saying they go in env vars', () => {
    const problems = problemsOf(() =>
      loadConfig({ ...FILE, slack: { botToken: 'xoxb-leak' } }, { SLACK_BOT_TOKEN: 'x', SLACK_SIGNING_SECRET: 's' }),
    );
    expect(problems.join('\n')).toMatch(/"slack".*env/i);
    expect(problems.join('\n')).not.toContain('xoxb-leak');
  });

  it('rejects an unknown ingress and a malformed file shape', () => {
    const env = { SLACK_BOT_TOKEN: 'x', SLACK_SIGNING_SECRET: 's' };
    expect(problemsOf(() => loadConfig({ ...FILE, ingress: 'webhook' }, env)).join('\n')).toMatch(/ingress/);
    expect(problemsOf(() => loadConfig({}, env)).join('\n')).toMatch(/sites/);
    expect(problemsOf(() => loadConfig([], env)).join('\n')).toMatch(/object/);
    expect(problemsOf(() => loadConfig({ sites: [{ name: 'n' }] }, env)).join('\n')).toMatch(/channels/);
  });
});

describe('cli', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cli-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function io(env: Record<string, string | undefined> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { env, stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) } };
  }

  it('keygen prints a key and its hash in the Decision 3 format', async () => {
    const t = io();
    expect(await run(['keygen'], t.io)).toBe(0);
    const text = t.out.join('');
    const key = /^key: {2}(prk_[A-Za-z0-9_-]{43}) {3}\(give this to the site's ProPager; it is not stored anywhere\)$/m.exec(
      text,
    );
    const hash = /^hash: (sha256:[0-9a-f]{64}) {2}\(put this in the site's keyHashes\)$/m.exec(text);
    expect(key).not.toBeNull();
    expect(hash).not.toBeNull();
    expect(verifyKey(key![1]!, [hash![1]!])).toBe(true);
  });

  it('prints usage and exits 2 for no command, an unknown command, or serve without --config', async () => {
    for (const argv of [[], ['frobnicate'], ['serve'], ['serve', '--bogus']]) {
      const t = io();
      expect(await run(argv, t.io)).toBe(2);
      expect(t.err.join('')).toMatch(/usage/i);
    }
  });

  it('serve reports missing env vars together and exits 1', async () => {
    const path = join(dir, 'ok.json');
    writeFileSync(path, JSON.stringify(FILE));
    const t = io({});
    expect(await run(['serve', '--config', path], t.io)).toBe(1);
    expect(t.err.join('')).toMatch(/SLACK_BOT_TOKEN[\s\S]*SLACK_SIGNING_SECRET/);
  });

  it('serve rejects a file holding secrets and exits 1', async () => {
    const path = join(dir, 'secret.json');
    writeFileSync(path, JSON.stringify({ ...FILE, slack: { botToken: 'xoxb-leak' } }));
    const t = io({ SLACK_BOT_TOKEN: 'x', SLACK_SIGNING_SECRET: 's' });
    expect(await run(['serve', '--config', path], t.io)).toBe(1);
    expect(t.err.join('')).toMatch(/env/);
  });

  it('serve reports an unreadable or invalid file and exits 1', async () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    const env = { SLACK_BOT_TOKEN: 'x', SLACK_SIGNING_SECRET: 's' };
    for (const path of [bad, join(dir, 'missing.json')]) {
      const t = io(env);
      expect(await run(['serve', '--config', path], t.io)).toBe(1);
      expect(t.err.join('')).toContain(path);
    }
  });

  it('serve reports a config that fails validateConfig and exits 1', async () => {
    const path = join(dir, 'invalid.json');
    writeFileSync(path, JSON.stringify({ sites: [{ name: 'north', channels: ['bad'], keyHashes: [HASH] }] }));
    const t = io({ SLACK_BOT_TOKEN: 'x', SLACK_SIGNING_SECRET: 's' });
    expect(await run(['serve', '--config', path], t.io)).toBe(1);
    expect(t.err.join('')).toMatch(/invalid channel id/);
  });
});
