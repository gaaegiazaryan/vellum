import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyService } from './idempotency.service.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

/**
 * The module owns the interceptor and registers it as APP_INTERCEPTOR
 * here, so consumers only need to import IdempotencyModule. Registering
 * the same class as a regular provider AND as useClass APP_INTERCEPTOR
 * in a downstream module produces a broken second instance with its DI
 * dependencies undefined (the constructor is invoked without arg
 * resolution), which surfaces as a 500 on the first request.
 */
@Module({
  providers: [IdempotencyService, { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
