import type { FastifyRequest } from 'fastify';

/**
 * Auth.js session cookie name. The library uses `__Secure-authjs.session-token`
 * over HTTPS (production) and `authjs.session-token` otherwise. We probe both
 * so the API behaves the same on a dev http listener and a prod https one.
 *
 * The cookie name doubles as the salt for the JWE key derivation in Auth.js
 * v5, which is why we return both the value and which name it came from.
 */
const COOKIE_NAMES = ['__Secure-authjs.session-token', 'authjs.session-token'] as const;

export interface SessionCookie {
  value: string;
  name: (typeof COOKIE_NAMES)[number];
}

export function readSessionCookie(req: FastifyRequest): SessionCookie | null {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  for (const name of COOKIE_NAMES) {
    const value = parseCookie(raw, name);
    if (value) return { value, name };
  }
  return null;
}

function parseCookie(header: string, name: string): string | null {
  const prefix = name + '=';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return null;
}

export { COOKIE_NAMES };
