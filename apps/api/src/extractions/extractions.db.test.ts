import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Queue } from 'bullmq';
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
import { ExtractionWorker } from './extraction.worker.js';
import {
  EXTRACTION_QUEUE,
  EXTRACTION_QUEUE_NAME,
  QUEUE_REDIS_URL,
  createRedisConnection,
} from '../queue/queue.module.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { FilesystemStorage, OBJECT_STORAGE } from '../uploads/storage.js';
import { DATABASE_TOKEN, DB_HANDLE_TOKEN } from '../db/database.module.js';
import { AUTH_SECRET_TOKEN, AuthGuard } from '../auth/auth.guard.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../db/migrations');
const SECRET = 'test-secret-thirty-two-characters-long-aaaa';
const EXPENSE_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const CASH_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

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
    redisUrl: string,
    queue: Queue,
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
        { provide: EXTRACTION_QUEUE, useValue: queue },
        { provide: QUEUE_REDIS_URL, useValue: redisUrl },
        AuthGuard,
        UploadsService,
        ExtractionsService,
        ExtractionWorker,
        IdempotencyService,
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
      exports: [DATABASE_TOKEN, OBJECT_STORAGE, EXTRACTION_PROVIDER, UploadsService],
    };
  }
}

interface ExtractionBody {
  id: string;
  uploadId: string;
  provider: string;
  status: 'pending' | 'succeeded' | 'failed' | 'needs_review';
  confidence: string | null;
  receipt: { vendor: { name: string }; totalMinor: string } | null;
  costEstimatedUsd: string;
  errorCode: string | null;
}

