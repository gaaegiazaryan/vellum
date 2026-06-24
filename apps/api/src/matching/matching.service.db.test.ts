import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema, type Db } from '../db/client.js';
import { MatchingService } from './matching.service.js';
import { TokenCipher } from '../plaid/token-cipher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../db/migrations');

const USER = 'usr_match';
const OTHER_USER = 'usr_other_match';

interface Seed {
  entryId: string;
  bankId: string;
}

/**
 * MatchingService integration tests against Testcontainers Postgres
 * with the real Drizzle schema. The plaid + ledger tables are wired
 * end-to-end so a pair/unpair round-trip exercises the partial unique
 * index, FK ownership joins, and the score-based suggest filters.
 */
describe('MatchingService (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let svc: MatchingService;
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
    cipher = new TokenCipher('a'.repeat(48));
    svc = new MatchingService(db);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  beforeEach(async () => {
    await sql`DELETE FROM extractions`;
    await sql`DELETE FROM bank_transactions`;
    await sql`DELETE FROM plaid_accounts`;
    await sql`DELETE FROM plaid_items`;
    await sql`DELETE FROM ledger_lines`;
    await sql`DELETE FROM journal_entries`;
    await sql`DELETE FROM accounts`;
    await sql`DELETE FROM users WHERE id IN (${USER}, ${OTHER_USER})`;
    await sql`INSERT INTO users (id, email) VALUES (${USER}, 'match@test'), (${OTHER_USER}, 'other-match@test')`;
    await sql`
      INSERT INTO accounts (id, code, name, type) VALUES
        ('acct_expense', '5000', 'Coffee', 'EXPENSE'),
        ('acct_payment', '1000', 'Card', 'ASSET')
    `;
  });

  async function seedEntry(opts: {
    id: string;
    userId: string;
    occurredAt: string;
    totalMinor: bigint;
    vendor: string | null;
    currency?: string;
  }) {
    const currency = opts.currency ?? 'USD';
    await sql`
      INSERT INTO journal_entries (id, occurred_at, description, currency, created_by_id)
      VALUES (${opts.id}, ${opts.occurredAt}, 'receipt', ${currency}, ${opts.userId})
    `;
    const totalStr = opts.totalMinor.toString();
    await sql`
      INSERT INTO ledger_lines (id, journal_entry_id, account_id, side, amount, position) VALUES
        (${opts.id + '_d'}, ${opts.id}, 'acct_expense', 'DEBIT', ${totalStr}, 0),
        (${opts.id + '_c'}, ${opts.id}, 'acct_payment', 'CREDIT', ${totalStr}, 1)
    `;
    if (opts.vendor) {
      const receipt = JSON.stringify({ vendor: { name: opts.vendor }, totalMinor: '0' });
      await sql`
        INSERT INTO extractions
          (id, upload_id, status, provider, model, prompt_version, journal_entry_id, receipt)
        VALUES
          (${opts.id + '_x'}, ${opts.id + '_u'}, 'succeeded', 'mock', 'mock', 'v1', ${opts.id}, ${receipt}::jsonb)
      `;
    }
  }

  async function seedBank(opts: {
    id: string;
    userId: string;
    occurredAt: string;
    amountMinor: bigint;
    merchant: string | null;
    currency?: string;
  }) {
    const currency = opts.currency ?? 'USD';
    const itemId = `it_${opts.id}`;
    const acctId = `ac_${opts.id}`;
    const sealed = cipher.seal(`tok-${opts.id}`);
    await sql`
      INSERT INTO plaid_items (id, user_id, plaid_item_id, access_token_cipher, access_token_iv)
      VALUES (${itemId}, ${opts.userId}, ${`p_${itemId}`}, ${sealed.cipher}, ${sealed.iv})
    `;
    await sql`
      INSERT INTO plaid_accounts (id, plaid_item_id, plaid_account_id, name, type, currency)
      VALUES (${acctId}, ${itemId}, ${`pa_${acctId}`}, 'Card', 'depository', ${currency})
    `;
    await sql`
      INSERT INTO bank_transactions
        (id, plaid_account_id, plaid_transaction_id, occurred_at, amount_minor, currency, merchant_name, raw)
      VALUES
        (${opts.id}, ${acctId}, ${`pt_${opts.id}`}, ${opts.occurredAt}, ${opts.amountMinor.toString()}, ${currency}, ${opts.merchant}, '{}'::jsonb)
    `;
  }

  async function seed(): Promise<Seed> {
    await seedEntry({
      id: 'je_a',
      userId: USER,
      occurredAt: '2026-06-20',
      totalMinor: 979n,
      vendor: 'Blue Bottle',
    });
    await seedBank({
      id: 'bt_a',
      userId: USER,
      occurredAt: '2026-06-20',
      amountMinor: 979n,
      merchant: 'Blue Bottle',
    });
    return { entryId: 'je_a', bankId: 'bt_a' };
  }

  it('suggestForEntry returns the matching bank tx above threshold', async () => {
    const { entryId } = await seed();
    const out = await svc.suggestForEntry(USER, entryId);
    expect(out).toHaveLength(1);
    expect(out[0]?.bankTransactionId).toBe('bt_a');
    expect(out[0]?.score).toBeGreaterThanOrEqual(0.85);
  });

  it('suggestForEntry excludes already-matched bank rows', async () => {
    const { entryId, bankId } = await seed();
    await sql`UPDATE bank_transactions SET journal_entry_id = ${entryId}, matched_at = now() WHERE id = ${bankId}`;
    // Now add a second entry and bank row that would otherwise match
    await seedEntry({
      id: 'je_b',
      userId: USER,
      occurredAt: '2026-06-20',
      totalMinor: 500n,
      vendor: 'Other',
    });
    const out = await svc.suggestForEntry(USER, 'je_b');
    expect(out).toHaveLength(0);
  });

  it('suggestForEntry filters by user (other user bank rows invisible)', async () => {
    await seedEntry({
      id: 'je_my',
      userId: USER,
      occurredAt: '2026-06-20',
      totalMinor: 979n,
      vendor: 'Blue Bottle',
    });
    await seedBank({
      id: 'bt_other',
      userId: OTHER_USER,
      occurredAt: '2026-06-20',
      amountMinor: 979n,
      merchant: 'Blue Bottle',
    });
    const out = await svc.suggestForEntry(USER, 'je_my');
    expect(out).toHaveLength(0);
  });

  it('suggestForEntry filters by currency', async () => {
    await seedEntry({
      id: 'je_usd',
      userId: USER,
      occurredAt: '2026-06-20',
      totalMinor: 979n,
      vendor: 'Blue Bottle',
      currency: 'USD',
    });
    await seedBank({
      id: 'bt_eur',
      userId: USER,
      occurredAt: '2026-06-20',
      amountMinor: 979n,
      merchant: 'Blue Bottle',
      currency: 'EUR',
    });
    expect(await svc.suggestForEntry(USER, 'je_usd')).toHaveLength(0);
  });

  it('suggestForEntry returns top-3 by score', async () => {
    await seedEntry({
      id: 'je_top',
      userId: USER,
      occurredAt: '2026-06-20',
      totalMinor: 979n,
      vendor: 'Blue Bottle',
    });
    await seedBank({
      id: 'bt_perfect',
      userId: USER,
      occurredAt: '2026-06-20',
      amountMinor: 979n,
      merchant: 'Blue Bottle',
    });
    await seedBank({
      id: 'bt_oneday',
      userId: USER,
      occurredAt: '2026-06-21',
      amountMinor: 979n,
      merchant: 'Blue Bottle',
    });
    await seedBank({
      id: 'bt_threedays',
      userId: USER,
      occurredAt: '2026-06-23',
      amountMinor: 979n,
      merchant: 'Blue Bottle',
    });
    await seedBank({
      id: 'bt_eight',
      userId: USER,
      occurredAt: '2026-06-28',
      amountMinor: 979n,
      merchant: 'Blue Bottle',
    });
    const out = await svc.suggestForEntry(USER, 'je_top');
    expect(out.map((s) => s.bankTransactionId)).toEqual([
      'bt_perfect',
      'bt_oneday',
      'bt_threedays',
    ]);
  });

  it('suggestForBank returns the matching unmatched entry', async () => {
    const { bankId } = await seed();
    const out = await svc.suggestForBank(USER, bankId);
    expect(out).toHaveLength(1);
    expect(out[0]?.journalEntryId).toBe('je_a');
  });

  it('pair sets journal_entry_id and matched_at atomically', async () => {
    const { entryId, bankId } = await seed();
    await svc.pair(USER, entryId, bankId);
    const [row] =
      await sql`SELECT journal_entry_id, matched_at FROM bank_transactions WHERE id = ${bankId}`;
    expect(row?.journal_entry_id).toBe(entryId);
    expect(row?.matched_at).not.toBeNull();
  });

  it('pair rejects when journal entry is already claimed by another bank tx (DB unique index)', async () => {
    const { entryId } = await seed();
    await seedBank({
      id: 'bt_dup',
      userId: USER,
      occurredAt: '2026-06-20',
      amountMinor: 979n,
      merchant: 'Blue Bottle',
    });
    await svc.pair(USER, entryId, 'bt_a');
    await expect(svc.pair(USER, entryId, 'bt_dup')).rejects.toThrow();
  });

  it('pair rejects when bank tx is already paired (WHERE journal_entry_id IS NULL guard)', async () => {
    const { entryId, bankId } = await seed();
    await seedEntry({
      id: 'je_b',
      userId: USER,
      occurredAt: '2026-06-20',
      totalMinor: 979n,
      vendor: 'Blue Bottle',
    });
    await svc.pair(USER, entryId, bankId);
    await expect(svc.pair(USER, 'je_b', bankId)).rejects.toThrow();
  });

  it('pair rejects cross-user attempts with 404', async () => {
    const { entryId, bankId } = await seed();
    await expect(svc.pair(OTHER_USER, entryId, bankId)).rejects.toThrow();
  });

  it('unpair nulls both fields and returns the bank row to the suggestion pool', async () => {
    const { entryId, bankId } = await seed();
    await svc.pair(USER, entryId, bankId);
    await svc.unpair(USER, bankId);
    const [row] =
      await sql`SELECT journal_entry_id, matched_at FROM bank_transactions WHERE id = ${bankId}`;
    expect(row?.journal_entry_id).toBeNull();
    expect(row?.matched_at).toBeNull();
    const out = await svc.suggestForEntry(USER, entryId);
    expect(out.map((s) => s.bankTransactionId)).toEqual([bankId]);
  });

  it('unpair refuses cross-user', async () => {
    const { entryId, bankId } = await seed();
    await svc.pair(USER, entryId, bankId);
    await expect(svc.unpair(OTHER_USER, bankId)).rejects.toThrow();
  });
});
