import { describe, it, expect } from 'vitest';
import { REDACT_PATHS } from './redact-paths.js';

describe('REDACT_PATHS', () => {
  it('covers the headers that previously made up the entire allow-list', () => {
    expect(REDACT_PATHS).toContain('req.headers.authorization');
    expect(REDACT_PATHS).toContain('req.headers.cookie');
  });

  it('covers the response set-cookie that carries session tokens', () => {
    expect(REDACT_PATHS).toContain('res.headers["set-cookie"]');
  });

  it('covers common API-key header variants', () => {
    expect(REDACT_PATHS).toContain('req.headers["x-api-key"]');
    expect(REDACT_PATHS).toContain('req.headers["x-auth-token"]');
  });

  it('covers password fields at the top level and one nesting depth', () => {
    expect(REDACT_PATHS).toContain('req.body.password');
    expect(REDACT_PATHS).toContain('req.body.*.password');
  });

  it('covers token-shaped body fields', () => {
    for (const path of [
      'req.body.token',
      'req.body.refreshToken',
      'req.body.accessToken',
      'req.body.idToken',
    ]) {
      expect(REDACT_PATHS).toContain(path);
    }
  });

  it('covers card-data fields', () => {
    for (const path of ['req.body.cardNumber', 'req.body.cvv', 'req.body.cvc', 'req.body.pin']) {
      expect(REDACT_PATHS).toContain(path);
    }
  });

  it('covers OAuth callback codes and api keys in query strings', () => {
    for (const path of [
      'req.query.code',
      'req.query.token',
      'req.query.apikey',
      'req.query.api_key',
      'req.query.access_token',
      'req.query.id_token',
    ]) {
      expect(REDACT_PATHS).toContain(path);
    }
  });

  it('uses single-segment wildcards (pino fast-redact limitation)', () => {
    for (const path of REDACT_PATHS) {
      const segments = path.split('.');
      const wildcardSegments = segments.filter((s) => s.includes('*'));
      expect(wildcardSegments.length).toBeLessThanOrEqual(1);
    }
  });

  it('is frozen so a future change is intentional, not a typo', () => {
    expect(Object.isFrozen(REDACT_PATHS)).toBe(true);
  });
});
