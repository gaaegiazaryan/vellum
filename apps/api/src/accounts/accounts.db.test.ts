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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AccountsModule } from './accounts.module.js';
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
  static forRoot(db: PostgresJsDatabase): DynamicModule {
    return {
      module: TestInfraModule,
      providers: [
        { provide: DB_HANDLE_TOKEN, useValue: { db, close: async () => {} } },
        { provide: DATABASE_TOKEN, useValue: db },
        { provide: AUTH_SECRET_TOKEN, useValue: SECRET },
        AuthGuard,
        IdempotencyService,
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
      exports: [DB_HANDLE_TOKEN, DATABASE_TOKEN, AUTH_SECRET_TOKEN, AuthGuard, IdempotencyService],
    };
  }
}

describe('AccountsController (integration)', () => {
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

    // Seed a user row so foreign keys validate later; not strictly required
    // for accounts but matches the env in which real requests arrive.
    await sql`INSERT INTO users (id, email) VALUES ('usr_test', 'test@example.com')`;

    const moduleRef = await Test.createTestingModule({
      imports: [TestInfraModule.forRoot(db), AccountsModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
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

  function post(body: Record<string, unknown>, key: string) {
    return app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { cookie, 'idempotency-key': key, 'content-type': 'application/json' },
      payload: body,
    });
  }

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/accounts' });
    expect(res.statusCode).toBe(401);
  });

  it('creates an account and reads it back', async () => {
    const res = await post(
      { code: '1000-cash', name: 'Cash', type: 'ASSET' },
      'idem-key-create-cash-1234',
    );
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; code: string; type: string };
    expect(body.code).toBe('1000-cash');
    expect(body.type).toBe('ASSET');

    const list = await app.inject({ method: 'GET', url: '/accounts', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const data = list.json() as { accounts: Array<{ code: string }> };
    expect(data.accounts.some((a) => a.code === '1000-cash')).toBe(true);

    const one = await app.inject({
      method: 'GET',
      url: `/accounts/${body.id}`,
      headers: { cookie },
    });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { code: string }).code).toBe('1000-cash');
  });

  it('rejects a duplicate account code with 409', async () => {
    const a = await post(
      { code: '2000-ap', name: 'Accounts Payable', type: 'LIABILITY' },
      'idem-key-create-ap-1',
    );
    expect(a.statusCode).toBe(201);
    const b = await post(
      { code: '2000-ap', name: 'something else', type: 'LIABILITY' },
      'idem-key-create-ap-2',
    );
    expect(b.statusCode).toBe(409);
  });

  it('replays the same response on the same idempotency key + body', async () => {
    const first = await post(
      { code: '3000-eq', name: 'Equity', type: 'EQUITY' },
      'idem-key-eq-replay',
    );
    expect(first.statusCode).toBe(201);
    const second = await post(
      { code: '3000-eq', name: 'Equity', type: 'EQUITY' },
      'idem-key-eq-replay',
    );
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
  });

  it('rejects an invalid body with 400', async () => {
    const res = await post({ code: '', name: '', type: 'NONSENSE' }, 'idem-key-invalid-body');
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('validation_failed');
  });

  it('returns 404 for an unknown account id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/accounts/11111111-1111-1111-1111-111111111111',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  describe('GET /accounts/:id/balance', () => {
    it('returns zero totals for an account with no entries', async () => {
      const create = await post(
        { code: '6000-balance-empty', name: 'Empty', type: 'ASSET' },
        'idem-bal-empty',
      );
      expect(create.statusCode).toBe(201);
      const id = (create.json() as { id: string }).id;
      const res = await app.inject({
        method: 'GET',
        url: `/accounts/${id}/balance`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { totals: unknown[]; normalBalance: string };
      expect(body.totals).toEqual([]);
      expect(body.normalBalance).toBe('DEBIT');
    });

    it('computes signed balance for a debit-normal account after a balanced entry', async () => {
      const asset = await post(
        { code: '6001-bal-cash', name: 'Cash', type: 'ASSET' },
        'idem-bal-cash',
      );
      const revenue = await post(
        { code: '6001-bal-rev', name: 'Revenue', type: 'REVENUE' },
        'idem-bal-rev',
      );
      const assetId = (asset.json() as { id: string }).id;
      const revenueId = (revenue.json() as { id: string }).id;

      // Insert one balanced entry directly via SQL so the test does not
      // depend on the journal-entries endpoint (which lives in a separate
      // PR and may not be on this branch).
      await sql`INSERT INTO journal_entries (id, occurred_at, description, currency)
                VALUES ('je_bal_1', now(), 'sale 1', 'USD')`;
      await sql`INSERT INTO ledger_lines (journal_entry_id, account_id, side, amount, position)
                VALUES ('je_bal_1', ${assetId}, 'DEBIT', 1500, 0),
                       ('je_bal_1', ${revenueId}, 'CREDIT', 1500, 1)`;

      const cashBal = await app.inject({
        method: 'GET',
        url: `/accounts/${assetId}/balance`,
        headers: { cookie },
      });
      expect(cashBal.statusCode).toBe(200);
      const cashBody = cashBal.json() as {
        normalBalance: string;
        totals: Array<{ currency: string; balance: string; debits: string; credits: string }>;
      };
      expect(cashBody.normalBalance).toBe('DEBIT');
      expect(cashBody.totals).toEqual([
        { currency: 'USD', debits: '1500', credits: '0', balance: '1500' },
      ]);

      const revBal = await app.inject({
        method: 'GET',
        url: `/accounts/${revenueId}/balance`,
        headers: { cookie },
      });
      const revBody = revBal.json() as {
        normalBalance: string;
        totals: Array<{ currency: string; balance: string }>;
      };
      expect(revBody.normalBalance).toBe('CREDIT');
      expect(revBody.totals).toEqual([
        { currency: 'USD', debits: '0', credits: '1500', balance: '1500' },
      ]);
    });

    it('returns 404 for a balance of a missing account', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/accounts/11111111-1111-4111-8111-111111111111/balance',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /accounts/suggest', () => {
    let coffeeId: string;
    let teaId: string;
    let cardId: string;

    beforeAll(async () => {
      const coffee = await post(
        { code: '5100-coffee', name: 'Meals & Coffee', type: 'EXPENSE' },
        'idem-sugg-coffee',
      );
      const tea = await post(
        { code: '5101-tea', name: 'Tea & Snacks', type: 'EXPENSE' },
        'idem-sugg-tea',
      );
      const card = await post(
        { code: '2200-card', name: 'Credit Card', type: 'LIABILITY' },
        'idem-sugg-card',
      );
      coffeeId = (coffee.json() as { id: string }).id;
      teaId = (tea.json() as { id: string }).id;
      cardId = (card.json() as { id: string }).id;

      await sql`INSERT INTO uploads (id, storage_key, mime_type, size_bytes, sha256, created_by_id)
                VALUES ('upl_sugg_seed', 'sugg/key', 'image/png', 1, 'sugg-hash', 'usr_test')`;

      const seed = async (
        eid: string,
        jeId: string,
        vendor: string,
        debit: string,
        occurred: string,
      ) => {
        const receipt = JSON.stringify({ vendor: { name: vendor } });
        await sql`INSERT INTO journal_entries (id, occurred_at, description, currency, created_by_id)
                  VALUES (${jeId}, ${occurred}::timestamptz, ${vendor}, 'USD', 'usr_test')`;
        await sql`INSERT INTO ledger_lines (journal_entry_id, account_id, side, amount, position)
                  VALUES (${jeId}, ${debit}, 'DEBIT', 500, 0),
                         (${jeId}, ${cardId}, 'CREDIT', 500, 1)`;
        await sql`INSERT INTO extractions (id, upload_id, provider, model, prompt_version,
                                            request_hash, status, receipt, created_by_id,
                                            journal_entry_id, confirmed_by_id, confirmed_at)
                  VALUES (${eid}, 'upl_sugg_seed', 'mock', 'mock', 'v1',
                          ${eid + '-hash'}, 'succeeded',
                          ${receipt}::jsonb,
                          'usr_test', ${jeId}, 'usr_test', ${occurred}::timestamptz)`;
      };

      // Blue Bottle: coffee x3 (recent), tea x1 (oldest).
      await seed('ext_bb_1', 'je_bb_1', 'Blue Bottle', coffeeId, '2026-05-10T10:00:00Z');
      await seed('ext_bb_2', 'je_bb_2', 'Blue Bottle', coffeeId, '2026-05-20T10:00:00Z');
      await seed('ext_bb_3', 'je_bb_3', 'Blue Bottle', coffeeId, '2026-05-30T10:00:00Z');
      await seed('ext_bb_4', 'je_bb_4', 'Blue Bottle', teaId, '2026-05-01T10:00:00Z');

      // Tie-break case: Stumptown coffee 2, tea 2 — tea wins by recency.
      await seed('ext_st_1', 'je_st_1', 'Stumptown', coffeeId, '2026-05-05T10:00:00Z');
      await seed('ext_st_2', 'je_st_2', 'Stumptown', coffeeId, '2026-05-06T10:00:00Z');
      await seed('ext_st_3', 'je_st_3', 'Stumptown', teaId, '2026-05-07T10:00:00Z');
      await seed('ext_st_4', 'je_st_4', 'Stumptown', teaId, '2026-05-08T10:00:00Z');
    });

    it('returns null for a vendor with no confirmed history', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/accounts/suggest?vendor=Nobody',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ debit: null, credit: null });
    });

    it('returns the most-frequent debit and credit account', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/accounts/suggest?vendor=Blue%20Bottle',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as VendorSuggestionsResponse;
      expect(body.debit).toEqual({ accountId: coffeeId, count: 3 });
      expect(body.credit).toEqual({ accountId: cardId, count: 4 });
    });

    it('breaks ties by most recent journal entry', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/accounts/suggest?vendor=Stumptown',
        headers: { cookie },
      });
      const body = res.json() as VendorSuggestionsResponse;
      expect(body.debit?.accountId).toBe(teaId);
      expect(body.debit?.count).toBe(2);
    });

    it('matches case-insensitively and trims', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/accounts/suggest?vendor=' + encodeURIComponent('  blue bottle  '),
        headers: { cookie },
      });
      const body = res.json() as VendorSuggestionsResponse;
      expect(body.debit?.accountId).toBe(coffeeId);
    });

    it('rejects a missing vendor with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/accounts/suggest',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
    });

    it('does not leak across users', async () => {
      await sql`INSERT INTO users (id, email) VALUES ('usr_other', 'other@example.com')
                ON CONFLICT (id) DO NOTHING`;
      const otherToken = await encode({
        token: { sub: 'usr_other', email: 'other@example.com' },
        secret: SECRET,
        salt: 'authjs.session-token',
        maxAge: 60 * 60,
      });
      const res = await app.inject({
        method: 'GET',
        url: '/accounts/suggest?vendor=Blue%20Bottle',
        headers: { cookie: `authjs.session-token=${otherToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ debit: null, credit: null });
    });
  });
});

interface VendorSuggestionsResponse {
  debit: { accountId: string; count: number } | null;
  credit: { accountId: string; count: number } | null;
}
