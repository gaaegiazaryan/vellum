import {
  ConflictException,
  HttpStatus,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of } from 'rxjs';
import { mergeMap, tap } from 'rxjs/operators';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService } from './idempotency.service.js';
import { IDEMPOTENT_KEY, DEFAULT_TTL_SECONDS } from './idempotency.decorator.js';
import { requestHash } from './canonicalize.js';

interface IdempotentMeta {
  ttlSeconds: number;
}

const HEADER = 'idempotency-key';
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 200;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly service: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<IdempotentMeta | undefined>(
      IDEMPOTENT_KEY,
      context.getHandler(),
    );
    if (!meta) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const res = context.switchToHttp().getResponse<FastifyReply>();
    const key = req.headers[HEADER];
    if (typeof key !== 'string') {
      throw new ConflictException({
        error: 'idempotency_key_required',
        message: `${HEADER} header is required for this endpoint`,
      });
    }
    if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
      throw new ConflictException({
        error: 'idempotency_key_invalid',
        message: `${HEADER} must be ${MIN_KEY_LENGTH}-${MAX_KEY_LENGTH} characters`,
      });
    }

    const method = req.method;
    const path = req.routeOptions?.url ?? req.url;
    const hash = requestHash(method, path, req.body);
    const userId = pickUserId(req);

    return from(
      this.service.tryClaim({
        key,
        method,
        path,
        hash,
        userId,
        ttlSeconds: meta.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      }),
    ).pipe(
      mergeMap((claim) => {
        if (claim.kind === 'conflict') {
          throw new ConflictException({
            error: 'idempotency_key_conflict',
            message: `${HEADER} reused with a different request body`,
          });
        }
        if (claim.kind === 'in_flight') {
          throw new ConflictException({
            error: 'idempotency_key_in_flight',
            message: 'a request with this key is still being processed; retry shortly',
          });
        }
        if (claim.kind === 'replay') {
          res.status(claim.response.status);
          return of(claim.response.body);
        }
        return next.handle().pipe(
          tap(async (body) => {
            const status = res.statusCode ?? HttpStatus.OK;
            await this.service.store({ key, method, path, status, body });
          }),
        );
      }),
    );
  }
}

function pickUserId(req: FastifyRequest): string | null {
  const u = (req as FastifyRequest & { user?: { id?: string } }).user;
  return u?.id ?? null;
}
