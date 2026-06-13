import { randomUUID } from 'node:crypto';

/**
 * Accept an incoming X-Request-Id verbatim when present; otherwise
 * generate a UUID v4. Shared by the FastifyAdapter (production and
 * tests) so the id is consistent at the request level, before any
 * downstream code reads it.
 *
 * Fastify's genReqId hook is called with the raw IncomingMessage or
 * Http2ServerRequest (the latter when http2 is enabled), so the
 * parameter is typed loosely on what we actually read.
 *
 * UUID v4 keeps the id unguessable; the request id appears in logs,
 * so a guessable value would be bait for log spelunking.
 */
export function genRequestId(req: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const headerVal = req.headers['x-request-id'];
  const incoming = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
}
