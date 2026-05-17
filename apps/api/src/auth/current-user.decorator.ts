import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from './auth.guard.js';

/**
 * Pulls the authenticated user attached by AuthGuard. The guard must
 * run before any handler reaches this decorator, otherwise the value
 * is undefined and the caller has to handle that explicitly.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    return req.user;
  },
);
