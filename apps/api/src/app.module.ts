import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
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
