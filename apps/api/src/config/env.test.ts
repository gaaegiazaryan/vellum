import { describe, it, expect } from 'vitest';
import { EnvValidationError, loadEnv } from './env.js';

const VALID_DB = 'postgres://user:pass@localhost:5432/vellum';
const VALID_SECRET = 'a'.repeat(32);
const base = { DATABASE_URL: VALID_DB, AUTH_SECRET: VALID_SECRET } as const;

describe('loadEnv', () => {
  it('returns defaults when only required env vars are set', () => {
    const env = loadEnv({ ...base });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.isProduction).toBe(false);
    expect(env.DATABASE_URL).toBe(VALID_DB);
  });

  it('coerces PORT from a string', () => {
    const env = loadEnv({ ...base, PORT: '4000' });
    expect(env.PORT).toBe(4000);
  });

  it('switches the default LOG_LEVEL to info in production', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'production' });
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.isProduction).toBe(true);
  });

  it('respects an explicit LOG_LEVEL', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'production', LOG_LEVEL: 'trace' });
    expect(env.LOG_LEVEL).toBe('trace');
  });

  it('accepts a postgresql:// scheme as well as postgres://', () => {
    const env = loadEnv({ ...base, DATABASE_URL: 'postgresql://u:p@h/d' });
    expect(env.DATABASE_URL).toBe('postgresql://u:p@h/d');
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: 'mysql://u:p@h/d' })).toThrow(EnvValidationError);
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadEnv({ ...base, PORT: 'abc' })).toThrow(EnvValidationError);
  });

  it('rejects a PORT outside the valid range', () => {
    expect(() => loadEnv({ ...base, PORT: '70000' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...base, PORT: '0' })).toThrow(EnvValidationError);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow(EnvValidationError);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'staging' })).toThrow(EnvValidationError);
  });

  it('rejects a missing AUTH_SECRET', () => {
    expect(() => loadEnv({ DATABASE_URL: VALID_DB })).toThrow(EnvValidationError);
  });

  it('rejects an AUTH_SECRET shorter than 32 characters', () => {
    expect(() => loadEnv({ ...base, AUTH_SECRET: 'short' })).toThrow(EnvValidationError);
  });

  it('formats validation errors with the offending field path', () => {
    try {
      loadEnv({ ...base, PORT: 'abc' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      expect((e as Error).message).toContain('PORT');
    }
  });

  it('defaults EXTRACTION_PROVIDER to mock when unset', () => {
    const env = loadEnv({ ...base });
    expect(env.EXTRACTION_PROVIDER).toBe('mock');
  });

  it('accepts EXTRACTION_PROVIDER=anthropic with an api key', () => {
    const env = loadEnv({
      ...base,
      EXTRACTION_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    expect(env.EXTRACTION_PROVIDER).toBe('anthropic');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
  });

  it('rejects EXTRACTION_PROVIDER=anthropic without an api key', () => {
    expect(() => loadEnv({ ...base, EXTRACTION_PROVIDER: 'anthropic' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an unknown EXTRACTION_PROVIDER', () => {
    expect(() => loadEnv({ ...base, EXTRACTION_PROVIDER: 'openai' })).toThrow(EnvValidationError);
  });

  it('defaults REDIS_URL to localhost when unset', () => {
    const env = loadEnv({ ...base });
    expect(env.REDIS_URL).toBe('redis://localhost:6379/0');
  });

  it('accepts a custom REDIS_URL', () => {
    const env = loadEnv({ ...base, REDIS_URL: 'rediss://cache.example.com:6380/1' });
    expect(env.REDIS_URL).toBe('rediss://cache.example.com:6380/1');
  });

  it('rejects a non-redis REDIS_URL', () => {
    expect(() => loadEnv({ ...base, REDIS_URL: 'http://localhost:6379' })).toThrow(
      EnvValidationError,
    );
  });

  it('defaults STORAGE_DRIVER to filesystem', () => {
    const env = loadEnv({ ...base });
    expect(env.STORAGE_DRIVER).toBe('filesystem');
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('accepts STORAGE_DRIVER=s3 with the required S3 vars', () => {
    const env = loadEnv({
      ...base,
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'receipts',
      S3_REGION: 'auto',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      S3_FORCE_PATH_STYLE: 'true',
    });
    expect(env.STORAGE_DRIVER).toBe('s3');
    expect(env.S3_BUCKET).toBe('receipts');
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('rejects STORAGE_DRIVER=s3 without the S3 credentials', () => {
    expect(() => loadEnv({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'receipts' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an unknown STORAGE_DRIVER', () => {
    expect(() => loadEnv({ ...base, STORAGE_DRIVER: 'gcs' })).toThrow(EnvValidationError);
  });

  it('PLAID is off by default and the credential fields are unset', () => {
    const env = loadEnv({ ...base });
    expect(env.PLAID_ENABLED).toBe(false);
    expect(env.PLAID_CLIENT_ID).toBeUndefined();
    expect(env.PLAID_SECRET).toBeUndefined();
    expect(env.PLAID_ENV).toBeUndefined();
  });

  it('accepts PLAID_ENABLED=true with the three required credential fields', () => {
    const env = loadEnv({
      ...base,
      PLAID_ENABLED: 'true',
      PLAID_ENV: 'sandbox',
      PLAID_CLIENT_ID: 'cid',
      PLAID_SECRET: 'csec',
    });
    expect(env.PLAID_ENABLED).toBe(true);
    expect(env.PLAID_ENV).toBe('sandbox');
  });

  it('rejects PLAID_ENABLED=true without PLAID_ENV', () => {
    expect(() =>
      loadEnv({
        ...base,
        PLAID_ENABLED: 'true',
        PLAID_CLIENT_ID: 'cid',
        PLAID_SECRET: 'csec',
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects PLAID_ENABLED=true without PLAID_CLIENT_ID', () => {
    expect(() =>
      loadEnv({
        ...base,
        PLAID_ENABLED: 'true',
        PLAID_ENV: 'sandbox',
        PLAID_SECRET: 'csec',
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects PLAID_ENABLED=true without PLAID_SECRET', () => {
    expect(() =>
      loadEnv({
        ...base,
        PLAID_ENABLED: 'true',
        PLAID_ENV: 'sandbox',
        PLAID_CLIENT_ID: 'cid',
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects an unknown PLAID_ENV', () => {
    expect(() =>
      loadEnv({
        ...base,
        PLAID_ENABLED: 'true',
        PLAID_ENV: 'staging',
        PLAID_CLIENT_ID: 'cid',
        PLAID_SECRET: 'csec',
      }),
    ).toThrow(EnvValidationError);
  });
});
