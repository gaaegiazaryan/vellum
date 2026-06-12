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

async function seedExtraction(
  db: Db,
  costUsd: string,
  createdAt: Date,
  createdById: string | null = null,
): Promise<void> {
  await db.insert(extractions).values({
    uploadId: SEED_UPLOAD_ID,
    provider: 'mock',
    model: 'mock-fixture',
    promptVersion: 'unknown',
    requestHash: Math.random().toString(36).slice(2),
    costEstimatedUsd: costUsd,
    status: 'succeeded',
    createdAt,
    createdById,
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
    await sql`DELETE FROM users WHERE id IN ('usr_alice', 'usr_bob')`;
    await sql`
      INSERT INTO uploads (id, storage_key, mime_type, size_bytes, sha256)
      VALUES (${SEED_UPLOAD_ID}, 'seed-key', 'image/png', 1, repeat('a', 64))
    `;
    await sql`
      INSERT INTO users (id, email)
      VALUES ('usr_alice', 'alice@test'), ('usr_bob', 'bob@test')
      ON CONFLICT (id) DO NOTHING
    `;
  });

  it('does nothing when no limit is configured', async () => {
    const svc = new BudgetService(db as unknown as Db, null, null);
    expect(svc.isEnforced()).toBe(false);
    await seedExtraction(db as unknown as Db, '999.999999', new Date());
    await expect(svc.assertWithinBudget()).resolves.toBeUndefined();
  });

  it('returns todaySpend as a sum over rows since UTC midnight', async () => {
    const svc = new BudgetService(db as unknown as Db, '10', null);
    await seedExtraction(db as unknown as Db, '1.23', new Date());
    await seedExtraction(db as unknown as Db, '0.5', new Date());
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await seedExtraction(db as unknown as Db, '100', yesterday);

    const total = await svc.todaySpendUsd();
    expect(total).toBe('1.730000');
  });

  it('throws BudgetExceededError when today reaches the cap', async () => {
    const svc = new BudgetService(db as unknown as Db, '2', null);
    await seedExtraction(db as unknown as Db, '1.99', new Date());
    await expect(svc.assertWithinBudget()).resolves.toBeUndefined();

    await seedExtraction(db as unknown as Db, '0.02', new Date());
    await expect(svc.assertWithinBudget()).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('ignores spend from earlier UTC days', async () => {
    const svc = new BudgetService(db as unknown as Db, '0.5', null);
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await seedExtraction(db as unknown as Db, '999', yesterday);
    await expect(svc.assertWithinBudget()).resolves.toBeUndefined();
  });

  it('compares decimals exactly without float drift', async () => {
    const svc = new BudgetService(db as unknown as Db, '0.1', null);
    await seedExtraction(db as unknown as Db, '0.099999', new Date());
    await expect(svc.assertWithinBudget()).resolves.toBeUndefined();
    await seedExtraction(db as unknown as Db, '0.000001', new Date());
    await expect(svc.assertWithinBudget()).rejects.toBeInstanceOf(BudgetExceededError);
  });

  describe('per-user cap (ADR-0014)', () => {
    it('sums per-user spend independently of other users', async () => {
      const svc = new BudgetService(db as unknown as Db, null, '5');
      await seedExtraction(db as unknown as Db, '0.50', new Date(), 'usr_alice');
      await seedExtraction(db as unknown as Db, '0.30', new Date(), 'usr_alice');
      await seedExtraction(db as unknown as Db, '4.99', new Date(), 'usr_bob');
      expect(await svc.todaySpendUsdByUser('usr_alice')).toBe('0.800000');
      expect(await svc.todaySpendUsdByUser('usr_bob')).toBe('4.990000');
    });

    it('blocks the user who exceeded the per-user cap', async () => {
      const svc = new BudgetService(db as unknown as Db, null, '1');
      await seedExtraction(db as unknown as Db, '0.99', new Date(), 'usr_alice');
      await expect(svc.assertWithinBudget('usr_alice')).resolves.toBeUndefined();
      await seedExtraction(db as unknown as Db, '0.02', new Date(), 'usr_alice');
      await expect(svc.assertWithinBudget('usr_alice')).rejects.toMatchObject({
        scope: 'user',
        limitUsd: '1',
      });
    });

    it('lets other users through even when one user is over their cap', async () => {
      const svc = new BudgetService(db as unknown as Db, null, '1');
      await seedExtraction(db as unknown as Db, '5', new Date(), 'usr_alice');
      await expect(svc.assertWithinBudget('usr_alice')).rejects.toMatchObject({ scope: 'user' });
      await expect(svc.assertWithinBudget('usr_bob')).resolves.toBeUndefined();
    });

    it('checks the user cap before the system cap when both are set', async () => {
      const svc = new BudgetService(db as unknown as Db, '100', '1');
      await seedExtraction(db as unknown as Db, '1.5', new Date(), 'usr_alice');
      await expect(svc.assertWithinBudget('usr_alice')).rejects.toMatchObject({ scope: 'user' });
    });

    it('falls through to the system cap when the user cap is configured but userId is missing', async () => {
      const svc = new BudgetService(db as unknown as Db, '2', '1');
      await seedExtraction(db as unknown as Db, '2.5', new Date(), 'usr_alice');
      await expect(svc.assertWithinBudget(null)).rejects.toMatchObject({ scope: 'system' });
    });

    it('ignores per-user spend from earlier UTC days', async () => {
      const svc = new BudgetService(db as unknown as Db, null, '1');
      const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await seedExtraction(db as unknown as Db, '999', yesterday, 'usr_alice');
      await expect(svc.assertWithinBudget('usr_alice')).resolves.toBeUndefined();
    });
  });

  describe('predicted-cost gate', () => {
    it('blocks when spent + predicted would breach the system cap even though spent is under', async () => {
      const svc = new BudgetService(db as unknown as Db, '1', null);
      await seedExtraction(db as unknown as Db, '0.95', new Date());
      // Without prediction, this passes (0.95 < 1).
      await expect(svc.assertWithinBudget()).resolves.toBeUndefined();
      // With a 0.10 prediction the in-flight call would tip the cap.
      await expect(svc.assertWithinBudget(null, '0.10')).rejects.toMatchObject({
        scope: 'system',
        limitUsd: '1',
      });
    });

    it('blocks when spent + predicted would breach the per-user cap', async () => {
      const svc = new BudgetService(db as unknown as Db, null, '0.5');
      await seedExtraction(db as unknown as Db, '0.45', new Date(), 'usr_alice');
      await expect(svc.assertWithinBudget('usr_alice')).resolves.toBeUndefined();
      await expect(svc.assertWithinBudget('usr_alice', '0.10')).rejects.toMatchObject({
        scope: 'user',
      });
    });

    it('treats predicted = 0 as the old spent-only check', async () => {
      const svc = new BudgetService(db as unknown as Db, '1', null);
      await seedExtraction(db as unknown as Db, '0.99', new Date());
      await expect(svc.assertWithinBudget(null, '0')).resolves.toBeUndefined();
    });

    it('does not enforce when neither cap is configured', async () => {
      const svc = new BudgetService(db as unknown as Db, null, null);
      await expect(svc.assertWithinBudget('usr_alice', '999')).resolves.toBeUndefined();
    });
  });
});
