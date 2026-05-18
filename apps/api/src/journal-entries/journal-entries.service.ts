import {
  Inject,
  Injectable,
  UnprocessableEntityException,
  NotFoundException,
} from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  Money,
  currency as toCurrency,
  assertBalanced,
  EntryTooSmallError,
  MixedCurrencyEntryError,
  NegativeLedgerAmountError,
  UnbalancedEntryError,
  type JournalEntry as DomainEntry,
  type LedgerLine as DomainLine,
} from '@vellum/core';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { accounts, journalEntries, ledgerLines } from '../db/schema/ledger.js';

export const ledgerLineInputSchema = z.object({
  accountId: z.string().uuid(),
  side: z.enum(['DEBIT', 'CREDIT']),
  amount: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
  memo: z.string().max(500).optional(),
});

export const createJournalEntryInputSchema = z.object({
  occurredAt: z.coerce.date(),
  description: z.string().trim().min(1).max(500),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code'),
  lines: z.array(ledgerLineInputSchema).min(2),
});

export type CreateJournalEntryInput = z.infer<typeof createJournalEntryInputSchema>;

export interface JournalEntryRow {
  id: string;
  occurredAt: Date;
  description: string;
  currency: string;
  createdById: string | null;
  createdAt: Date;
  lines: Array<{
    id: string;
    accountId: string;
    side: 'DEBIT' | 'CREDIT';
    amount: string;
    memo: string | null;
    position: number;
  }>;
}

@Injectable()
export class JournalEntriesService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Db) {}

  async create(
    input: CreateJournalEntryInput,
    createdById: string | null,
  ): Promise<JournalEntryRow> {
    const currency = toCurrency(input.currency);
    const domainLines: DomainLine[] = input.lines.map((line) => ({
      accountId: line.accountId,
      side: line.side,
      amount: new Money(BigInt(line.amount), currency),
      memo: line.memo,
    }));

    const domainEntry: DomainEntry = {
      id: 'pending',
      occurredAt: input.occurredAt,
      description: input.description,
      lines: domainLines,
    };

    try {
      assertBalanced(domainEntry);
    } catch (err) {
      if (
        err instanceof EntryTooSmallError ||
        err instanceof UnbalancedEntryError ||
        err instanceof MixedCurrencyEntryError ||
        err instanceof NegativeLedgerAmountError
      ) {
        throw new UnprocessableEntityException({
          error: domainErrorCode(err),
          message: err.message,
        });
      }
      throw err;
    }

    const uniqueAccountIds = [...new Set(input.lines.map((l) => l.accountId))];
    const found = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(inArray(accounts.id, uniqueAccountIds));
    if (found.length !== uniqueAccountIds.length) {
      const missing = uniqueAccountIds.filter((id) => !found.some((f) => f.id === id));
      throw new NotFoundException({
        error: 'account_not_found',
        message: 'one or more accountId fields point at accounts that do not exist',
        missing,
      });
    }

    return this.db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(journalEntries)
        .values({
          occurredAt: input.occurredAt,
          description: input.description,
          currency: input.currency,
          createdById,
        })
        .returning();
      if (!entry) throw new Error('failed to insert journal_entries row');

      const insertedLines = await tx
        .insert(ledgerLines)
        .values(
          input.lines.map((line, position) => ({
            journalEntryId: entry.id,
            accountId: line.accountId,
            side: line.side,
            amount: BigInt(line.amount),
            memo: line.memo ?? null,
            position,
          })),
        )
        .returning();

      return {
        id: entry.id,
        occurredAt: entry.occurredAt,
        description: entry.description,
        currency: entry.currency,
        createdById: entry.createdById ?? null,
        createdAt: entry.createdAt,
        lines: insertedLines.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          side: row.side,
          amount: row.amount.toString(),
          memo: row.memo,
          position: row.position,
        })),
      };
    });
  }

  async findById(id: string): Promise<JournalEntryRow | null> {
    const rows = await this.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, id))
      .limit(1);
    const entry = rows[0];
    if (!entry) return null;
    const lines = await this.db
      .select()
      .from(ledgerLines)
      .where(eq(ledgerLines.journalEntryId, id))
      .orderBy(ledgerLines.position);
    return {
      id: entry.id,
      occurredAt: entry.occurredAt,
      description: entry.description,
      currency: entry.currency,
      createdById: entry.createdById ?? null,
      createdAt: entry.createdAt,
      lines: lines.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        side: row.side,
        amount: row.amount.toString(),
        memo: row.memo,
        position: row.position,
      })),
    };
  }
}

function domainErrorCode(err: Error): string {
  if (err instanceof UnbalancedEntryError) return 'unbalanced_entry';
  if (err instanceof MixedCurrencyEntryError) return 'mixed_currency_entry';
  if (err instanceof EntryTooSmallError) return 'entry_too_small';
  if (err instanceof NegativeLedgerAmountError) return 'negative_amount';
  return 'invalid_entry';
}
