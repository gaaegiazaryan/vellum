import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { bankTransactions, plaidAccounts, plaidItems } from '../db/schema/plaid.js';
import { journalEntries, ledgerLines } from '../db/schema/ledger.js';
import { extractions } from '../db/schema/extractions.js';
import { MIN_SUGGEST_SCORE, SUGGEST_TOP_N, score } from './scorer.js';

// The scorer's date curve drops to 0 beyond +/- 7 days. Bounding the SQL
// by the same window avoids a sequential scan over the user's entire
// unmatched history; rows beyond the window can never make the threshold.
const DATE_WINDOW_MS = 7 * 86_400_000;

export interface BankSuggestion {
  bankTransactionId: string;
  occurredAt: Date;
  amountMinor: string;
  currency: string;
  merchantName: string | null;
  description: string | null;
  score: number;
}

export interface EntrySuggestion {
  journalEntryId: string;
  occurredAt: Date;
  description: string;
  totalMinor: string;
  currency: string;
  vendorName: string | null;
  score: number;
}

@Injectable()
export class MatchingService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Db) {}

  /**
   * Given a journal entry the user is reviewing on the confirm UI,
   * return the top-3 unmatched bank_transactions whose combined score
   * is >= 0.5. The query joins through plaid_items.user_id so a user
   * never sees another user's bank rows in their suggestion list.
   */
  async suggestForEntry(userId: string, journalEntryId: string): Promise<BankSuggestion[]> {
    const entry = await this.loadEntryContext(userId, journalEntryId);
    if (!entry) return [];
    return this.suggestForReceipt(userId, {
      totalMinor: entry.totalMinor,
      occurredAt: entry.occurredAt,
      currency: entry.currency,
      vendorName: entry.vendorName,
    });
  }

  /**
   * Pre-confirm variant: the receipt-side facts are passed directly
   * (the journal entry does not exist yet). Same scorer, same user
   * scoping, same currency filter. The confirm-receipt UI calls this
   * to render the top-3 candidates BEFORE the user submits; the
   * selected bankTransactionId then rides through the confirm request
   * and the api pairs in the same transaction.
   */
  async suggestForReceipt(
    userId: string,
    facts: {
      totalMinor: bigint;
      occurredAt: Date;
      currency: string;
      vendorName: string | null;
    },
  ): Promise<BankSuggestion[]> {
    const windowStart = new Date(facts.occurredAt.getTime() - DATE_WINDOW_MS);
    const windowEnd = new Date(facts.occurredAt.getTime() + DATE_WINDOW_MS);
    const candidates = await this.db
      .select({
        id: bankTransactions.id,
        occurredAt: bankTransactions.occurredAt,
        amountMinor: bankTransactions.amountMinor,
        currency: bankTransactions.currency,
        merchantName: bankTransactions.merchantName,
        description: bankTransactions.description,
      })
      .from(bankTransactions)
      .innerJoin(plaidAccounts, eq(plaidAccounts.id, bankTransactions.plaidAccountId))
      .innerJoin(plaidItems, eq(plaidItems.id, plaidAccounts.plaidItemId))
      .where(
        and(
          isNull(bankTransactions.journalEntryId),
          eq(plaidItems.userId, userId),
          eq(bankTransactions.currency, facts.currency),
          gte(bankTransactions.occurredAt, windowStart),
          lte(bankTransactions.occurredAt, windowEnd),
        ),
      );

    return rankBank(candidates, facts).slice(0, SUGGEST_TOP_N);
  }

  /**
   * Given a bank transaction the user wants to pair from /app/banks,
   * return the top-3 unmatched journal_entries (no row in
   * bank_transactions claims it yet) whose combined score is >= 0.5.
   * The bank tx is verified to belong to the user before any rows
   * leak into the response.
   */
  async suggestForBank(userId: string, bankTransactionId: string): Promise<EntrySuggestion[]> {
    const bank = await this.loadBankContext(userId, bankTransactionId);
    if (!bank) return [];

    const windowStart = new Date(bank.occurredAt.getTime() - DATE_WINDOW_MS);
    const windowEnd = new Date(bank.occurredAt.getTime() + DATE_WINDOW_MS);

    // Pre-aggregate ledger_lines into a per-entry total so the join with
    // extractions (which is m:1 not 1:1: a re-extracted entry has multiple
    // rows) does not multiply the SUM by the extraction count.
    const totals = this.db.$with('entry_totals').as(
      this.db
        .select({
          journalEntryId: ledgerLines.journalEntryId,
          totalMinor:
            sql<string>`sum(case when ${ledgerLines.side} = 'DEBIT' then ${ledgerLines.amount} else 0 end)::text`.as(
              'total_minor',
            ),
        })
        .from(ledgerLines)
        .groupBy(ledgerLines.journalEntryId),
    );

    const candidates = await this.db
      .with(totals)
      .select({
        id: journalEntries.id,
        occurredAt: journalEntries.occurredAt,
        description: journalEntries.description,
        currency: journalEntries.currency,
        totalMinor: sql<string>`coalesce(${totals.totalMinor}, '0')`,
        vendorName: sql<string | null>`max(${extractions.receipt} -> 'vendor' ->> 'name')`,
      })
      .from(journalEntries)
      .leftJoin(totals, eq(totals.journalEntryId, journalEntries.id))
      .leftJoin(extractions, eq(extractions.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.createdById, userId),
          eq(journalEntries.currency, bank.currency),
          gte(journalEntries.occurredAt, windowStart),
          lte(journalEntries.occurredAt, windowEnd),
          sql`not exists (select 1 from ${bankTransactions} bt where bt.journal_entry_id = ${journalEntries.id})`,
        ),
      )
      .groupBy(
        journalEntries.id,
        journalEntries.occurredAt,
        journalEntries.description,
        journalEntries.currency,
        totals.totalMinor,
      );

    return rankEntry(candidates, bank).slice(0, SUGGEST_TOP_N);
  }

  /**
   * Pair one bank_transactions row with one journal_entry. Sets both
   * journal_entry_id and matched_at atomically; the partial unique
   * index on journal_entry_id refuses a second claim with 23505 which
   * we surface as 409 conflict. The WHERE clause includes journal_entry_id
   * IS NULL so a concurrent re-claim on the SAME bank row from another
   * tab is also caught (rows_affected = 0 raises NotFound here).
   */
  async pair(userId: string, journalEntryId: string, bankTransactionId: string): Promise<void> {
    const entry = await this.loadEntryContext(userId, journalEntryId);
    if (!entry) {
      throw new NotFoundException({
        error: 'journal_entry_not_found',
        message: 'journal entry not found',
      });
    }
    const bank = await this.loadBankContext(userId, bankTransactionId);
    if (!bank) {
      throw new NotFoundException({
        error: 'bank_transaction_not_found',
        message: 'bank transaction not found',
      });
    }
    if (entry.currency !== bank.currency) {
      throw new ConflictException({ error: 'currency_mismatch', message: 'currency mismatch' });
    }

    try {
      const updated = await this.db
        .update(bankTransactions)
        .set({ journalEntryId, matchedAt: new Date() })
        .where(
          and(eq(bankTransactions.id, bankTransactionId), isNull(bankTransactions.journalEntryId)),
        )
        .returning({ id: bankTransactions.id });
      if (updated.length === 0) {
        // Bank row was paired by a concurrent request; tell the caller
        // they raced and lost rather than silently no-op'ing.
        throw new ConflictException({
          error: 'bank_transaction_already_paired',
          message: 'bank transaction already paired',
        });
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          error: 'journal_entry_already_paired',
          message: 'journal entry already paired with another bank transaction',
        });
      }
      throw err;
    }
  }

  /**
   * Unpair sets journal_entry_id and matched_at to null. The journal
   * entry itself is never touched. Returns 404 if the bank row does
   * not belong to the user (no info leak about other users' rows).
   */
  async unpair(userId: string, bankTransactionId: string): Promise<void> {
    const bank = await this.loadBankContext(userId, bankTransactionId);
    if (!bank) {
      throw new NotFoundException({
        error: 'bank_transaction_not_found',
        message: 'bank transaction not found',
      });
    }
    await this.db
      .update(bankTransactions)
      .set({ journalEntryId: null, matchedAt: null })
      .where(eq(bankTransactions.id, bankTransactionId));
  }

  private async loadEntryContext(
    userId: string,
    journalEntryId: string,
  ): Promise<{
    occurredAt: Date;
    totalMinor: bigint;
    currency: string;
    vendorName: string | null;
  } | null> {
    // Two separate queries instead of one joined SUM. With a single
    // GROUP-BY across ledger_lines INNER JOIN extractions LEFT JOIN, an
    // entry with N extractions multiplies its ledger_lines rows by N
    // and the SUM doubles (or N-ples). Splitting makes each aggregate
    // honest at the cost of one extra round-trip.
    const [base] = await this.db
      .select({
        id: journalEntries.id,
        occurredAt: journalEntries.occurredAt,
        currency: journalEntries.currency,
        totalMinor: sql<string>`coalesce(sum(case when ${ledgerLines.side} = 'DEBIT' then ${ledgerLines.amount} else 0 end), 0)::text`,
      })
      .from(journalEntries)
      .innerJoin(ledgerLines, eq(ledgerLines.journalEntryId, journalEntries.id))
      .where(and(eq(journalEntries.id, journalEntryId), eq(journalEntries.createdById, userId)))
      .groupBy(journalEntries.id, journalEntries.occurredAt, journalEntries.currency);
    if (!base) return null;
    const [vendor] = await this.db
      .select({
        name: sql<string | null>`max(${extractions.receipt} -> 'vendor' ->> 'name')`,
      })
      .from(extractions)
      .where(eq(extractions.journalEntryId, journalEntryId));
    return {
      occurredAt: base.occurredAt,
      totalMinor: BigInt(base.totalMinor),
      currency: base.currency,
      vendorName: vendor?.name ?? null,
    };
  }

  private async loadBankContext(
    userId: string,
    bankTransactionId: string,
  ): Promise<{
    occurredAt: Date;
    amountMinor: bigint;
    currency: string;
    merchantName: string | null;
  } | null> {
    const rows = await this.db
      .select({
        id: bankTransactions.id,
        occurredAt: bankTransactions.occurredAt,
        amountMinor: bankTransactions.amountMinor,
        currency: bankTransactions.currency,
        merchantName: bankTransactions.merchantName,
      })
      .from(bankTransactions)
      .innerJoin(plaidAccounts, eq(plaidAccounts.id, bankTransactions.plaidAccountId))
      .innerJoin(plaidItems, eq(plaidItems.id, plaidAccounts.plaidItemId))
      .where(and(eq(bankTransactions.id, bankTransactionId), eq(plaidItems.userId, userId)));
    const row = rows[0];
    if (!row) return null;
    return {
      occurredAt: row.occurredAt,
      amountMinor: row.amountMinor,
      currency: row.currency,
      merchantName: row.merchantName,
    };
  }
}

