import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Logger as PinoLogger } from 'nestjs-pino';
import fastifyMultipart from '@fastify/multipart';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { MAX_UPLOAD_BYTES } from './uploads/uploads.service.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(env),
    new FastifyAdapter({ trustProxy: true }),
    { bufferLogs: true },
  );
  app.useLogger(app.get(PinoLogger));
  app.useWebSocketAdapter(new IoAdapter(app));

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
    },
  });

  // So the extraction worker and db pool close on SIGTERM/SIGINT
  // instead of being killed mid-job.
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
