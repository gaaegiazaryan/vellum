import { NextResponse, type NextRequest } from 'next/server';
import { decode } from '@auth/core/jwt';

/**
 * Next.js middleware running on the edge. Protects routes under /app
 * by validating the Auth.js session cookie. We decode the JWE directly
 * (rather than importing the full `auth()` instance) because the full
 * instance wires the Drizzle adapter, which is not edge-compatible.
 *
 * The route-level `auth()` check in /app/page.tsx is still the canonical
 * guard; this middleware is a fast cut-off so we do not pay the cost
 * of rendering a page just to discard it. Defense in depth: even if a
 * future page forgets to call `auth()`, the middleware still intercepts.
 */
export const config = {
  matcher: ['/app/:path*'],
};

const COOKIE_NAMES = ['__Secure-authjs.session-token', 'authjs.session-token'] as const;

async function authenticatedUserId(req: NextRequest): Promise<string | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  for (const name of COOKIE_NAMES) {
    const cookie = req.cookies.get(name);
    if (!cookie) continue;
    try {
      const payload = await decode({ token: cookie.value, secret, salt: name });
      if (payload && typeof payload.sub === 'string') return payload.sub;
    } catch {
      // fall through to the other cookie name or to redirect
    }
  }
  return null;
}

export default async function middleware(req: NextRequest) {
  const userId = await authenticatedUserId(req);
  if (userId) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/signin';
  url.searchParams.set('from', req.nextUrl.pathname);
  return NextResponse.redirect(url);
}
