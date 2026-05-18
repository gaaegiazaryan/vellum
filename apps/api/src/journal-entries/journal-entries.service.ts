import {
  Inject,
  Injectable,
  UnprocessableEntityException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, exists, gte, inArray, lte, or, sql } from 'drizzle-orm';
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

export interface ListEntriesOptions {
  limit?: number;
  cursor?: string;
  accountId?: string;
  after?: Date;
  before?: Date;
  currency?: string;
}

export interface ListEntriesResult {
  entries: JournalEntryRow[];
  nextCursor: string | null;
}

interface Cursor {
  occurredAt: Date;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ occurredAt: c.occurredAt.toISOString(), id: c.id })).toString(
    'base64url',
  );
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      occurredAt: string;
      id: string;
    };
    return { occurredAt: new Date(parsed.occurredAt), id: parsed.id };
  } catch {
    throw new Error('invalid cursor');
  }
}

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

  async list(opts: ListEntriesOptions): Promise<ListEntriesResult> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const conditions = [] as Array<ReturnType<typeof and>>;

    if (opts.after) conditions.push(gte(journalEntries.occurredAt, opts.after));
    if (opts.before) conditions.push(lte(journalEntries.occurredAt, opts.before));
    if (opts.currency) conditions.push(eq(journalEntries.currency, opts.currency));
    if (opts.accountId) {
      conditions.push(
        exists(
          this.db
            .select({ x: sql`1` })
            .from(ledgerLines)
            .where(
              and(
                eq(ledgerLines.journalEntryId, journalEntries.id),
                eq(ledgerLines.accountId, opts.accountId),
              ),
            ),
        ),
      );
    }
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      conditions.push(
        or(
          sql`${journalEntries.occurredAt} < ${c.occurredAt.toISOString()}::timestamptz`,
          and(eq(journalEntries.occurredAt, c.occurredAt), sql`${journalEntries.id} < ${c.id}`),
        )!,
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const entryRows = await this.db
      .select()
      .from(journalEntries)
      .where(where)
      .orderBy(desc(journalEntries.occurredAt), desc(journalEntries.id))
      .limit(limit + 1);

    const hasNext = entryRows.length > limit;
    const page = hasNext ? entryRows.slice(0, limit) : entryRows;

    if (page.length === 0) {
      return { entries: [], nextCursor: null };
    }

    const ids = page.map((e) => e.id);
    const allLines = await this.db
      .select()
      .from(ledgerLines)
      .where(inArray(ledgerLines.journalEntryId, ids))
      .orderBy(ledgerLines.position);

    const linesByEntry = new Map<string, JournalEntryRow['lines']>();
    for (const line of allLines) {
      const key = line.journalEntryId;
      const arr = linesByEntry.get(key) ?? [];
      arr.push({
        id: line.id,
        accountId: line.accountId,
        side: line.side,
        amount: line.amount.toString(),
        memo: line.memo,
        position: line.position,
      });
      linesByEntry.set(key, arr);
    }

    const entries: JournalEntryRow[] = page.map((entry) => ({
      id: entry.id,
      occurredAt: entry.occurredAt,
      description: entry.description,
      currency: entry.currency,
      createdById: entry.createdById ?? null,
      createdAt: entry.createdAt,
      lines: linesByEntry.get(entry.id) ?? [],
    }));

    const last = page[page.length - 1]!;
    const nextCursor = hasNext ? encodeCursor({ occurredAt: last.occurredAt, id: last.id }) : null;
    return { entries, nextCursor };
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
