import { describe, it, expect } from 'vitest';
import { Money, currency } from './money.js';
import {
  assertBalanced,
  netBalance,
  journalEntrySchema,
  ledgerLineSchema,
  type JournalEntry,
  type LedgerLine,
} from './journal.js';
import {
  EntryTooSmallError,
  MixedCurrencyEntryError,
  NegativeLedgerAmountError,
  UnbalancedEntryError,
} from './errors.js';

const USD = currency('USD');
const EUR = currency('EUR');

function entry(lines: LedgerLine[]): JournalEntry {
  return {
    id: 'je_1',
    occurredAt: new Date('2026-05-15T00:00:00Z'),
    description: 'test entry',
    lines,
  };
}

describe('assertBalanced', () => {
  it('accepts a 2-line entry with equal debit and credit', () => {
    expect(() =>
      assertBalanced(
        entry([
          { accountId: 'cash', side: 'DEBIT', amount: new Money(1000n, USD) },
          { accountId: 'revenue', side: 'CREDIT', amount: new Money(1000n, USD) },
        ]),
      ),
    ).not.toThrow();
  });

  it('accepts a split where two debits equal one credit', () => {
    expect(() =>
      assertBalanced(
        entry([
          { accountId: 'cash', side: 'DEBIT', amount: new Money(700n, USD) },
          { accountId: 'fees', side: 'DEBIT', amount: new Money(300n, USD) },
          { accountId: 'revenue', side: 'CREDIT', amount: new Money(1000n, USD) },
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects an entry with a single line', () => {
    expect(() =>
      assertBalanced(entry([{ accountId: 'cash', side: 'DEBIT', amount: new Money(100n, USD) }])),
    ).toThrow(EntryTooSmallError);
  });

  it('rejects an entry where debits do not equal credits', () => {
    expect(() =>
      assertBalanced(
        entry([
          { accountId: 'cash', side: 'DEBIT', amount: new Money(100n, USD) },
          { accountId: 'revenue', side: 'CREDIT', amount: new Money(99n, USD) },
        ]),
      ),
    ).toThrow(UnbalancedEntryError);
  });

  it('rejects an entry that mixes currencies', () => {
    expect(() =>
      assertBalanced(
        entry([
          { accountId: 'cash', side: 'DEBIT', amount: new Money(100n, USD) },
          { accountId: 'revenue', side: 'CREDIT', amount: new Money(100n, EUR) },
        ]),
      ),
    ).toThrow(MixedCurrencyEntryError);
  });

  it('reports debit and credit totals on imbalance', () => {
    try {
      assertBalanced(
        entry([
          { accountId: 'a', side: 'DEBIT', amount: new Money(500n, USD) },
          { accountId: 'b', side: 'CREDIT', amount: new Money(450n, USD) },
        ]),
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnbalancedEntryError);
      const err = e as UnbalancedEntryError;
      expect(err.debitTotal).toBe(500n);
      expect(err.creditTotal).toBe(450n);
    }
  });
});

describe('netBalance', () => {
  it('returns null for an empty array', () => {
    expect(netBalance([])).toBeNull();
  });

  it('treats debits as positive and credits as negative', () => {
    const result = netBalance([
      { accountId: 'a', side: 'DEBIT', amount: new Money(300n, USD) },
      { accountId: 'b', side: 'CREDIT', amount: new Money(100n, USD) },
    ]);
    expect(result?.amount).toBe(200n);
  });

  it('throws on mixed currencies', () => {
    expect(() =>
      netBalance([
        { accountId: 'a', side: 'DEBIT', amount: new Money(100n, USD) },
        { accountId: 'b', side: 'DEBIT', amount: new Money(100n, EUR) },
      ]),
    ).toThrow(MixedCurrencyEntryError);
  });
});

describe('journalEntrySchema', () => {
  it('parses a valid payload into a typed entry with Money instances', () => {
    const parsed = journalEntrySchema.parse({
      id: 'je_42',
      occurredAt: '2026-05-15T12:00:00Z',
      description: 'invoice paid',
      lines: [
        { accountId: 'cash', side: 'DEBIT', amount: { amount: '1500', currency: 'USD' } },
        { accountId: 'revenue', side: 'CREDIT', amount: { amount: '1500', currency: 'USD' } },
      ],
    });
    expect(parsed.id).toBe('je_42');
    expect(parsed.occurredAt).toBeInstanceOf(Date);
    expect(parsed.lines[0]?.amount).toBeInstanceOf(Money);
    expect(parsed.lines[0]?.amount.amount).toBe(1500n);
  });

  it('rejects an entry with fewer than 2 lines', () => {
    expect(() =>
      journalEntrySchema.parse({
        id: 'je_1',
        occurredAt: '2026-05-15T00:00:00Z',
        description: 'bad',
        lines: [{ accountId: 'cash', side: 'DEBIT', amount: { amount: '1', currency: 'USD' } }],
      }),
    ).toThrow();
  });

  it('rejects an entry with an empty description', () => {
    expect(() =>
      journalEntrySchema.parse({
        id: 'je_1',
        occurredAt: '2026-05-15T00:00:00Z',
        description: '',
        lines: [
          { accountId: 'a', side: 'DEBIT', amount: { amount: '1', currency: 'USD' } },
          { accountId: 'b', side: 'CREDIT', amount: { amount: '1', currency: 'USD' } },
        ],
      }),
    ).toThrow();
  });
});

describe('ledgerLineSchema', () => {
  it('accepts a positive amount', () => {
    const parsed = ledgerLineSchema.parse({
      accountId: 'cash',
      side: 'DEBIT',
      amount: { amount: '100', currency: 'USD' },
    });
    expect(parsed.amount.amount).toBe(100n);
  });

  it('accepts a zero amount', () => {
    const parsed = ledgerLineSchema.parse({
      accountId: 'cash',
      side: 'DEBIT',
      amount: { amount: '0', currency: 'USD' },
    });
    expect(parsed.amount.isZero()).toBe(true);
  });

  it('rejects a negative amount', () => {
    expect(() =>
      ledgerLineSchema.parse({
        accountId: 'cash',
        side: 'DEBIT',
        amount: { amount: '-100', currency: 'USD' },
      }),
    ).toThrow();
  });
});

describe('assertBalanced negative-amount defense', () => {
  it('rejects a hand-constructed entry with a negative line amount', () => {
    const e: JournalEntry = {
      id: 'je_x',
      occurredAt: new Date('2026-05-15T00:00:00Z'),
      description: 'bypass schema',
      lines: [
        { accountId: 'a', side: 'DEBIT', amount: new Money(-100n, USD) },
        { accountId: 'b', side: 'CREDIT', amount: new Money(-100n, USD) },
      ],
    };
    expect(() => assertBalanced(e)).toThrow(NegativeLedgerAmountError);
  });
});
