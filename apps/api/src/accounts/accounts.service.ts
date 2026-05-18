import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { normalBalanceFor, type AccountType, type Side } from '@vellum/core';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { accounts, ledgerLines } from '../db/schema/ledger.js';

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;

export const createAccountSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  parentId: z.string().uuid().nullable().optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: (typeof ACCOUNT_TYPES)[number];
  parentId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class AccountsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Db) {}

  async create(input: CreateAccountInput): Promise<AccountRow> {
    if (input.parentId) {
      const parent = await this.findById(input.parentId);
      if (!parent) {
        throw new NotFoundException(`parent account ${input.parentId} does not exist`);
      }
    }

    try {
      const [row] = await this.db
        .insert(accounts)
        .values({
          code: input.code,
          name: input.name,
          type: input.type,
          parentId: input.parentId ?? null,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      return row as AccountRow;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`account code ${JSON.stringify(input.code)} already exists`);
      }
      throw err;
    }
  }

  async findAll(): Promise<AccountRow[]> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(sql`${accounts.archivedAt} is null`)
      .orderBy(asc(accounts.code));
    return rows as AccountRow[];
  }

  async findById(id: string): Promise<AccountRow | null> {
    const rows = await this.db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    return (rows[0] as AccountRow | undefined) ?? null;
  }

  /**
   * Aggregate the per-side totals for an account and project the signed
   * balance against its natural side.
   *
   * For ASSET / EXPENSE accounts (debit-normal) the balance is
   *   debits - credits
   *
   * For LIABILITY / EQUITY / REVENUE (credit-normal) it is
   *   credits - debits
   *
   * Currency: the lines on a journal entry are guaranteed to share a
   * currency (DB trigger + app invariant), but an account can be
   * referenced by entries in different currencies. We aggregate per
   * currency and return all non-zero rows.
   */
  async getBalance(id: string): Promise<AccountBalance> {
    const account = await this.findById(id);
    if (!account) {
      throw new NotFoundException(`account ${id} not found`);
    }

    const aggregated = await this.db
      .select({
        currency: sql<string>`je.currency`,
        debits: sql<string>`coalesce(sum(${ledgerLines.amount}) filter (where ${ledgerLines.side} = 'DEBIT'), 0)::text`,
        credits: sql<string>`coalesce(sum(${ledgerLines.amount}) filter (where ${ledgerLines.side} = 'CREDIT'), 0)::text`,
      })
      .from(ledgerLines)
      .innerJoin(sql`journal_entries je`, sql`je.id = ${ledgerLines.journalEntryId}`)
      .where(eq(ledgerLines.accountId, id))
      .groupBy(sql`je.currency`);

    const normal: Side = normalBalanceFor(account.type as AccountType);

    const totals = aggregated.map((row) => {
      const debits = BigInt(row.debits);
      const credits = BigInt(row.credits);
      const signed = normal === 'DEBIT' ? debits - credits : credits - debits;
      return {
        currency: row.currency,
        debits: debits.toString(),
        credits: credits.toString(),
        balance: signed.toString(),
      };
    });

    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      normalBalance: normal,
      totals,
    };
  }
}

export interface AccountBalance {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: Side;
  totals: Array<{
    currency: string;
    debits: string;
    credits: string;
    balance: string;
  }>;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}