interface BankCandidate {
  id: string;
  occurredAt: Date;
  amountMinor: bigint;
  currency: string;
  merchantName: string | null;
  description: string | null;
}

interface EntryCandidate {
  id: string;
  occurredAt: Date;
  description: string;
  currency: string;
  totalMinor: string;
  vendorName: string | null;
}

function rankBank(
  candidates: BankCandidate[],
  entry: { occurredAt: Date; totalMinor: bigint; vendorName: string | null },
): BankSuggestion[] {
  const scored = candidates
    .map((c) => {
      const s = score({
        bankAmountMinor: c.amountMinor,
        bankOccurredAt: c.occurredAt,
        bankMerchantName: c.merchantName,
        entryTotalMinor: entry.totalMinor,
        entryOccurredAt: entry.occurredAt,
        entryVendorName: entry.vendorName,
      });
      return { c, combined: s.combined };
    })
    .filter((r) => r.combined >= MIN_SUGGEST_SCORE)
    // Stable secondary key (newer-first by occurred_at, then id) so
    // duplicate-score candidates rank deterministically across runs.
    .sort(
      (a, b) =>
        b.combined - a.combined ||
        b.c.occurredAt.getTime() - a.c.occurredAt.getTime() ||
        (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0),
    );
  return scored.map((r) => ({
    bankTransactionId: r.c.id,
    occurredAt: r.c.occurredAt,
    amountMinor: r.c.amountMinor.toString(),
    currency: r.c.currency,
    merchantName: r.c.merchantName,
    description: r.c.description,
    score: r.combined,
  }));
}

function rankEntry(
  candidates: EntryCandidate[],
  bank: { occurredAt: Date; amountMinor: bigint; merchantName: string | null },
): EntrySuggestion[] {
  const scored = candidates
    .map((c) => {
      const s = score({
        bankAmountMinor: bank.amountMinor,
        bankOccurredAt: bank.occurredAt,
        bankMerchantName: bank.merchantName,
        entryTotalMinor: BigInt(c.totalMinor),
        entryOccurredAt: c.occurredAt,
        entryVendorName: c.vendorName,
      });
      return { c, combined: s.combined };
    })
    .filter((r) => r.combined >= MIN_SUGGEST_SCORE)
    .sort(
      (a, b) =>
        b.combined - a.combined ||
        b.c.occurredAt.getTime() - a.c.occurredAt.getTime() ||
        (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0),
    );
  return scored.map((r) => ({
    journalEntryId: r.c.id,
    occurredAt: r.c.occurredAt,
    description: r.c.description,
    totalMinor: r.c.totalMinor,
    currency: r.c.currency,
    vendorName: r.c.vendorName,
    score: r.combined,
  }));
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
