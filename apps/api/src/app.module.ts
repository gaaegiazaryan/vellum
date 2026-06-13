import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { RequestIdExceptionFilter } from './observability/request-id-filter.js';
import { AccountsModule } from './accounts/accounts.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthzModule } from './healthz/healthz.module.js';
import { DatabaseModule } from './db/database.module.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { JournalEntriesModule } from './journal-entries/journal-entries.module.js';
import { QueueModule } from './queue/queue.module.js';
import { BudgetModule } from './budget/budget.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { WebsocketModule } from './websocket/websocket.module.js';
import { ExtractionsModule } from './extractions/extractions.module.js';
import { REDACT_PATHS } from './observability/redact-paths.js';
import type { Env } from './config/env.js';

@Module({})
export class AppModule {
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      providers: [{ provide: APP_FILTER, useClass: RequestIdExceptionFilter }],
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            transport: env.isProduction ? undefined : { target: 'pino-pretty' },
            redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
            // FastifyAdapter.genRequestId (main.ts) sets req.id; pino
            // surfaces it as requestId in every log line so a single
            // id correlates every component a request touched.
            customAttributeKeys: { reqId: 'requestId' },
          },
        }),
        DatabaseModule.forRoot(env),
        AuthModule.forRoot(env),
        IdempotencyModule,
        AccountsModule,
        JournalEntriesModule,
        QueueModule.forRoot(env),
        BudgetModule.forRoot(env),
        WebsocketModule.forRoot(),
        UploadsModule.forRoot(env),
        ExtractionsModule.forRoot(env),
        HealthzModule,
      ],
    };
  }
}
