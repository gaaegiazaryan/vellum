import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres, { type Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, './migrations');

describe('balance trigger (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: Sql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('vellum_test')
      .withUsername('vellum')
      .withPassword('vellum')
      .start();

    sql = postgres(container.getConnectionUri(), { max: 4 });
    await migrate(drizzle(sql), { migrationsFolder });
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  async function makeAccount(code: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO accounts (code, name, type)
      VALUES (${code}, ${'acct ' + code}, 'ASSET')
      RETURNING id
    `;
    if (!row) throw new Error('failed to insert account');
    return row.id;
  }

  async function tryEntry(
    currency: string,
    lines: Array<{ accountId: string; side: 'DEBIT' | 'CREDIT'; amount: number; position: number }>,
  ): Promise<void> {
    await sql.begin(async (tx) => {
      const [entry] = await tx<{ id: string }[]>`
        INSERT INTO journal_entries (occurred_at, description, currency)
        VALUES (now(), ${'test entry'}, ${currency})
        RETURNING id
      `;
      if (!entry) throw new Error('entry insert returned nothing');
      for (const line of lines) {
        await tx`
          INSERT INTO ledger_lines (journal_entry_id, account_id, side, amount, position)
          VALUES (${entry.id}, ${line.accountId}, ${line.side}, ${line.amount}, ${line.position})
        `;
      }
    });
  }

  it('accepts a balanced two-line entry at commit', async () => {
    const cash = await makeAccount(`1000-${Math.random()}`);
    const revenue = await makeAccount(`4000-${Math.random()}`);
    await expect(
      tryEntry('USD', [
        { accountId: cash, side: 'DEBIT', amount: 1000, position: 0 },
        { accountId: revenue, side: 'CREDIT', amount: 1000, position: 1 },
      ]),
    ).resolves.toBeUndefined();
  });

  it('rejects an unbalanced entry at commit', async () => {
    const cash = await makeAccount(`1001-${Math.random()}`);
    const revenue = await makeAccount(`4001-${Math.random()}`);
    await expect(
      tryEntry('USD', [
        { accountId: cash, side: 'DEBIT', amount: 1000, position: 0 },
        { accountId: revenue, side: 'CREDIT', amount: 999, position: 1 },
      ]),
    ).rejects.toThrow(/unbalanced/);
  });

  it('rejects a negative amount at the per-row CHECK', async () => {
    const cash = await makeAccount(`1002-${Math.random()}`);
    const revenue = await makeAccount(`4002-${Math.random()}`);
    await expect(
      tryEntry('USD', [
        { accountId: cash, side: 'DEBIT', amount: -100, position: 0 },
        { accountId: revenue, side: 'CREDIT', amount: -100, position: 1 },
      ]),
    ).rejects.toThrow();
  });

  it('rejects a malformed currency at the per-row CHECK', async () => {
    await expect(sql`
      INSERT INTO journal_entries (occurred_at, description, currency)
      VALUES (now(), 'bad', 'usd')
    `).rejects.toThrow();
  });

  it('accepts an interim-unbalanced transaction that ends balanced', async () => {
    const cash = await makeAccount(`1003-${Math.random()}`);
    const fees = await makeAccount(`5003-${Math.random()}`);
    const revenue = await makeAccount(`4003-${Math.random()}`);
    await expect(
      tryEntry('USD', [
        { accountId: cash, side: 'DEBIT', amount: 700, position: 0 },
        { accountId: fees, side: 'DEBIT', amount: 300, position: 1 },
        { accountId: revenue, side: 'CREDIT', amount: 1000, position: 2 },
      ]),
    ).resolves.toBeUndefined();
  });
});
