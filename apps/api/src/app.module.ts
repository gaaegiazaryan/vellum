import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { HealthzModule } from './healthz/healthz.module.js';

const isProduction = process.env['NODE_ENV'] === 'production';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env['LOG_LEVEL'] ?? (isProduction ? 'info' : 'debug'),
        transport: isProduction ? undefined : { target: 'pino-pretty' },
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    HealthzModule,
  ],
})
export class AppModule {}
