import { cookies, headers } from 'next/headers';

/**
 * Server-side helper to call apps/api with the user's session cookie
 * forwarded. Web reads via this; CLI / mobile clients hit the api
 * directly with their own auth.
 *
 * In dev: API_INTERNAL_URL defaults to http://localhost:3001. Cookie
 * domain on localhost matches across ports so the session forwards
 * cleanly. In production, point API_INTERNAL_URL at the api service
 * (same parent domain as web so the browser-set cookie is available
 * server-side here, and forwarding it onward is straightforward).
 */
const DEFAULT_BASE = 'http://localhost:3001';

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T>;
}

export async function apiClient(): Promise<ApiClient> {
  const base = process.env.API_INTERNAL_URL ?? DEFAULT_BASE;
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const reqHeaders = await headers();
  const forwardedFor = reqHeaders.get('x-forwarded-for') ?? undefined;

  function buildHeaders(extra: Record<string, string> = {}): Headers {
    const h = new Headers(extra);
    if (cookieHeader) h.set('cookie', cookieHeader);
    if (forwardedFor) h.set('x-forwarded-for', forwardedFor);
    return h;
  }

  async function handle<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, text);
    }
    return (await res.json()) as T;
  }

  return {
    async get<T>(path: string): Promise<T> {
      const res = await fetch(`${base}${path}`, {
        headers: buildHeaders(),
        cache: 'no-store',
      });
      return handle<T>(res);
    },
    async post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: buildHeaders({
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        }),
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      return handle<T>(res);
    },
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`api error ${status}: ${body || '(empty body)'}`);
    this.name = 'ApiError';
  }
}
