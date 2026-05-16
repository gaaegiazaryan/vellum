import { describe, it, expect } from 'vitest';
import { EnvValidationError, loadEnv } from './env.js';

describe('loadEnv', () => {
  it('returns defaults when no env vars are set', () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.isProduction).toBe(false);
  });

  it('coerces PORT from a string', () => {
    const env = loadEnv({ PORT: '4000' });
    expect(env.PORT).toBe(4000);
  });

  it('switches the default LOG_LEVEL to info in production', () => {
    const env = loadEnv({ NODE_ENV: 'production' });
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.isProduction).toBe(true);
  });

  it('respects an explicit LOG_LEVEL', () => {
    const env = loadEnv({ NODE_ENV: 'production', LOG_LEVEL: 'trace' });
    expect(env.LOG_LEVEL).toBe('trace');
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(EnvValidationError);
  });

  it('rejects a PORT outside the valid range', () => {
    expect(() => loadEnv({ PORT: '70000' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ PORT: '0' })).toThrow(EnvValidationError);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadEnv({ LOG_LEVEL: 'verbose' })).toThrow(EnvValidationError);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow(EnvValidationError);
  });

  it('formats validation errors with the offending field path', () => {
    try {
      loadEnv({ PORT: 'abc' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      expect((e as Error).message).toContain('PORT');
    }
  });
});
