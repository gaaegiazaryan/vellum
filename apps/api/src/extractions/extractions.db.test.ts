import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { encode } from '@auth/core/jwt';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { receiptSchema } from '@vellum/extraction';
import { MockProvider } from '@vellum/extraction/providers/mock';
import { ExtractionsController } from './extractions.controller.js';
import { ExtractionsService, EXTRACTION_PROVIDER } from './extractions.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { FilesystemStorage, OBJECT_STORAGE } from '../uploads/storage.js';
import { DATABASE_TOKEN, DB_HANDLE_TOKEN } from '../db/database.module.js';
import { AUTH_SECRET_TOKEN, AuthGuard } from '../auth/auth.guard.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../db/migrations');
const SECRET = 'test-secret-thirty-two-characters-long-aaaa';

const sampleReceipt = receiptSchema.parse({
  vendor: { name: 'Blue Bottle' },
  occurredAt: '2026-05-20T08:00:00Z',
  currency: 'USD',
  subtotalMinor: '900',
  taxes: [{ name: 'tax', amountMinor: '79' }],
  totalMinor: '979',
  paymentMethod: 'card',
  lineItems: [{ description: 'cappuccino', quantity: 2, unitPriceMinor: '450', totalMinor: '900' }],
});

@Global()
@Module({})
class TestInfraModule {
  static forRoot(
    db: PostgresJsDatabase,
    storageDir: string,
    provider: MockProvider,
  ): DynamicModule {
    return {
      module: TestInfraModule,
      controllers: [ExtractionsController],
      providers: [
        { provide: DB_HANDLE_TOKEN, useValue: { db, close: async () => {} } },
        { provide: DATABASE_TOKEN, useValue: db },
        { provide: AUTH_SECRET_TOKEN, useValue: SECRET },
        { provide: OBJECT_STORAGE, useValue: new FilesystemStorage(storageDir) },
        { provide: EXTRACTION_PROVIDER, useValue: provider },
        AuthGuard,
        UploadsService,
        ExtractionsService,
        IdempotencyService,
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
      exports: [DATABASE_TOKEN, OBJECT_STORAGE, EXTRACTION_PROVIDER, UploadsService],
    };
  }
}

describe('ExtractionsController POST /extractions (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;
  let app: NestFastifyApplication;
  let provider: MockProvider;
  let uploadsService: UploadsService;
  let cookie: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('vellum_test')
      .withUsername('vellum')
      .withPassword('vellum')
      .start();
    sql = postgres(container.getConnectionUri(), { max: 4 });
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder });
    await sql`INSERT INTO users (id, email) VALUES ('usr_test', 'test@example.com')`;

    const storageDir = await mkdtemp(join(tmpdir(), 'vellum-extractions-test-'));
    provider = new MockProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [TestInfraModule.forRoot(db, storageDir, provider)],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    uploadsService = moduleRef.get(UploadsService);

    const token = await encode({
      token: { sub: 'usr_test', email: 'test@example.com' },
      secret: SECRET,
      salt: 'authjs.session-token',
      maxAge: 60 * 60,
    });
    cookie = `authjs.session-token=${token}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  async function stageUploadWithFixture(content: string, confidence = 0.95) {
    const buffer = Buffer.from(content);
    const upload = await uploadsService.create({
      buffer,
      mimeType: 'image/png',
      userId: 'usr_test',
    });
    provider.stage(buffer.toString('base64'), { receipt: sampleReceipt, confidence });
    return upload;
  }

  function post(body: Record<string, unknown>, key: string) {
    return app.inject({
      method: 'POST',
      url: '/extractions',
      headers: { cookie, 'idempotency-key': key, 'content-type': 'application/json' },
      payload: body,
    });
  }

  it('rejects unauthenticated', async () => {
    const res = await app.inject({ method: 'POST', url: '/extractions', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('extracts a staged upload and returns the row', async () => {
    const upload = await stageUploadWithFixture(`fixture-bytes-${Math.random()}`);
    const res = await post({ uploadId: upload.id }, `idem-ok-${Math.random()}`);
    expect(res.statusCode).toBe(201);
    const row = res.json() as {
      uploadId: string;
      provider: string;
      status: string;
      confidence: string | null;
      receipt: { vendor: { name: string }; totalMinor: string };
      costEstimatedUsd: string;
    };
    expect(row.uploadId).toBe(upload.id);
    expect(row.provider).toBe('mock');
    expect(row.status).toBe('succeeded');
    expect(row.confidence).toBe('0.950');
    expect(row.receipt.vendor.name).toBe('Blue Bottle');
    expect(row.receipt.totalMinor).toBe('979');
  });

  it('marks low-confidence extractions as needs_review', async () => {
    const upload = await stageUploadWithFixture(`low-conf-${Math.random()}`, 0.55);
    const res = await post({ uploadId: upload.id }, `idem-needs-review-${Math.random()}`);
    expect(res.statusCode).toBe(201);
    expect((res.json() as { status: string }).status).toBe('needs_review');
  });

  it('returns 404 when uploadId does not exist', async () => {
    const res = await post(
      { uploadId: '11111111-1111-4111-8111-111111111111' },
      `idem-missing-upload-${Math.random()}`,
    );
    expect(res.statusCode).toBe(404);
  });

  it('rejects malformed body with 400', async () => {
    const res = await post({ uploadId: 'not-a-uuid' }, `idem-bad-body-${Math.random()}`);
    expect(res.statusCode).toBe(400);
  });

  it('caches via request_hash: second call returns the same extraction id', async () => {
    const upload = await stageUploadWithFixture(`cache-${Math.random()}`);
    const a = await post({ uploadId: upload.id }, `idem-cache-a-${Math.random()}`);
    expect(a.statusCode).toBe(201);
    const idA = (a.json() as { id: string }).id;

    const b = await post({ uploadId: upload.id }, `idem-cache-b-${Math.random()}`);
    expect(b.statusCode).toBe(201);
    expect((b.json() as { id: string }).id).toBe(idA);
  });

  it('records failure with extraction_failed when provider throws', async () => {
    const upload = await uploadsService.create({
      buffer: Buffer.from(`unstaged-${Math.random()}`),
      mimeType: 'image/png',
      userId: 'usr_test',
    });
    // Provider has no fixture staged for this image, MockProvider throws
    const res = await post({ uploadId: upload.id }, `idem-fail-${Math.random()}`);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('extraction_failed');
  });
});
