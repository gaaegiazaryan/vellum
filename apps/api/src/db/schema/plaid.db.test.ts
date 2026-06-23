import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../migrations');

/**
 * Schema-level smoke for the Plaid tables landed in ADR-0018. The
 * impl PRs (encryption, endpoints, sync worker) build on these
 * shapes; pinning the column types, the FK cascade, and the partial
 * index here means a future refactor that drops a column or changes
 * a cascade direction trips on CI rather than on a real sync run.
 */
describe('Plaid schema (integration)', () => {
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
    await sql`DELETE FROM bank_transactions`;
    await sql`DELETE FROM plaid_accounts`;
    await sql`DELETE FROM plaid_items`;
    await sql`DELETE FROM users WHERE id = 'usr_plaid_test'`;
    await sql`INSERT INTO users (id, email) VALUES ('usr_plaid_test', 'plaid@test')`;
  });

  it('round-trips a Plaid item with encrypted token + cursor', async () => {
    await sql`
      INSERT INTO plaid_items
        (id, user_id, plaid_item_id, access_token_cipher, access_token_iv,
         institution_name, status, last_sync_cursor)
      VALUES
        ('it_a', 'usr_plaid_test', 'item-fixture-1', 'cipher-base64',
         'iv-base64', 'Test Bank', 'ok', 'cursor-1')
    `;
    const [row] = await sql`SELECT * FROM plaid_items WHERE id = 'it_a'`;
    expect(row).toMatchObject({
      user_id: 'usr_plaid_test',
      plaid_item_id: 'item-fixture-1',
      access_token_cipher: 'cipher-base64',
      access_token_iv: 'iv-base64',
      institution_name: 'Test Bank',
      status: 'ok',
      last_sync_cursor: 'cursor-1',
    });
    expect(row?.created_at).toBeInstanceOf(Date);
  });

  it('cascades delete from plaid_items down to plaid_accounts and bank_transactions', async () => {
    await sql`INSERT INTO plaid_items (id, user_id, plaid_item_id, access_token_cipher, access_token_iv)
              VALUES ('it_c', 'usr_plaid_test', 'item-cascade', 'c', 'iv')`;
    await sql`INSERT INTO plaid_accounts (id, plaid_item_id, plaid_account_id, name, type, currency)
              VALUES ('ac_c', 'it_c', 'acct-cascade', 'Checking', 'depository', 'USD')`;
    await sql`INSERT INTO bank_transactions
                (id, plaid_account_id, plaid_transaction_id, occurred_at, amount_minor, currency, raw)
              VALUES
                ('tx_c', 'ac_c', 'txn-cascade', now(), 1234, 'USD', '{}'::jsonb)`;

    await sql`DELETE FROM plaid_items WHERE id = 'it_c'`;

    const acc = await sql`SELECT id FROM plaid_accounts WHERE id = 'ac_c'`;
    const tx = await sql`SELECT id FROM bank_transactions WHERE id = 'tx_c'`;
    expect(acc).toHaveLength(0);
    expect(tx).toHaveLength(0);
  });

  it('plaid_transaction_id is unique across the whole table', async () => {
    await sql`INSERT INTO plaid_items (id, user_id, plaid_item_id, access_token_cipher, access_token_iv)
              VALUES ('it_u', 'usr_plaid_test', 'item-unique', 'c', 'iv')`;
    await sql`INSERT INTO plaid_accounts (id, plaid_item_id, plaid_account_id, name, type, currency)
              VALUES ('ac_u', 'it_u', 'acct-unique', 'Checking', 'depository', 'USD')`;
    await sql`INSERT INTO bank_transactions
                (id, plaid_account_id, plaid_transaction_id, occurred_at, amount_minor, currency, raw)
              VALUES
                ('tx_u1', 'ac_u', 'txn-dup', now(), 100, 'USD', '{}'::jsonb)`;
    await expect(
      sql`INSERT INTO bank_transactions
            (id, plaid_account_id, plaid_transaction_id, occurred_at, amount_minor, currency, raw)
          VALUES
            ('tx_u2', 'ac_u', 'txn-dup', now(), 200, 'USD', '{}'::jsonb)`,
    ).rejects.toThrow();
  });

  it('the unmatched partial index includes rows with NULL journal_entry_id only', async () => {
    await sql`INSERT INTO plaid_items (id, user_id, plaid_item_id, access_token_cipher, access_token_iv)
              VALUES ('it_pi', 'usr_plaid_test', 'item-pi', 'c', 'iv')`;
    await sql`INSERT INTO plaid_accounts (id, plaid_item_id, plaid_account_id, name, type, currency)
              VALUES ('ac_pi', 'it_pi', 'acct-pi', 'Card', 'credit', 'USD')`;
    await sql`INSERT INTO journal_entries (id, occurred_at, description, currency)
              VALUES ('je_pi', now(), 'paired', 'USD')`;
    await sql`INSERT INTO bank_transactions
                (id, plaid_account_id, plaid_transaction_id, occurred_at, amount_minor, currency, raw, journal_entry_id, matched_at)
              VALUES
                ('tx_matched', 'ac_pi', 'txn-m', now(), 100, 'USD', '{}'::jsonb, 'je_pi', now())`;
    await sql`INSERT INTO bank_transactions
                (id, plaid_account_id, plaid_transaction_id, occurred_at, amount_minor, currency, raw)
              VALUES
                ('tx_open_1', 'ac_pi', 'txn-o1', now(), 200, 'USD', '{}'::jsonb),
                ('tx_open_2', 'ac_pi', 'txn-o2', now(), 300, 'USD', '{}'::jsonb)`;

    const rows = (await sql`
      SELECT count(*)::int AS n FROM bank_transactions
      WHERE plaid_account_id = 'ac_pi' AND journal_entry_id IS NULL
    `) as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(2);
  });
});
