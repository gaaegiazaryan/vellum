import { z } from 'zod';
import { Money, moneySchema } from './money.js';
import { sideSchema } from './account.js';
import { EntryTooSmallError, MixedCurrencyEntryError, UnbalancedEntryError } from './errors.js';

export const ledgerLineSchema = z.object({
  accountId: z.string().min(1),
  side: sideSchema,
  amount: moneySchema,
  memo: z.string().optional(),
});

export type LedgerLine = z.infer<typeof ledgerLineSchema>;

export const journalEntrySchema = z.object({
  id: z.string().min(1),
  occurredAt: z.coerce.date(),
  description: z.string(),
  lines: z.array(ledgerLineSchema).min(2),
});

export type JournalEntry = z.infer<typeof journalEntrySchema>;

export function assertBalanced(entry: JournalEntry): void {
  if (entry.lines.length < 2) {
    throw new EntryTooSmallError(entry.lines.length);
  }

  const currencies = new Set(entry.lines.map((line) => line.amount.currency));
  if (currencies.size > 1) {
    throw new MixedCurrencyEntryError([...currencies]);
  }

  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const line of entry.lines) {
    if (line.side === 'DEBIT') {
      debitTotal += line.amount.amount;
    } else {
      creditTotal += line.amount.amount;
    }
  }

  if (debitTotal !== creditTotal) {
    throw new UnbalancedEntryError(debitTotal, creditTotal);
  }
}

export function netBalance(lines: ReadonlyArray<LedgerLine>): Money | null {
  if (lines.length === 0) return null;
  const first = lines[0];
  if (!first) return null;
  let acc = Money.zero(first.amount.currency);
  for (const line of lines) {
    if (line.amount.currency !== first.amount.currency) {
      throw new MixedCurrencyEntryError([first.amount.currency, line.amount.currency]);
    }
    acc = line.side === 'DEBIT' ? acc.plus(line.amount) : acc.minus(line.amount);
  }
  return acc;
}
