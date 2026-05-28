import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

/**
 * Regression coverage for the full production boot path. Two latent
 * bugs surfaced when the bundled api was first run end to end:
 *
 *   1. UploadsModule.forRoot and QueueModule.forRoot were called twice
 *      (once in AppModule, once inside ExtractionsModule.forRoot.imports),
 *      so Fastify rejected on a duplicate POST /uploads.
 *   2. IdempotencyInterceptor was both a regular provider in
 *      IdempotencyModule and re-registered with useClass APP_INTERCEPTOR
 *      in AppModule, so Nest built a second instance without resolving
 *      its constructor dependencies and every request 500'd on a
 *      this.reflector undefined.
 *
 * The narrower unit-style tests use a TestInfraModule that wires the
 * controllers directly, so neither bug reproduced there. This test
 * exercises the full module graph and also makes a real GET /healthz
 * against the running app, so a future regression on either path fails
 * in CI rather than at deploy time.
 */
describe('AppModule full bootstrap (integration)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let app: NestFastifyApplication | undefined;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('vellum_test')
      .withUsername('vellum')
      .withPassword('vellum')
      .start();
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

    const env = loadEnv({
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      AUTH_SECRET: 'a'.repeat(32),
      NODE_ENV: 'test',
      EXTRACTION_PROVIDER: 'mock',
      STORAGE_DRIVER: 'filesystem',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env)],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await postgres?.stop();
  });

  it('initializes the full module graph without registering duplicate routes', () => {
    // Reaching this point means Fastify accepted every route
    // registration and Nest resolved the DI graph against the real
    // Postgres + Redis.
    expect(app).toBeDefined();
  });

  it('serves a real request through the global interceptor stack', async () => {
    const res = await app!.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    expect(body.status).toBe('ok');
  });
});
