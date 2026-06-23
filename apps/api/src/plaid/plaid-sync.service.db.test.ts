import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaidApi } from 'plaid';
import { schema, type Db } from '../db/client.js';
import { PlaidSyncService } from './plaid-sync.service.js';
import { TokenCipher } from './token-cipher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../db/migrations');

const SECRET = 'a'.repeat(48);
const USER = 'usr_sync';

interface SyncPage {
  added?: Array<Record<string, unknown>>;
  modified?: Array<Record<string, unknown>>;
  removed?: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
}

function mockPlaidWithPages(pages: SyncPage[]): { plaid: PlaidApi; calls: string[] } {
  const calls: string[] = [];
  let idx = 0;
  const plaid = {
    transactionsSync: async (req: { cursor: string }) => {
      calls.push(req.cursor);
      const page = pages[idx];
      idx = Math.min(idx + 1, pages.length - 1);
      return {
        data: {
          added: page?.added ?? [],
          modified: page?.modified ?? [],
          removed: page?.removed ?? [],
          next_cursor: page?.next_cursor ?? '',
          has_more: page?.has_more ?? false,
        },
      };
    },
  } as unknown as PlaidApi;
  return { plaid, calls };
}

function txnFixture(transactionId: string, accountId: string, amount: number, date: string) {
  return {
    transaction_id: transactionId,
    account_id: accountId,
    amount,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date,
    datetime: null,
    authorized_date: null,
    authorized_datetime: null,
    name: `txn ${transactionId}`,
    merchant_name: `merchant-${transactionId}`,
  };
}

