import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { HealthzModule } from './healthz/healthz.module.js';
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
        AuthModule.forRoot(env),
        HealthzModule,
      ],
    };
  }
}
