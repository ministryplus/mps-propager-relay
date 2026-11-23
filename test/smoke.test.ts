import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleLogger } from '../src/core/logger.js';

describe('consoleLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    it(`prefixes ${level} with [relay]`, () => {
      const spy = vi.spyOn(console, level).mockImplementation(() => {});
      consoleLogger[level]('hello', 42);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('[relay]', 'hello', 42);
    });
  }
});

describe('entry points', () => {
  it('load', async () => {
    await expect(import('../src/core/index.js')).resolves.toBeDefined();
    await expect(import('../src/h3/index.js')).resolves.toBeDefined();
    await expect(import('../src/standalone/index.js')).resolves.toBeDefined();
  });
});
