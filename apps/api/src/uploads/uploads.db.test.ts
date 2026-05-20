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
import { join } from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { UploadsController } from './uploads.controller.js';
import { UploadsService, MAX_UPLOAD_BYTES } from './uploads.service.js';
import { FilesystemStorage, OBJECT_STORAGE } from './storage.js';
import { DATABASE_TOKEN, DB_HANDLE_TOKEN } from '../db/database.module.js';
import { AUTH_SECRET_TOKEN, AuthGuard } from '../auth/auth.guard.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../db/migrations');
const SECRET = 'test-secret-thirty-two-characters-long-aaaa';

@Global()
@Module({})
class TestInfraModule {
  static forRoot(db: PostgresJsDatabase, storageDir: string): DynamicModule {
    return {
      module: TestInfraModule,
      controllers: [UploadsController],
      providers: [
        { provide: DB_HANDLE_TOKEN, useValue: { db, close: async () => {} } },
        { provide: DATABASE_TOKEN, useValue: db },
        { provide: AUTH_SECRET_TOKEN, useValue: SECRET },
        { provide: OBJECT_STORAGE, useValue: new FilesystemStorage(storageDir) },
        AuthGuard,
        UploadsService,
        IdempotencyService,
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
      exports: [DATABASE_TOKEN, AUTH_SECRET_TOKEN, OBJECT_STORAGE, UploadsService],
    };
  }
}

describe('UploadsController POST /uploads (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;
  let app: NestFastifyApplication;
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

    const storageDir = await mkdtemp(join(tmpdir(), 'vellum-uploads-test-'));

    const moduleRef = await Test.createTestingModule({
      imports: [TestInfraModule.forRoot(db, storageDir)],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.register(fastifyMultipart, {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    });
    await app.getHttpAdapter().getInstance().ready();

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

  function multipartPayload(buffer: Buffer, filename: string, contentType: string) {
    const boundary = '----vellumtest';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return {
      headers: {
        cookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([head, buffer, tail]),
    };
  }

  it('rejects unauthenticated', async () => {
    const res = await app.inject({ method: 'POST', url: '/uploads' });
    expect(res.statusCode).toBe(401);
  });

  it('stores a small png and returns the metadata', async () => {
    const bytes = Buffer.from('fake-png-bytes');
    const res = await app.inject({
      method: 'POST',
      url: '/uploads',
      ...multipartPayload(bytes, 'receipt.png', 'image/png'),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      mimeType: string;
      sizeBytes: string;
      sha256: string;
    };
    expect(body.mimeType).toBe('image/png');
    expect(body.sizeBytes).toBe(String(bytes.length));
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);

    const get = await app.inject({
      method: 'GET',
      url: `/uploads/${body.id}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);

    const bytesRes = await app.inject({
      method: 'GET',
      url: `/uploads/${body.id}/bytes`,
      headers: { cookie },
    });
    expect(bytesRes.statusCode).toBe(200);
    expect(bytesRes.headers['content-type']).toBe('image/png');
    expect(bytesRes.rawPayload.equals(bytes)).toBe(true);
  });

  it('rejects unsupported mime type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/uploads',
      ...multipartPayload(Buffer.from('gif'), 'x.gif', 'image/gif'),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('unsupported_mime_type');
  });

  it('returns 404 for an unknown upload id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/uploads/11111111-1111-4111-8111-111111111111',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
