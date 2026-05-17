import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { readSessionCookie } from './cookie-token.js';

function req(cookie?: string): FastifyRequest {
  return { headers: cookie ? { cookie } : {} } as unknown as FastifyRequest;
}

describe('readSessionCookie', () => {
  it('returns null when there is no cookie header', () => {
    expect(readSessionCookie(req())).toBeNull();
  });

  it('returns null when the cookie header is empty', () => {
    expect(readSessionCookie(req(''))).toBeNull();
  });

  it('returns value + name for the production __Secure-* cookie', () => {
    expect(readSessionCookie(req('__Secure-authjs.session-token=abc'))).toEqual({
      value: 'abc',
      name: '__Secure-authjs.session-token',
    });
  });

  it('returns value + name for the dev cookie', () => {
    expect(readSessionCookie(req('authjs.session-token=abc'))).toEqual({
      value: 'abc',
      name: 'authjs.session-token',
    });
  });

  it('prefers the __Secure-* variant when both are present', () => {
    const cookie = '__Secure-authjs.session-token=secure;authjs.session-token=plain';
    expect(readSessionCookie(req(cookie))?.value).toBe('secure');
  });

  it('handles multiple cookies separated by semicolons', () => {
    const cookie = 'other=1; authjs.session-token=token-here; another=2';
    expect(readSessionCookie(req(cookie))?.value).toBe('token-here');
  });

  it('url-decodes the value', () => {
    expect(readSessionCookie(req('authjs.session-token=a%20b'))?.value).toBe('a b');
  });

  it('returns null when the cookie is present but for an unrelated name', () => {
    expect(readSessionCookie(req('session_id=xyz'))).toBeNull();
  });
});
