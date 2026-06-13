import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtractionsService } from './extractions.service.js';
import type { Db } from '../db/database.module.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../db/migrations');

const SEED_UPLOAD = 'upl_fallback_stats';

interface SeedRow {
  id: string;
  createdAt: Date;
  fallbackFromProvider: string | null;
  fallbackReason: string | null;
}

async function seed(sql: ReturnType<typeof postgres>, rows: SeedRow[]): Promise<void> {
  for (const r of rows) {
    const createdAt = r.createdAt.toISOString();
    await sql`
      INSERT INTO extractions
        (id, upload_id, provider, model, prompt_version, request_hash,
         status, created_at, fallback_from_provider, fallback_reason)
      VALUES
        (${r.id}, ${SEED_UPLOAD}, 'mock', 'mock-fixture', 'unknown', ${r.id + '-h'},
         'succeeded', ${createdAt}::timestamptz,
         ${r.fallbackFromProvider}, ${r.fallbackReason})
    `;
  }
}

// Stand the service up with hand-injected nulls for every dep
// fallbackStats does not touch (provider, queue, events, uploads,
// budget). Construction without DI keeps the suite fast.
function bareService(db: Db): ExtractionsService {
  return new ExtractionsService(
    db,
    null as never,
    null as never,
    0.7,
    null as never,
    null as never,
    null as never,
  );
}

describe('ExtractionsService.fallbackStats (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let svc: ExtractionsService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('vellum_test')
      .withUsername('vellum')
      .withPassword('vellum')
      .start();
    sql = postgres(container.getConnectionUri(), { max: 4 });
    db = drizzle(sql);
    await migrate(db, { migrationsFolder });
    svc = bareService(db as unknown as Db);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  beforeEach(async () => {
    await sql`DELETE FROM extractions`;
    await sql`DELETE FROM uploads`;
    await sql`
      INSERT INTO uploads (id, storage_key, mime_type, size_bytes, sha256)
      VALUES (${SEED_UPLOAD}, 'seed-key', 'image/png', 1, repeat('a', 64))
    `;
  });

  const day = new Date('2026-06-13T00:00:00Z');
  const dayEnd = new Date('2026-06-14T00:00:00Z');

  it('reports zero on an empty window', async () => {
    const stats = await svc.fallbackStats(day, dayEnd);
    expect(stats).toEqual({
      total: 0,
      fellBack: 0,
      byReason: {},
      byPrimary: {},
      since: day.toISOString(),
      until: dayEnd.toISOString(),
    });
  });

  it('counts total separately from fellBack and groups by reason and primary', async () => {
    await seed(sql, [
      {
        id: 'e1',
        createdAt: new Date('2026-06-13T10:00:00Z'),
        fallbackFromProvider: null,
        fallbackReason: null,
      },
      {
        id: 'e2',
        createdAt: new Date('2026-06-13T11:00:00Z'),
        fallbackFromProvider: null,
        fallbackReason: null,
      },
      {
        id: 'e3',
        createdAt: new Date('2026-06-13T12:00:00Z'),
        fallbackFromProvider: 'anthropic',
        fallbackReason: 'ProviderTimeoutError',
      },
      {
        id: 'e4',
        createdAt: new Date('2026-06-13T13:00:00Z'),
        fallbackFromProvider: 'anthropic',
        fallbackReason: 'ProviderTimeoutError',
      },
      {
        id: 'e5',
        createdAt: new Date('2026-06-13T14:00:00Z'),
        fallbackFromProvider: 'anthropic',
        fallbackReason: 'InvalidProviderResponseError',
      },
      {
        id: 'e6',
        createdAt: new Date('2026-06-13T15:00:00Z'),
        fallbackFromProvider: 'openai',
        fallbackReason: 'ProviderTimeoutError',
      },
    ]);
    const stats = await svc.fallbackStats(day, dayEnd);
    expect(stats.total).toBe(6);
    expect(stats.fellBack).toBe(4);
    expect(stats.byReason).toEqual({
      ProviderTimeoutError: 3,
      InvalidProviderResponseError: 1,
    });
    expect(stats.byPrimary).toEqual({ anthropic: 3, openai: 1 });
  });

  it('excludes rows outside the window', async () => {
    await seed(sql, [
      {
        id: 'before',
        createdAt: new Date('2026-06-12T23:59:59Z'),
        fallbackFromProvider: 'anthropic',
        fallbackReason: 'ProviderTimeoutError',
      },
      {
        id: 'inside',
        createdAt: new Date('2026-06-13T00:00:00Z'),
        fallbackFromProvider: 'anthropic',
        fallbackReason: 'ProviderTimeoutError',
      },
      {
        id: 'at-boundary',
        createdAt: new Date('2026-06-14T00:00:00Z'),
        fallbackFromProvider: 'anthropic',
        fallbackReason: 'ProviderTimeoutError',
      },
    ]);
    const stats = await svc.fallbackStats(day, dayEnd);
    expect(stats.total).toBe(1);
    expect(stats.fellBack).toBe(1);
    expect(stats.byReason).toEqual({ ProviderTimeoutError: 1 });
  });
});
