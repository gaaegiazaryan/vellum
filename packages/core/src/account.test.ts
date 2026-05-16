import { describe, it, expect } from 'vitest';
import { ACCOUNT_TYPES, normalBalanceFor, type AccountType, type Side } from './account.js';

describe('normalBalanceFor', () => {
  it.each<[AccountType, Side]>([
    ['ASSET', 'DEBIT'],
    ['EXPENSE', 'DEBIT'],
    ['LIABILITY', 'CREDIT'],
    ['EQUITY', 'CREDIT'],
    ['REVENUE', 'CREDIT'],
  ])('returns the normal balance side for %s', (type, expected) => {
    expect(normalBalanceFor(type)).toBe(expected);
  });

  it('covers every AccountType (catches a future enum addition without a mapping)', () => {
    for (const type of ACCOUNT_TYPES) {
      const side = normalBalanceFor(type);
      expect(side === 'DEBIT' || side === 'CREDIT').toBe(true);
    }
  });
});
