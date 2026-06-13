import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { Redis } from 'ioredis';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReadyzController } from './readyz.controller.js';
import { DATABASE_TOKEN, DB_HANDLE_TOKEN } from '../db/database.module.js';
import { QUEUE_CONNECTION } from '../queue/queue.module.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../db/migrations');

@Global()
@Module({})
class TestInfra {
  static forRoot(db: PostgresJsDatabase, redis: Redis): DynamicModule {
    return {
      module: TestInfra,
      providers: [
        { provide: DB_HANDLE_TOKEN, useValue: { db, close: async () => {} } },
        { provide: DATABASE_TOKEN, useValue: db },
        { provide: QUEUE_CONNECTION, useValue: redis },
      ],
      exports: [DATABASE_TOKEN, QUEUE_CONNECTION],
    };
  }
}

describe('ReadyzController GET /readyz (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let redis: Redis;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('vellum_test')
      .withUsername('vellum')
      .withPassword('vellum')
      .start();
    redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    sql = postgres(container.getConnectionUri(), { max: 4 });
    db = drizzle(sql);
    await migrate(db, { migrationsFolder });
    redis = new Redis({
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    // Wait for the first ready so the up-path test does not race
    // ioredis' background connect.
    await redis.ping();

    const moduleRef = await Test.createTestingModule({
      imports: [TestInfra.forRoot(db, redis)],
      controllers: [ReadyzController],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await sql?.end({ timeout: 5 });
    await redisContainer?.stop();
    await container?.stop();
  });

  it('reports both dependencies up under normal conditions', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; database: string; redis: string };
    expect(body).toMatchObject({ status: 'ready', database: 'up', redis: 'up' });
  });

  it('returns 503 with the failing dependency named when redis is down', async () => {
    // Disconnect and shadow the connection with a doomed one so the
    // probe fails fast instead of relying on the container being torn
    // down (the suite tears down at afterAll only).
    const dead = new Redis({
      host: '127.0.0.1',
      port: 1,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfra.forRoot(db, dead)],
      controllers: [ReadyzController],
    }).compile();
    const localApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await localApp.init();
    await localApp.getHttpAdapter().getInstance().ready();
    try {
      const res = await localApp.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { status: string; database: string; redis: string };
      expect(body.status).toBe('degraded');
      expect(body.database).toBe('up');
      expect(body.redis).toBe('down');
    } finally {
      dead.disconnect();
      await localApp.close();
    }
  });
});
