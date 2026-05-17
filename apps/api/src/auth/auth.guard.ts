import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { decode, type JWT } from '@auth/core/jwt';
import type { FastifyRequest } from 'fastify';
import { readSessionCookie } from './cookie-token.js';

export const AUTH_SECRET_TOKEN = Symbol('AUTH_SECRET_TOKEN');

export interface AuthenticatedUser {
  id: string;
  email?: string;
  name?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/**
 * Validates the Auth.js session cookie issued by apps/web. Auth.js v5
 * uses JWE (encrypted JWT) for session tokens, derived from AUTH_SECRET
 * via HKDF with the cookie name as the salt. We share the same secret
 * across web and api in v1 (per ADR-0003); migration to asymmetric
 * signing is the next step if the shared-secret coupling becomes
 * painful.
 *
 * On success, attaches the user to req.user. Handlers can pull it
 * out with @CurrentUser() or by typing the request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTH_SECRET_TOKEN) private readonly secret: string) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const cookie = readSessionCookie(req);
    if (!cookie) {
      throw new UnauthorizedException('missing session cookie');
    }

    let payload: JWT | null;
    try {
      payload = await decode({
        token: cookie.value,
        secret: this.secret,
        salt: cookie.name,
      });
    } catch {
      throw new UnauthorizedException('invalid session');
    }

    if (!payload || typeof payload.sub !== 'string') {
      throw new UnauthorizedException('invalid session');
    }

    req.user = {
      id: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
    return true;
  }
}
