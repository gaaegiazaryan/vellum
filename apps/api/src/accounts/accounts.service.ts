import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { normalBalanceFor, type AccountType, type Side } from '@vellum/core';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { accounts, ledgerLines } from '../db/schema/ledger.js';
import { extractions } from '../db/schema/extractions.js';

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

  /**
   * Suggest a debit account and a credit account for `vendor` based on the
   * user's own confirmed history (ADR-0013). For each side, returns the
   * account most frequently used on that side across confirmed extractions
   * whose receipt vendor name matches under a deliberately small set of
   * normalizations: lowercase, trim, collapse internal whitespace. This
   * fixes the OCR variant case ("Blue Bottle" vs "Blue  Bottle") without
   * the unpredictability of fuzzy matching. Ties break by the most recent
   * journal entry. Returns null per side when the user has no matching
   * history. (ADR-0013 known limit #1.)
   */
  async suggestForVendor(userId: string, vendor: string): Promise<VendorSuggestions> {
    const needle = normalizeVendor(vendor);
    if (!needle) return { debit: null, credit: null };

    const rows = await this.db
      .select({
        side: ledgerLines.side,
        accountId: ledgerLines.accountId,
        count: sql<string>`count(*)::text`,
        recent: sql<string>`max(je.occurred_at)::text`,
      })
      .from(extractions)
      .innerJoin(sql`journal_entries je`, sql`je.id = ${extractions.journalEntryId}`)
      .innerJoin(ledgerLines, eq(ledgerLines.journalEntryId, extractions.journalEntryId))
      .where(
        sql`${extractions.createdById} = ${userId}
          and ${extractions.journalEntryId} is not null
          and regexp_replace(lower(btrim(${extractions.receipt}->'vendor'->>'name')), '\\s+', ' ', 'g') = ${needle}`,
      )
      .groupBy(ledgerLines.side, ledgerLines.accountId);

    const pickTop = (side: 'DEBIT' | 'CREDIT'): AccountSuggestion | null => {
      const candidates = rows.filter((r) => r.side === side);
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => {
        const ca = Number(a.count);
        const cb = Number(b.count);
        if (cb !== ca) return cb - ca;
        return (b.recent ?? '').localeCompare(a.recent ?? '');
      });
      const top = candidates[0]!;
      return { accountId: top.accountId, count: Number(top.count) };
    };

    return { debit: pickTop('DEBIT'), credit: pickTop('CREDIT') };
  }
}

export interface AccountSuggestion {
  accountId: string;
  count: number;
}

export interface VendorSuggestions {
  debit: AccountSuggestion | null;
  credit: AccountSuggestion | null;
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

/**
 * Lowercase, trim, collapse runs of whitespace to one space. Same
 * normalization applied DB-side (regexp_replace + lower + btrim) so
 * both sides of the equality see the same canonical form.
 */
export function normalizeVendor(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}
