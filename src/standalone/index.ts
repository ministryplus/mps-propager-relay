// @ministryplus/propager-relay/standalone: the relay as its own server on
// node:http (Spec 001 Decision 12). The `propager-relay` CLI (cli.ts) is the
// documented interface; loadConfig and startServer exist so tests and scripts
// can run the same server with an injected Slack API.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import crossws from 'crossws/adapters/node';
import { createApp, createRouter, toNodeListener } from 'h3';
import {
  ConfigError,
  createRelay,
  type Logger,
  type Relay,
  type RelayConfig,
  type RelayLimits,
  type SiteConfig,
  type SlackApi,
  type ViewerConfig,
} from '../core/index.js';
import { consoleLogger } from '../core/logger.js';
import { createRelayHandlers } from '../h3/index.js';

/** The `--config` JSON file: sites, viewers, limits, and ingress mode. Never secrets. */
export interface StandaloneFile {
  ingress?: 'events-api' | 'socket-mode';
  sites: SiteConfig[];
  viewers?: ViewerConfig[];
  limits?: Partial<RelayLimits>;
}

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8787;
const ROUTES = { slackEvents: '/slack/events', socket: '/ws', health: '/healthz' } as const;

const INGRESS_MODES = ['events-api', 'socket-mode'] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Shape checks a parsed JSON file needs before `validateConfig` can run on it. */
function shapeProblems(file: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if ('slack' in file) {
    problems.push(
      'the config file has a "slack" key: Slack secrets go in env vars ' +
        '(SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN), never in the file',
    );
  }
  if (file.ingress !== undefined && !INGRESS_MODES.includes(file.ingress as never)) {
    problems.push(`"ingress" must be "events-api" or "socket-mode", not ${JSON.stringify(file.ingress)}`);
  }
  if (!Array.isArray(file.sites)) {
    problems.push('"sites" must be an array');
  } else {
    file.sites.forEach((s: unknown, i) => {
      const at = `sites[${i}]`;
      if (!isObject(s)) return void problems.push(`${at} must be an object`);
      if (typeof s.name !== 'string') problems.push(`${at}.name must be a string`);
      if (!isStringArray(s.channels)) problems.push(`${at}.channels must be an array of channel ids`);
      if (!isStringArray(s.keyHashes)) problems.push(`${at}.keyHashes must be an array of strings`);
    });
  }
  if (file.viewers !== undefined) {
    if (!Array.isArray(file.viewers)) {
      problems.push('"viewers" must be an array');
    } else {
      file.viewers.forEach((v: unknown, i) => {
        const at = `viewers[${i}]`;
        if (!isObject(v)) return void problems.push(`${at} must be an object`);
        if (typeof v.name !== 'string') problems.push(`${at}.name must be a string`);
        if (v.channels !== '*' && !isStringArray(v.channels)) {
          problems.push(`${at}.channels must be "*" or an array of channel ids`);
        }
        if (!isStringArray(v.keyHashes)) problems.push(`${at}.keyHashes must be an array of strings`);
        if (typeof v.canPost !== 'boolean') problems.push(`${at}.canPost must be true or false`);
      });
    }
  }
  if (file.limits !== undefined && !isObject(file.limits)) problems.push('"limits" must be an object');
  return problems;
}

/**
 * Builds a `RelayConfig` from the parsed `--config` file and the environment
 * (the Decision 12 table). Throws one `ConfigError` listing every problem:
 * each missing variable, a `slack` key in the file, or a malformed file.
 * The result still goes through `validateConfig` in `createRelay`.
 */
export function loadConfig(file: StandaloneFile | unknown, env: Record<string, string | undefined>): RelayConfig {
  if (!isObject(file)) throw new ConfigError(['the config file must hold a JSON object']);
  const problems = shapeProblems(file);

  const get = (name: string): string | undefined => (env[name] ? env[name] : undefined);
  const botToken = get('SLACK_BOT_TOKEN');
  const appToken = get('SLACK_APP_TOKEN');
  const signingSecret = get('SLACK_SIGNING_SECRET');
  const mode = (file.ingress as StandaloneFile['ingress']) ?? (appToken ? 'socket-mode' : 'events-api');

  if (!botToken) problems.push('SLACK_BOT_TOKEN is not set');
  if (mode === 'events-api' && !signingSecret) {
    problems.push('SLACK_SIGNING_SECRET is not set (required for events-api)');
  }
  if (mode === 'socket-mode' && !appToken) problems.push('SLACK_APP_TOKEN is not set (required for socket-mode)');
  if (problems.length > 0) throw new ConfigError(problems);

  const f = file as unknown as StandaloneFile;
  return {
    slack: {
      botToken: botToken!,
      ingress:
        mode === 'socket-mode' ? { mode, appToken: appToken! } : { mode: 'events-api', signingSecret: signingSecret! },
    },
    sites: f.sites,
    ...(f.viewers !== undefined ? { viewers: f.viewers } : {}),
    ...(f.limits !== undefined ? { limits: f.limits } : {}),
  };
}

export interface StandaloneServer {
  relay: Relay;
  /** The bound port (useful with `port: 0`). */
  port: number;
  /** Stops the relay (closing connections with 1001), then the HTTP server. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Creates the relay, serves `POST /slack/events`, `GET /ws`, and `GET /healthz`
 * on `host:port` (default `0.0.0.0:8787`; port `0` picks a free one), then
 * awaits `relay.start()`. Rejects on an invalid config or a failed listen.
 */
export async function startServer(o: {
  config: RelayConfig;
  host?: string;
  port?: number;
  logger?: Logger;
  slackApi?: SlackApi;
}): Promise<StandaloneServer> {
  const logger = o.logger ?? consoleLogger;
  const host = o.host ?? DEFAULT_HOST;
  const relay = createRelay({
    config: o.config,
    logger,
    ...(o.slackApi ? { slackApi: o.slackApi } : {}),
  });

  const h = createRelayHandlers(relay);
  const app = createApp();
  app.use(
    createRouter()
      .post(ROUTES.slackEvents, h.slackEvents)
      .get(ROUTES.socket, h.socket)
      .get(ROUTES.health, h.health),
  );
  const server = createServer(toNodeListener(app));
  const ws = crossws(app.websocket);

  // h3 never sees upgrades. Only /ws may upgrade: crossws would accept a path
  // with no hooks and leave an orphan socket.
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== ROUTES.socket) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    ws.handleUpgrade(req, socket, head).catch((err: unknown) => {
      logger.error('websocket upgrade failed', err);
      socket.destroy();
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.port ?? DEFAULT_PORT, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    await relay.stop();
    throw err;
  }
  const port = (server.address() as AddressInfo).port;
  logger.info(`listening on http://${host}:${port} (ingress: ${o.config.slack.ingress.mode})`);

  await relay.start();

  let stopPromise: Promise<void> | null = null;
  return {
    relay,
    port,
    stop() {
      stopPromise ??= (async () => {
        logger.info('shutting down');
        await relay.stop(); // closes every hello'd connection with 1001
        ws.closeAll(1001, 'relay shutting down'); // peers that never sent hello
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        });
      })();
      return stopPromise;
    },
  };
}
