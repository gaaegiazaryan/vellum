import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { BudgetExceededError } from '@vellum/extraction';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetService } from './budget.service.js';
import type { Db } from '../db/database.module.js';
import { extractions } from '../db/schema/extractions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../db/migrations');

const SEED_UPLOAD_ID = 'upl_seed';

async function seedExtraction(db: Db, costUsd: string, createdAt: Date): Promise<void> {
  await db.insert(extractions).values({
    uploadId: SEED_UPLOAD_ID,
    provider: 'mock',
    model: 'mock-fixture',
    promptVersion: 'unknown',
    requestHash: Math.random().toString(36).slice(2),
    costEstimatedUsd: costUsd,
    status: 'succeeded',
    createdAt,
  });
}

describe('BudgetService (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('vellum_test')
      .withUsername('vellum')
      .withPassword('vellum')
      .start();
    sql = postgres(container.getConnectionUri(), { max: 4 });
    db = drizzle(sql);
    await migrate(db, { migrationsFolder });
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
      VALUES (${SEED_UPLOAD_ID}, 'seed-key', 'image/png', 1, repeat('a', 64))
    `;
  });

  it('does nothing when no limit is configured', async () => {
    const svc = new BudgetService(db as unknown as Db, null);
    expect(svc.isEnforced()).toBe(false);
    await seedExtraction(db as unknown as Db, '999.999999', new Date());
    await expect(svc.assertWithinBudget()).resolves.toBeUndefined();
  });

  it('returns todaySpend as a sum over rows since UTC midnight', async () => {
    const svc = new BudgetService(db as unknown as Db, '10');
    await seedExtraction(db as unknown as Db, '1.23', new Date());
    await seedExtraction(db as unknown as Db, '0.5', new Date());
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await seedExtraction(db as unknown as Db, '100', yesterday);

    const total = await svc.todaySpendUsd();
    expect(total).toBe('1.730000');
  });

  it('throws BudgetExceededError when today reaches the cap', async () => {
    const svc = new BudgetService(db as unknown as Db, '2');
    await seedExtraction(db as unknown as Db, '1.99', new Date());
    await expect(svc.assertWithinBudget()).resolves.toBeUndefined();

    await seedExtraction(db as unknown as Db, '0.02', new Date());
    await expect(svc.assertWithinBudget()).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('ignores spend from earlier UTC days', async () => {
    const svc = new BudgetService(db as unknown as Db, '0.5');
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await seedExtraction(db as unknown as Db, '999', yesterday);
    await expect(svc.assertWithinBudget()).resolves.toBeUndefined();
  });

  it('compares decimals exactly without float drift', async () => {
    const svc = new BudgetService(db as unknown as Db, '0.1');
    await seedExtraction(db as unknown as Db, '0.099999', new Date());
    await expect(svc.assertWithinBudget()).resolves.toBeUndefined();
    await seedExtraction(db as unknown as Db, '0.000001', new Date());
    await expect(svc.assertWithinBudget()).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
