import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Logger as PinoLogger } from 'nestjs-pino';
import fastifyMultipart from '@fastify/multipart';
import fastifyHelmet from '@fastify/helmet';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { genRequestId } from './observability/request-id.js';
import { MAX_UPLOAD_BYTES } from './uploads/uploads.service.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(env),
    new FastifyAdapter({ trustProxy: true, genReqId: genRequestId }),
    { bufferLogs: true },
  );
  app.useLogger(app.get(PinoLogger));
  app.useWebSocketAdapter(new IoAdapter(app));

  // Echo the request id (generated or accepted from X-Request-Id) on
  // every response so the happy path also surfaces it. The exception
  // filter handles the same thing on the error path.
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', async (req, reply) => {
    if (!reply.getHeader('x-request-id')) {
      reply.header('X-Request-Id', String(req.id ?? ''));
    }
  });

  // Default-deny security headers. The api never serves HTML so no
  // CSP rules are needed for inline assets; the JSON-only contract
  // means a strict default is the right one. crossOriginResourcePolicy
  // stays 'same-origin' because the web app is the only consumer; if
  // a future deploy splits domains the operator will set
  // NEXT_PUBLIC_API_URL and CORS lands as a separate ADR.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.isProduction
      ? { maxAge: 15_552_000, includeSubDomains: true, preload: false }
      : false,
  });

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
