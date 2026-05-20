import { Module, type DynamicModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AccountsModule } from './accounts/accounts.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthzModule } from './healthz/healthz.module.js';
import { DatabaseModule } from './db/database.module.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { JournalEntriesModule } from './journal-entries/journal-entries.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor.js';
import { REDACT_PATHS } from './observability/redact-paths.js';
import type { Env } from './config/env.js';

@Module({})
export class AppModule {
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            transport: env.isProduction ? undefined : { target: 'pino-pretty' },
            redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
          },
        }),
        DatabaseModule.forRoot(env),
        AuthModule.forRoot(env),
        IdempotencyModule,
        AccountsModule,
        JournalEntriesModule,
        UploadsModule.forRoot(env),
        HealthzModule,
      ],
      providers: [{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
    };
  }
}
