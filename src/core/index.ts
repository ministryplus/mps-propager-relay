// @ministryplus/propager-relay: the core's public API (Spec 001 Decision 12).
// Exported types are the relay's own; nothing here may reference @slack/types.

export { createRelay } from './relay.js';
export type { Relay, ViewerHandle, HealthReport } from './relay.js';
export { validateConfig, DEFAULT_LIMITS, ConfigError } from './config.js';
export type { RelayConfig, SiteConfig, ViewerConfig, RelayLimits } from './config.js';
export { generateKey, hashKey, verifyKey } from './keys.js';
export type { SlackApi, SlackHistoryMessage } from './slack-api.js';
export type { Logger } from './logger.js';
export type { RelayMessage } from '../protocol/types.js';
