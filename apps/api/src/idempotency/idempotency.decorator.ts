import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'vellum:idempotent';

/**
 * Marks a route handler as requiring an Idempotency-Key header. The
 * IdempotencyInterceptor reads this flag and applies the lookup /
 * store / replay logic only to handlers wearing this decorator.
 *
 * Default TTL is 24 hours. Override per-route by passing seconds.
 */
export interface IdempotentOptions {
  ttlSeconds?: number;
}

export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export const Idempotent = (options: IdempotentOptions = {}): MethodDecorator =>
  SetMetadata(IDEMPOTENT_KEY, {
    ttlSeconds: options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  });