describe('PlaidSyncService (integration)', () => {
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
    await sql`DELETE FROM users WHERE id = ${USER}`;
    await sql`INSERT INTO users (id, email) VALUES (${USER}, 'sync@test')`;
    const sealed = cipher.seal('access-fixture');
    await sql`
      INSERT INTO plaid_items (id, user_id, plaid_item_id, access_token_cipher, access_token_iv)
      VALUES ('it_sync', ${USER}, 'plaid-it_sync', ${sealed.cipher}, ${sealed.iv})
    `;
    await sql`
      INSERT INTO plaid_accounts (id, plaid_item_id, plaid_account_id, name, type, currency)
      VALUES ('ac_sync', 'it_sync', 'plaid-acct-1', 'Checking', 'depository', 'USD')
    `;
  });

  it('writes added transactions and advances the cursor on a single page', async () => {
    const { plaid, calls } = mockPlaidWithPages([
      {
        added: [
          txnFixture('txn-1', 'plaid-acct-1', 9.99, '2026-06-20'),
          txnFixture('txn-2', 'plaid-acct-1', 25.0, '2026-06-21'),
        ],
        next_cursor: 'cur-A',
        has_more: false,
      },
    ]);
    const svc = new PlaidSyncService(plaid, db, cipher);
    const summary = await svc.syncItem('it_sync');
    expect(summary).toMatchObject({
      added: 2,
      modified: 0,
      removed: 0,
      paged: 1,
      finalCursor: 'cur-A',
    });
    expect(calls).toEqual(['']);

    const rows =
      await sql`SELECT plaid_transaction_id, amount_minor FROM bank_transactions ORDER BY plaid_transaction_id`;
    expect(rows.map((r) => r.plaid_transaction_id)).toEqual(['txn-1', 'txn-2']);
    expect(String(rows[0]?.amount_minor)).toBe('999');
    expect(String(rows[1]?.amount_minor)).toBe('2500');

    const [item] =
      await sql`SELECT last_sync_cursor, last_sync_at FROM plaid_items WHERE id = 'it_sync'`;
    expect(item?.last_sync_cursor).toBe('cur-A');
    expect(item?.last_sync_at).not.toBeNull();
  });

  it('pages until has_more=false using the next_cursor each time', async () => {
    const { plaid, calls } = mockPlaidWithPages([
      {
        added: [txnFixture('p1', 'plaid-acct-1', 1, '2026-06-20')],
        next_cursor: 'cur-1',
        has_more: true,
      },
      {
        added: [txnFixture('p2', 'plaid-acct-1', 2, '2026-06-21')],
        next_cursor: 'cur-2',
        has_more: true,
      },
      {
        added: [txnFixture('p3', 'plaid-acct-1', 3, '2026-06-22')],
        next_cursor: 'cur-3',
        has_more: false,
      },
    ]);
    const svc = new PlaidSyncService(plaid, db, cipher);
    const summary = await svc.syncItem('it_sync');
    expect(summary.paged).toBe(3);
    expect(summary.added).toBe(3);
    expect(calls).toEqual(['', 'cur-1', 'cur-2']);

    const [item] = await sql`SELECT last_sync_cursor FROM plaid_items WHERE id = 'it_sync'`;
    expect(item?.last_sync_cursor).toBe('cur-3');
  });

  it('modified updates the existing row in place', async () => {
    const { plaid: plaid1 } = mockPlaidWithPages([
      {
        added: [txnFixture('m1', 'plaid-acct-1', 10, '2026-06-20')],
        next_cursor: 'A',
        has_more: false,
      },
    ]);
    const svc1 = new PlaidSyncService(plaid1, db, cipher);
    await svc1.syncItem('it_sync');

    const updated = {
      ...txnFixture('m1', 'plaid-acct-1', 12.5, '2026-06-20'),
      merchant_name: 'new-merchant',
    };
    const { plaid: plaid2 } = mockPlaidWithPages([
      { modified: [updated], next_cursor: 'B', has_more: false },
    ]);
    const svc2 = new PlaidSyncService(plaid2, db, cipher);
    await svc2.syncItem('it_sync');

    const rows =
      await sql`SELECT amount_minor, merchant_name FROM bank_transactions WHERE plaid_transaction_id = 'm1'`;
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.amount_minor)).toBe('1250');
    expect(rows[0]?.merchant_name).toBe('new-merchant');
  });

  it('removed deletes by plaid_transaction_id', async () => {
    const { plaid: p1 } = mockPlaidWithPages([
      {
        added: [
          txnFixture('r1', 'plaid-acct-1', 1, '2026-06-20'),
          txnFixture('r2', 'plaid-acct-1', 2, '2026-06-21'),
        ],
        next_cursor: 'A',
        has_more: false,
      },
    ]);
    await new PlaidSyncService(p1, db, cipher).syncItem('it_sync');

    const { plaid: p2 } = mockPlaidWithPages([
      { removed: [{ transaction_id: 'r1' }], next_cursor: 'B', has_more: false },
    ]);
    await new PlaidSyncService(p2, db, cipher).syncItem('it_sync');

    const remaining =
      await sql`SELECT plaid_transaction_id FROM bank_transactions ORDER BY plaid_transaction_id`;
    expect(remaining.map((r) => r.plaid_transaction_id)).toEqual(['r2']);
  });

  it('resuming uses the stored cursor as the next request', async () => {
    await sql`UPDATE plaid_items SET last_sync_cursor = 'resume-cur' WHERE id = 'it_sync'`;
    const { plaid, calls } = mockPlaidWithPages([
      { added: [], next_cursor: 'fresh', has_more: false },
    ]);
    await new PlaidSyncService(plaid, db, cipher).syncItem('it_sync');
    expect(calls).toEqual(['resume-cur']);
  });

  it('added with onConflictDoNothing is idempotent across re-runs of the same cursor', async () => {
    const fix = [txnFixture('idem-1', 'plaid-acct-1', 5, '2026-06-20')];
    const run1 = mockPlaidWithPages([{ added: fix, next_cursor: 'X', has_more: false }]);
    await new PlaidSyncService(run1.plaid, db, cipher).syncItem('it_sync');

    // Same data re-emitted as added (Plaid edge case): write should
    // not throw or duplicate.
    await sql`UPDATE plaid_items SET last_sync_cursor = NULL WHERE id = 'it_sync'`;
    const run2 = mockPlaidWithPages([{ added: fix, next_cursor: 'Y', has_more: false }]);
    await new PlaidSyncService(run2.plaid, db, cipher).syncItem('it_sync');

    const rows = await sql`SELECT plaid_transaction_id FROM bank_transactions`;
    expect(rows).toHaveLength(1);
  });

  it('dueItems returns rows whose last_sync_at is null or older than the window', async () => {
    const sealed = cipher.seal('a');
    await sql`
      INSERT INTO plaid_items (id, user_id, plaid_item_id, access_token_cipher, access_token_iv, last_sync_at)
      VALUES ('it_stale', ${USER}, 'p-stale', ${sealed.cipher}, ${sealed.iv}, now() - interval '20 minutes')
    `;
    await sql`
      INSERT INTO plaid_items (id, user_id, plaid_item_id, access_token_cipher, access_token_iv, last_sync_at)
      VALUES ('it_fresh', ${USER}, 'p-fresh', ${sealed.cipher}, ${sealed.iv}, now() - interval '2 minutes')
    `;

    const svc = new PlaidSyncService(mockPlaidWithPages([]).plaid, db, cipher);
    const due = await svc.dueItems();
    expect(due.sort()).toEqual(['it_stale', 'it_sync']); // 'it_sync' has last_sync_at = null
    expect(due).not.toContain('it_fresh');
  });

  it('skips a transaction whose account_id is not in plaid_accounts yet', async () => {
    const { plaid } = mockPlaidWithPages([
      {
        added: [
          txnFixture('orphan', 'plaid-acct-UNKNOWN', 1, '2026-06-20'),
          txnFixture('known', 'plaid-acct-1', 2, '2026-06-21'),
        ],
        next_cursor: 'A',
        has_more: false,
      },
    ]);
    const svc = new PlaidSyncService(plaid, db, cipher);
    await svc.syncItem('it_sync');
    const rows = await sql`SELECT plaid_transaction_id FROM bank_transactions`;
    expect(rows.map((r) => r.plaid_transaction_id)).toEqual(['known']);
  });
});
