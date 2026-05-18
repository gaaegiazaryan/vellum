import { sql } from 'drizzle-orm';
import { loadEnv } from '../config/env.js';
import { createDb } from './client.js';
import { accounts } from './schema/ledger.js';

/**
 * Seed a sensible default chart of accounts. Run via:
 *   pnpm --filter @vellum/api db:seed
 *
 * Idempotent: ON CONFLICT (code) DO NOTHING. Re-running the script is
 * safe and only inserts missing rows.
 *
 * The chart below is intentionally small — single-currency single-user
 * starter that covers the four account types a freelancer routinely
 * touches. Real users will add their own; this is the "out of the box"
 * baseline so /app/entries/new has something in the dropdown.
 */

interface SeedAccount {
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
}

const SEED_ACCOUNTS: ReadonlyArray<SeedAccount> = [
  { code: '1000', name: 'Cash', type: 'ASSET' },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET' },
  { code: '2000', name: 'Accounts Payable', type: 'LIABILITY' },
  { code: '2200', name: 'Sales Tax Payable', type: 'LIABILITY' },
  { code: '3000', name: 'Owner Equity', type: 'EQUITY' },
  { code: '4000', name: 'Service Revenue', type: 'REVENUE' },
  { code: '4100', name: 'Other Income', type: 'REVENUE' },
  { code: '5000', name: 'Bank Fees', type: 'EXPENSE' },
  { code: '5100', name: 'Software & Subscriptions', type: 'EXPENSE' },
  { code: '5200', name: 'Travel', type: 'EXPENSE' },
  { code: '5300', name: 'Professional Services', type: 'EXPENSE' },
];

async function main(): Promise<void> {
  const env = loadEnv();
  const handle = createDb(env.DATABASE_URL);
  try {
    let inserted = 0;
    for (const acct of SEED_ACCOUNTS) {
      const res = await handle.db
        .insert(accounts)
        .values({ code: acct.code, name: acct.name, type: acct.type })
        .onConflictDoNothing({ target: accounts.code })
        .returning({ id: accounts.id });
      if (res.length > 0) inserted += 1;
    }

    const total = await handle.db.select({ n: sql<number>`count(*)::int` }).from(accounts);

    process.stdout.write(
      `seeded ${inserted} new accounts; chart now has ${total[0]?.n ?? 0} rows total\n`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
