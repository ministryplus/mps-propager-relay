export interface Logger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

const PREFIX = '[relay]';

/** The default logger: forwards to `console` with a "[relay]" prefix. */
export const consoleLogger: Logger = {
  debug: (...a) => console.debug(PREFIX, ...a),
  info: (...a) => console.info(PREFIX, ...a),
  warn: (...a) => console.warn(PREFIX, ...a),
  error: (...a) => console.error(PREFIX, ...a),
};
