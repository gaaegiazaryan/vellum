import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

@Module({
  providers: [IdempotencyService, IdempotencyInterceptor],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
