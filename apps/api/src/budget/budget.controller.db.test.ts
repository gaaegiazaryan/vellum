import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { encode } from '@auth/core/jwt';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { BudgetController } from './budget.controller.js';
import {
  BudgetService,
  EXTRACTION_BUDGET_LIMIT_USD,
  EXTRACTION_BUDGET_PER_USER_LIMIT_USD,
} from './budget.service.js';
import { DATABASE_TOKEN, DB_HANDLE_TOKEN } from '../db/database.module.js';
import { AUTH_SECRET_TOKEN, AuthGuard } from '../auth/auth.guard.js';
import { extractions } from '../db/schema/extractions.js';
import type { Db } from '../db/database.module.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../db/migrations');
const SECRET = 'test-secret-thirty-two-characters-long-aaaa';
const SEED_UPLOAD = 'upl_budget_today';

@Global()
@Module({})
class TestInfraModule {
  static forRoot(db: PostgresJsDatabase): DynamicModule {
    return {
      module: TestInfraModule,
      providers: [
        { provide: DB_HANDLE_TOKEN, useValue: { db, close: async () => {} } },
        { provide: DATABASE_TOKEN, useValue: db },
        { provide: AUTH_SECRET_TOKEN, useValue: SECRET },
        { provide: EXTRACTION_BUDGET_LIMIT_USD, useValue: null },
        { provide: EXTRACTION_BUDGET_PER_USER_LIMIT_USD, useValue: null },
        AuthGuard,
        BudgetService,
      ],
      exports: [
        DATABASE_TOKEN,
        AUTH_SECRET_TOKEN,
        AuthGuard,
        BudgetService,
        EXTRACTION_BUDGET_LIMIT_USD,
        EXTRACTION_BUDGET_PER_USER_LIMIT_USD,
      ],
    };
  }
}

describe('BudgetController GET /budget/today (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let app: NestFastifyApplication;
  let aliceCookie: string;
  let bobCookie: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('vellum_test')
      .withUsername('vellum')
      .withPassword('vellum')
      .start();
    sql = postgres(container.getConnectionUri(), { max: 4 });
    db = drizzle(sql);
    await migrate(db, { migrationsFolder });

    const moduleRef = await Test.createTestingModule({
      imports: [TestInfraModule.forRoot(db)],
      controllers: [BudgetController],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const sign = (sub: string) =>
      encode({ token: { sub }, secret: SECRET, salt: 'authjs.session-token', maxAge: 60 * 60 });
    aliceCookie = `authjs.session-token=${await sign('usr_alice')}`;
    bobCookie = `authjs.session-token=${await sign('usr_bob')}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  beforeEach(async () => {
    await sql`DELETE FROM extractions`;
    await sql`DELETE FROM uploads`;
    await sql`DELETE FROM users WHERE id IN ('usr_alice', 'usr_bob')`;
    await sql`
      INSERT INTO uploads (id, storage_key, mime_type, size_bytes, sha256)
      VALUES (${SEED_UPLOAD}, 'seed-key', 'image/png', 1, repeat('a', 64))
    `;
    await sql`
      INSERT INTO users (id, email)
      VALUES ('usr_alice', 'alice@test'), ('usr_bob', 'bob@test')
    `;
  });

  async function seed(costUsd: string, createdById: string): Promise<void> {
    await (db as unknown as Db).insert(extractions).values({
      uploadId: SEED_UPLOAD,
      provider: 'mock',
      model: 'mock-fixture',
      promptVersion: 'unknown',
      requestHash: Math.random().toString(36).slice(2),
      costEstimatedUsd: costUsd,
      status: 'succeeded',
      createdAt: new Date(),
      createdById,
    });
  }

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/budget/today' });
    expect(res.statusCode).toBe(401);
  });

  it('returns zero spend on a clean day', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/budget/today',
      headers: { cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { spentUsd: string; spentByMeUsd: string; resetAt: string };
    expect(body.spentUsd).toBe('0');
    expect(body.spentByMeUsd).toBe('0');
    expect(body.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });

  it('separates the requesting user spend from the system total', async () => {
    await seed('1.50', 'usr_alice');
    await seed('0.75', 'usr_alice');
    await seed('3.00', 'usr_bob');
    const alice = await app.inject({
      method: 'GET',
      url: '/budget/today',
      headers: { cookie: aliceCookie },
    });
    const bob = await app.inject({
      method: 'GET',
      url: '/budget/today',
      headers: { cookie: bobCookie },
    });
    const aBody = alice.json() as { spentUsd: string; spentByMeUsd: string };
    const bBody = bob.json() as { spentUsd: string; spentByMeUsd: string };
    expect(aBody.spentUsd).toBe('5.250000');
    expect(aBody.spentByMeUsd).toBe('2.250000');
    expect(bBody.spentUsd).toBe('5.250000');
    expect(bBody.spentByMeUsd).toBe('3.000000');
  });

  it('resetAt is tomorrow at UTC midnight', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/budget/today',
      headers: { cookie: aliceCookie },
    });
    const body = res.json() as { resetAt: string };
    const reset = new Date(body.resetAt);
    const now = new Date();
    expect(reset.getUTCHours()).toBe(0);
    expect(reset.getUTCMinutes()).toBe(0);
    expect(reset.getTime()).toBeGreaterThan(now.getTime());
    expect(reset.getTime() - now.getTime()).toBeLessThan(25 * 60 * 60 * 1000);
  });
});
