import { describe, it, expect } from 'vitest';
import { sumMajor, toCents, isBalanced, buildLinesJson } from './split-helpers.js';

describe('sumMajor', () => {
  it('sums plain decimal strings', () => {
    expect(sumMajor(['9.00', '0.79'])).toBeCloseTo(9.79, 10);
  });

  it('treats empty strings as zero', () => {
    expect(sumMajor(['', '', '5'])).toBe(5);
  });

  it('drops NaN entries instead of poisoning the total', () => {
    // Partial typing produces "0.1." or "1.2.3" which Number()
    // returns NaN for; the indicator should keep showing the rest
    // of the column, not flip to NaN.
    expect(sumMajor(['10', '0.1.', '5'])).toBe(15);
  });

  it('returns 0 for an empty array', () => {
    expect(sumMajor([])).toBe(0);
  });
});

describe('toCents', () => {
  it('rounds to the nearest hundredth', () => {
    expect(toCents(1.235)).toBe(124);
    expect(toCents(1.234)).toBe(123);
  });

  it('returns 0 on a non-finite input', () => {
    expect(toCents(NaN)).toBe(0);
    expect(toCents(Infinity)).toBe(0);
  });

  it('handles small values without float drift slipping a cent', () => {
    // 0.1 + 0.2 is not 0.3 in IEEE 754; both should round to 30 cents.
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(0.3)).toBe(30);
  });
});

describe('isBalanced', () => {
  it('returns true when debit and credit totals match and are positive', () => {
    expect(isBalanced(['9.00', '0.79'], ['9.79'])).toBe(true);
  });

  it('returns false when both sides are zero', () => {
    // A zero-zero "balance" is not a postable entry; the submit
    // button stays disabled.
    expect(isBalanced(['0'], ['0'])).toBe(false);
    expect(isBalanced(['', ''], [''])).toBe(false);
  });

  it('returns false when the sides differ', () => {
    expect(isBalanced(['9.00'], ['9.79'])).toBe(false);
  });

  it('tolerates float drift on the cent boundary', () => {
    expect(isBalanced(['0.1', '0.2'], ['0.3'])).toBe(true);
  });

  it('handles a partial-typing column without crashing or returning true falsely', () => {
    expect(isBalanced(['10', '0.1.'], ['10'])).toBe(true);
    expect(isBalanced(['10', '0.1.'], ['10.10'])).toBe(false);
  });
});

describe('buildLinesJson', () => {
  it('emits one credit tail after all debits, in declared order', () => {
    const raw = buildLinesJson(
      [
        { accountId: 'a-1', amountMajor: '9.00', memo: 'subtotal' },
        { accountId: 'a-2', amountMajor: '0.79', memo: 'sales tax' },
      ],
      { accountId: 'a-3', amountMajor: '9.79' },
    );
    expect(JSON.parse(raw)).toEqual([
      { side: 'DEBIT', accountId: 'a-1', amountMajor: '9.00', memo: 'subtotal' },
      { side: 'DEBIT', accountId: 'a-2', amountMajor: '0.79', memo: 'sales tax' },
      { side: 'CREDIT', accountId: 'a-3', amountMajor: '9.79' },
    ]);
  });

  it('drops memo when it is blank or whitespace-only', () => {
    const raw = buildLinesJson(
      [
        { accountId: 'a-1', amountMajor: '9.00', memo: '' },
        { accountId: 'a-2', amountMajor: '0.79', memo: '   ' },
      ],
      { accountId: 'a-3', amountMajor: '9.79' },
    );
    const lines = JSON.parse(raw);
    expect(lines[0]).not.toHaveProperty('memo');
    expect(lines[1]).not.toHaveProperty('memo');
  });

  it('preserves a memo that has only leading or trailing whitespace by trimming', () => {
    const raw = buildLinesJson([{ accountId: 'a-1', amountMajor: '9.79', memo: '  subtotal  ' }], {
      accountId: 'a-2',
      amountMajor: '9.79',
    });
    expect(JSON.parse(raw)[0].memo).toBe('subtotal');
  });

  it('the credit row never carries a memo (matches the api schema)', () => {
    const raw = buildLinesJson([{ accountId: 'a-1', amountMajor: '9.79', memo: 'subtotal' }], {
      accountId: 'a-2',
      amountMajor: '9.79',
    });
    const lines = JSON.parse(raw);
    expect(lines[1]).toEqual({ side: 'CREDIT', accountId: 'a-2', amountMajor: '9.79' });
  });
});
