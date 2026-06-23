import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaidApi } from 'plaid';
import { schema, type Db } from '../db/client.js';
import { PlaidService } from './plaid.service.js';
import { TokenCipher } from './token-cipher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../db/migrations');

const SECRET = 'a'.repeat(48);
const USER = 'usr_plaid_svc';

interface MockPlaidOptions {
  exchange?: { access_token: string; item_id: string };
  accounts?: {
    item: { institution_id: string | null };
    accounts: Array<{
      account_id: string;
      name: string;
      official_name: string | null;
      type: string;
      subtype: string | null;
      mask: string | null;
      balances: {
        current: number | null;
        iso_currency_code: string | null;
        unofficial_currency_code: string | null;
      };
    }>;
  };
  institution?: { name: string };
  itemRemove?: Array<{ access_token: string }>;
}

function mockPlaid(opts: MockPlaidOptions): PlaidApi {
  return {
    itemPublicTokenExchange: async () => ({
      data: opts.exchange ?? { access_token: 'unused', item_id: 'unused' },
    }),
    accountsGet: async () => ({
      data: opts.accounts ?? { item: { institution_id: null }, accounts: [] },
    }),
    institutionsGetById: async () => {
      if (!opts.institution) throw new Error('no institution mocked');
      return { data: { institution: opts.institution } };
    },
    itemRemove: async (req: { access_token: string }) => {
      opts.itemRemove?.push(req);
      return { data: { request_id: 'req-x' } };
    },
    linkTokenCreate: async () => ({
      data: {
        link_token: 'link-sandbox-x',
        expiration: new Date(Date.now() + 3600_000).toISOString(),
      },
    }),
  } as unknown as PlaidApi;
}

/**
 * Service-level integration: real Drizzle against Testcontainers
 * Postgres, real TokenCipher, mocked PlaidApi. Verifies the
 * persistence and decryption contracts the matching/sync ADRs
 * depend on, without touching the network.
 */