describe('ExtractionsController POST /extractions (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let queue: Queue;
  let queueConnection: ReturnType<typeof createRedisConnection>;
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
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

    sql = postgres(container.getConnectionUri(), { max: 4 });
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder });
    await sql`INSERT INTO users (id, email) VALUES ('usr_test', 'test@example.com')`;
    await sql`
      INSERT INTO accounts (id, code, name, type) VALUES
        (${EXPENSE_ACCOUNT_ID}, '5000', 'Office Supplies', 'EXPENSE'),
        (${CASH_ACCOUNT_ID}, '1000', 'Cash', 'ASSET')
    `;

    const storageDir = await mkdtemp(join(tmpdir(), 'vellum-extractions-test-'));
    provider = new MockProvider();

    queueConnection = createRedisConnection(redisUrl);
    queue = new Queue(EXTRACTION_QUEUE_NAME, { connection: queueConnection });

    const moduleRef = await Test.createTestingModule({
      imports: [TestInfraModule.forRoot(db, storageDir, provider, redisUrl, queue)],
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
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await queue?.close();
    await queueConnection?.quit();
    await sql?.end({ timeout: 5 });
    await redis?.stop();
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

  function get(id: string) {
    return app.inject({ method: 'GET', url: `/extractions/${id}`, headers: { cookie } });
  }

  async function pollUntilTerminal(id: string, timeoutMs = 20_000): Promise<ExtractionBody> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const body = get(id).then((r) => r.json() as ExtractionBody);
      const row = await body;
      if (row.status !== 'pending') return row;
      if (Date.now() > deadline) {
        throw new Error(`extraction ${id} still pending after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  it('rejects unauthenticated', async () => {
    const res = await app.inject({ method: 'POST', url: '/extractions', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the request and returns a pending extraction', async () => {
    const upload = await stageUploadWithFixture(`pending-${Math.random()}`);
    const res = await post({ uploadId: upload.id }, `idem-pending-${Math.random()}`);
    expect(res.statusCode).toBe(202);
    const row = res.json() as ExtractionBody;
    expect(row.uploadId).toBe(upload.id);
    expect(row.status).toBe('pending');
    expect(row.receipt).toBeNull();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the worker extracts a staged upload to succeeded', async () => {
    const upload = await stageUploadWithFixture(`fixture-bytes-${Math.random()}`);
    const res = await post({ uploadId: upload.id }, `idem-ok-${Math.random()}`);
    expect(res.statusCode).toBe(202);
    const row = await pollUntilTerminal((res.json() as ExtractionBody).id);
    expect(row.status).toBe('succeeded');
    expect(row.provider).toBe('mock');
    expect(row.confidence).toBe('0.950');
    expect(row.receipt?.vendor.name).toBe('Blue Bottle');
    expect(row.receipt?.totalMinor).toBe('979');
  });

  it('marks low-confidence extractions as needs_review', async () => {
    const upload = await stageUploadWithFixture(`low-conf-${Math.random()}`, 0.55);
    const res = await post({ uploadId: upload.id }, `idem-needs-review-${Math.random()}`);
    expect(res.statusCode).toBe(202);
    const row = await pollUntilTerminal((res.json() as ExtractionBody).id);
    expect(row.status).toBe('needs_review');
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

  it('dedupes via request_hash: a second request returns the same extraction id', async () => {
    const upload = await stageUploadWithFixture(`cache-${Math.random()}`);
    const a = await post({ uploadId: upload.id }, `idem-cache-a-${Math.random()}`);
    expect(a.statusCode).toBe(202);
    const idA = (a.json() as ExtractionBody).id;

    const b = await post({ uploadId: upload.id }, `idem-cache-b-${Math.random()}`);
    expect(b.statusCode).toBe(202);
    expect((b.json() as ExtractionBody).id).toBe(idA);
  });

  it('records a failed extraction when the model cannot read the image', async () => {
    const upload = await uploadsService.create({
      buffer: Buffer.from(`unstaged-${Math.random()}`),
      mimeType: 'image/png',
      userId: 'usr_test',
    });
    // No fixture staged for this image, so MockProvider throws a
    // deterministic (non-retryable) error; the worker records failure.
    const res = await post({ uploadId: upload.id }, `idem-fail-${Math.random()}`);
    expect(res.statusCode).toBe(202);
    const row = await pollUntilTerminal((res.json() as ExtractionBody).id);
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('InvalidProviderResponseError');
  });

  function confirmPost(id: string, body: Record<string, unknown>, key: string) {
    return app.inject({
      method: 'POST',
      url: `/extractions/${id}/confirm`,
      headers: { cookie, 'idempotency-key': key, 'content-type': 'application/json' },
      payload: body,
    });
  }

  async function createSucceededExtraction(seed: string): Promise<string> {
    const upload = await stageUploadWithFixture(seed);
    const res = await post({ uploadId: upload.id }, `idem-seed-${seed}`);
    expect(res.statusCode).toBe(202);
    const id = (res.json() as ExtractionBody).id;
    const row = await pollUntilTerminal(id);
    expect(row.status).toBe('succeeded');
    return id;
  }

  it('confirms a succeeded extraction into a balanced journal entry', async () => {
    const id = await createSucceededExtraction(`confirm-${Math.random()}`);
    const res = await confirmPost(
      id,
      { debitAccountId: EXPENSE_ACCOUNT_ID, creditAccountId: CASH_ACCOUNT_ID },
      `idem-confirm-${Math.random()}`,
    );
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      extraction: { id: string; journalEntryId: string | null; confirmedAt: string | null };
      journalEntry: { id: string; description: string; currency: string };
    };
    expect(body.journalEntry.description).toBe('Blue Bottle');
    expect(body.journalEntry.currency).toBe('USD');
    expect(body.extraction.journalEntryId).toBe(body.journalEntry.id);
    expect(body.extraction.confirmedAt).not.toBeNull();

    const lines = await sql`
      SELECT side, amount FROM ledger_lines
      WHERE journal_entry_id = ${body.journalEntry.id}
      ORDER BY position
    `;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ side: 'DEBIT', amount: '979' });
    expect(lines[1]).toMatchObject({ side: 'CREDIT', amount: '979' });
  });

  it('uses a custom description when provided', async () => {
    const id = await createSucceededExtraction(`confirm-desc-${Math.random()}`);
    const res = await confirmPost(
      id,
      {
        debitAccountId: EXPENSE_ACCOUNT_ID,
        creditAccountId: CASH_ACCOUNT_ID,
        description: 'Team coffee run',
      },
      `idem-confirm-desc-${Math.random()}`,
    );
    expect(res.statusCode).toBe(201);
    expect((res.json() as { journalEntry: { description: string } }).journalEntry.description).toBe(
      'Team coffee run',
    );
  });

  it('posts the overridden total, date, and currency instead of the parsed receipt', async () => {
    const id = await createSucceededExtraction(`confirm-override-${Math.random()}`);
    const res = await confirmPost(
      id,
      {
        debitAccountId: EXPENSE_ACCOUNT_ID,
        creditAccountId: CASH_ACCOUNT_ID,
        totalMinor: '1200',
        occurredAt: '2026-05-19T00:00:00Z',
        currency: 'EUR',
      },
      `idem-override-${Math.random()}`,
    );
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      journalEntry: { id: string; currency: string; occurredAt: string };
    };
    expect(body.journalEntry.currency).toBe('EUR');
    expect(new Date(body.journalEntry.occurredAt).toISOString()).toBe('2026-05-19T00:00:00.000Z');

    const lines = await sql`
      SELECT amount FROM ledger_lines WHERE journal_entry_id = ${body.journalEntry.id}
    `;
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.amount === '1200')).toBe(true);
  });

  it('rejects an override total that is not a positive integer', async () => {
    const id = await createSucceededExtraction(`confirm-badtotal-${Math.random()}`);
    const bad = await confirmPost(
      id,
      { debitAccountId: EXPENSE_ACCOUNT_ID, creditAccountId: CASH_ACCOUNT_ID, totalMinor: '-5' },
      `idem-badtotal-${Math.random()}`,
    );
    expect(bad.statusCode).toBe(400);

    const zero = await confirmPost(
      id,
      { debitAccountId: EXPENSE_ACCOUNT_ID, creditAccountId: CASH_ACCOUNT_ID, totalMinor: '0' },
      `idem-zerototal-${Math.random()}`,
    );
    expect(zero.statusCode).toBe(422);
    expect((zero.json() as { error: string }).error).toBe('non_positive_total');
  });

  it('leaves the stored receipt untouched after an override confirm', async () => {
    const id = await createSucceededExtraction(`confirm-immutable-${Math.random()}`);
    const res = await confirmPost(
      id,
      { debitAccountId: EXPENSE_ACCOUNT_ID, creditAccountId: CASH_ACCOUNT_ID, totalMinor: '5000' },
      `idem-immutable-${Math.random()}`,
    );
    expect(res.statusCode).toBe(201);
    const [row] = await sql`SELECT receipt FROM extractions WHERE id = ${id}`;
    expect((row?.receipt as { totalMinor: string }).totalMinor).toBe('979');
  });

  it('rejects confirming the same extraction twice', async () => {
    const id = await createSucceededExtraction(`confirm-twice-${Math.random()}`);
    const first = await confirmPost(
      id,
      { debitAccountId: EXPENSE_ACCOUNT_ID, creditAccountId: CASH_ACCOUNT_ID },
      `idem-twice-a-${Math.random()}`,
    );
    expect(first.statusCode).toBe(201);

    const second = await confirmPost(
      id,
      { debitAccountId: EXPENSE_ACCOUNT_ID, creditAccountId: CASH_ACCOUNT_ID },
      `idem-twice-b-${Math.random()}`,
    );
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: string }).error).toBe('already_confirmed');
  });

  it('rejects equal debit and credit accounts', async () => {
    const id = await createSucceededExtraction(`confirm-same-${Math.random()}`);
    const res = await confirmPost(
      id,
      { debitAccountId: EXPENSE_ACCOUNT_ID, creditAccountId: EXPENSE_ACCOUNT_ID },
      `idem-same-${Math.random()}`,
    );
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('same_account');
  });

  it('returns 404 confirming an unknown extraction id', async () => {
    const res = await confirmPost(
      '44444444-4444-4444-8444-444444444444',
      { debitAccountId: EXPENSE_ACCOUNT_ID, creditAccountId: CASH_ACCOUNT_ID },
      `idem-unknown-${Math.random()}`,
    );
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when an account does not exist', async () => {
    const id = await createSucceededExtraction(`confirm-noacct-${Math.random()}`);
    const res = await confirmPost(
      id,
      {
        debitAccountId: EXPENSE_ACCOUNT_ID,
        creditAccountId: '55555555-5555-4555-8555-555555555555',
      },
      `idem-noacct-${Math.random()}`,
    );
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('account_not_found');
  });

  it('refuses to confirm a failed extraction', async () => {
    const upload = await uploadsService.create({
      buffer: Buffer.from(`confirm-failed-${Math.random()}`),
      mimeType: 'image/png',
      userId: 'usr_test',
    });
    const accepted = await post({ uploadId: upload.id }, `idem-failrec-${Math.random()}`);
    expect(accepted.statusCode).toBe(202);
    const failedId = (accepted.json() as ExtractionBody).id;
    const failedRow = await pollUntilTerminal(failedId);
    expect(failedRow.status).toBe('failed');

    const res = await confirmPost(
      failedId,
      { debitAccountId: EXPENSE_ACCOUNT_ID, creditAccountId: CASH_ACCOUNT_ID },
      `idem-confirm-failed-${Math.random()}`,
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('not_confirmable');
  });
});
