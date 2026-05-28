import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

/**
 * Regression: the api refused to boot because UploadsModule.forRoot
 * and QueueModule.forRoot were called twice (once in AppModule, once
 * inside ExtractionsModule.forRoot.imports). Each call returned a
 * dynamic module with a fresh useValue, Nest could not dedupe by
 * structural hash, and Fastify rejected on a duplicate POST /uploads.
 * The narrower unit-style tests use a TestInfraModule that skipped
 * the nested forRoot, so the bug only surfaced when the full graph
 * was wired. This test exercises the full graph.
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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await postgres?.stop();
  });

  it('initializes the full module graph without registering duplicate routes', async () => {
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
    // Reaching here means Fastify accepted every route registration
    // and Nest resolved the DI graph against the real Postgres + Redis.
    expect(true).toBe(true);
  }, 60_000);
});
