import { describe, it, expect } from 'vitest';
import { Money, currency, moneySchema, currencySchema } from './money.js';
import { CurrencyMismatchError, InvalidCurrencyError } from './errors.js';

const USD = currency('USD');
const EUR = currency('EUR');

describe('currency', () => {
  it('accepts a 3-letter uppercase code', () => {
    expect(currency('GBP')).toBe('GBP');
  });

  it('rejects lowercase', () => {
    expect(() => currency('usd')).toThrow(InvalidCurrencyError);
  });

  it('rejects wrong length', () => {
    expect(() => currency('USDD')).toThrow(InvalidCurrencyError);
  });

  it('rejects empty string', () => {
    expect(() => currency('')).toThrow(InvalidCurrencyError);
  });
});

describe('Money.zero', () => {
  it('produces a zero amount in the given currency', () => {
    const m = Money.zero(USD);
    expect(m.amount).toBe(0n);
    expect(m.currency).toBe(USD);
    expect(m.isZero()).toBe(true);
  });
});

describe('Money arithmetic', () => {
  it('adds two same-currency amounts', () => {
    const sum = new Money(100n, USD).plus(new Money(250n, USD));
    expect(sum.amount).toBe(350n);
    expect(sum.currency).toBe(USD);
  });

  it('subtracts two same-currency amounts', () => {
    const diff = new Money(500n, USD).minus(new Money(150n, USD));
    expect(diff.amount).toBe(350n);
  });

  it('negates', () => {
    expect(new Money(100n, USD).negate().amount).toBe(-100n);
  });

  it('rejects mismatched currencies on plus', () => {
    expect(() => new Money(100n, USD).plus(new Money(50n, EUR))).toThrow(CurrencyMismatchError);
  });

  it('rejects mismatched currencies on minus', () => {
    expect(() => new Money(100n, USD).minus(new Money(50n, EUR))).toThrow(CurrencyMismatchError);
  });
});

describe('Money predicates', () => {
  it('isPositive when amount > 0', () => {
    expect(new Money(1n, USD).isPositive()).toBe(true);
    expect(new Money(0n, USD).isPositive()).toBe(false);
    expect(new Money(-1n, USD).isPositive()).toBe(false);
  });

  it('isNegative when amount < 0', () => {
    expect(new Money(-1n, USD).isNegative()).toBe(true);
    expect(new Money(0n, USD).isNegative()).toBe(false);
  });

  it('equals compares both amount and currency', () => {
    expect(new Money(100n, USD).equals(new Money(100n, USD))).toBe(true);
    expect(new Money(100n, USD).equals(new Money(100n, EUR))).toBe(false);
    expect(new Money(100n, USD).equals(new Money(101n, USD))).toBe(false);
  });
});

describe('Money serialization', () => {
  it('encodes amount as string in toJSON', () => {
    const json = new Money(9_999_999_999_999_999_999n, USD).toJSON();
    expect(json.amount).toBe('9999999999999999999');
    expect(json.currency).toBe('USD');
  });

  it('survives JSON.stringify without throwing on bigint', () => {
    const raw = JSON.stringify(new Money(1234n, USD));
    expect(JSON.parse(raw)).toEqual({ amount: '1234', currency: 'USD' });
  });
});

describe('moneySchema', () => {
  it('parses an input with string amount into a Money instance', () => {
    const m = moneySchema.parse({ amount: '1000', currency: 'USD' });
    expect(m).toBeInstanceOf(Money);
    expect(m.amount).toBe(1000n);
    expect(m.currency).toBe('USD');
  });

  it('parses a number amount', () => {
    const m = moneySchema.parse({ amount: 500, currency: 'EUR' });
    expect(m.amount).toBe(500n);
  });

  it('parses a bigint amount', () => {
    const m = moneySchema.parse({ amount: 777n, currency: 'GBP' });
    expect(m.amount).toBe(777n);
  });

  it('rejects an invalid currency code', () => {
    expect(() => moneySchema.parse({ amount: '1', currency: 'usd' })).toThrow();
  });

  it('rejects a non-integer number amount', () => {
    expect(() => moneySchema.parse({ amount: 1.5, currency: 'USD' })).toThrow();
  });
});

describe('currencySchema', () => {
  it('parses a valid code', () => {
    expect(currencySchema.parse('CHF')).toBe('CHF');
  });

  it('rejects mixed case', () => {
    expect(() => currencySchema.parse('Usd')).toThrow();
  });
});