describe('PlaidService (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let cipher: TokenCipher;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('vellum_test')
      .withUsername('vellum')
      .withPassword('vellum')
      .start();
    sql = postgres(container.getConnectionUri(), { max: 4 });
    db = drizzle(sql, { schema, casing: 'snake_case' });
    await migrate(db, { migrationsFolder });
    cipher = new TokenCipher(SECRET);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  beforeEach(async () => {
    await sql`DELETE FROM bank_transactions`;
    await sql`DELETE FROM plaid_accounts`;
    await sql`DELETE FROM plaid_items`;
    await sql`DELETE FROM users WHERE id = ${USER} OR id = 'usr_other' OR id = 'usr_thief'`;
    await sql`INSERT INTO users (id, email) VALUES (${USER}, 'plaid-svc@test')`;
  });

  async function seedItem(itemId: string, userId: string, accountId: string) {
    const sealed = cipher.seal(`access-token-${itemId}`);
    await sql`
      INSERT INTO plaid_items (id, user_id, plaid_item_id, access_token_cipher, access_token_iv, institution_name)
      VALUES (${itemId}, ${userId}, ${`plaid-${itemId}`}, ${sealed.cipher}, ${sealed.iv}, 'Sandbox Bank')
    `;
    await sql`
      INSERT INTO plaid_accounts (id, plaid_item_id, plaid_account_id, name, type, currency)
      VALUES (${`row-${accountId}`}, ${itemId}, ${accountId}, 'Acct', 'depository', 'USD')
    `;
  }

  it('exchange seals the access token and persists item + accounts', async () => {
    const plaid = mockPlaid({
      exchange: { access_token: 'access-sandbox-fixture-1', item_id: 'item-fix-1' },
      accounts: {
        item: { institution_id: 'ins_999' },
        accounts: [
          {
            account_id: 'acct-1',
            name: 'Sandbox Checking',
            official_name: 'Sandbox Bank Checking',
            type: 'depository',
            subtype: 'checking',
            mask: '1111',
            balances: {
              current: 1234.56,
              iso_currency_code: 'USD',
              unofficial_currency_code: null,
            },
          },
        ],
      },
      institution: { name: 'Sandbox Bank' },
    });
    const svc = new PlaidService(plaid, db, cipher);
    const { itemId } = await svc.exchange(USER, 'public-fix-1');

    const [item] = await sql`SELECT * FROM plaid_items WHERE id = ${itemId}`;
    expect(item?.user_id).toBe(USER);
    expect(item?.plaid_item_id).toBe('item-fix-1');
    expect(item?.institution_name).toBe('Sandbox Bank');
    expect(item?.institution_id).toBe('ins_999');
    expect(
      cipher.open({
        cipher: item?.access_token_cipher as string,
        iv: item?.access_token_iv as string,
      }),
    ).toBe('access-sandbox-fixture-1');

    const accounts = await sql`SELECT * FROM plaid_accounts WHERE plaid_item_id = ${itemId}`;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.plaid_account_id).toBe('acct-1');
    expect(accounts[0]?.mask).toBe('1111');
    expect(accounts[0]?.currency).toBe('USD');
    expect(String(accounts[0]?.current_balance_minor)).toBe('123456');
  });

  it('exchange falls back to unofficial_currency_code when iso is null', async () => {
    const plaid = mockPlaid({
      exchange: { access_token: 'a', item_id: 'item-fix-2' },
      accounts: {
        item: { institution_id: null },
        accounts: [
          {
            account_id: 'acct-x',
            name: 'Crypto',
            official_name: null,
            type: 'depository',
            subtype: null,
            mask: null,
            balances: {
              current: 100,
              iso_currency_code: null,
              unofficial_currency_code: 'BTC',
            },
          },
        ],
      },
    });
    const svc = new PlaidService(plaid, db, cipher);
    const { itemId } = await svc.exchange(USER, 'pt');
    const [acct] = await sql`SELECT currency FROM plaid_accounts WHERE plaid_item_id = ${itemId}`;
    expect(acct?.currency).toBe('BTC');
  });

  it('listItems returns each item grouped with its accounts, scoped to the user', async () => {
    await sql`INSERT INTO users (id, email) VALUES ('usr_other', 'other@test')`;
    await seedItem('it_a', USER, 'acct-a');
    await seedItem('it_b', USER, 'acct-b');
    await seedItem('it_other', 'usr_other', 'acct-x');

    const svc = new PlaidService(mockPlaid({}), db, cipher);
    const items = await svc.listItems(USER);
    expect(items.map((i) => i.id).sort()).toEqual(['it_a', 'it_b']);
    const a = items.find((i) => i.id === 'it_a');
    expect(a?.accounts.map((x) => x.plaidAccountId)).toEqual(['acct-a']);
  });

  it('removeItem revokes at Plaid and deletes the row (cascade clears accounts)', async () => {
    await seedItem('it_rm', USER, 'acct-rm');
    const revokeCalls: Array<{ access_token: string }> = [];
    const plaid = mockPlaid({ itemRemove: revokeCalls });
    const svc = new PlaidService(plaid, db, cipher);
    await svc.removeItem(USER, 'it_rm');

    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0]?.access_token).toBe('access-token-it_rm');
    const remaining = await sql`SELECT id FROM plaid_items WHERE id = 'it_rm'`;
    expect(remaining).toHaveLength(0);
    const accounts = await sql`SELECT id FROM plaid_accounts WHERE plaid_item_id = 'it_rm'`;
    expect(accounts).toHaveLength(0);
  });

  it('removeItem 404s when the row belongs to another user', async () => {
    await sql`INSERT INTO users (id, email) VALUES ('usr_thief', 'thief@test')`;
    await seedItem('it_target', USER, 'acct-target');
    const svc = new PlaidService(mockPlaid({}), db, cipher);
    await expect(svc.removeItem('usr_thief', 'it_target')).rejects.toThrow();
  });
});
