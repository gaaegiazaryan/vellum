import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Logger as PinoLogger } from 'nestjs-pino';
import fastifyMultipart from '@fastify/multipart';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
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

  // Global per-IP rate limit. FastifyAdapter is constructed with
  // trustProxy: true, so the source IP comes from X-Forwarded-For
  // when an LB sits in front. 600 req/min is generous for normal
  // browsing (one user logged into the web ledger averages well
  // under that) but cuts off scripted enumeration of the public
  // probe endpoints (/healthz, /readyz) before it can amplify into
  // a DB roundtrip storm.
  //
  // The cap is global, not per-route, on purpose: a single bucket
  // is one number to reason about. If a real route ever needs its
  // own ceiling (auth-related is the usual candidate), that lands
  // through a route-level config in a future PR.
  await app.register(fastifyRateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
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
