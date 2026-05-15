import { z } from 'zod';
import { CurrencyMismatchError, InvalidCurrencyError } from './errors.js';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export type Currency = string & { readonly __currency: unique symbol };

export function currency(value: string): Currency {
  if (!CURRENCY_PATTERN.test(value)) {
    throw new InvalidCurrencyError(value);
  }
  return value as Currency;
}

export const currencySchema = z
  .string()
  .regex(CURRENCY_PATTERN, 'must be a 3-letter ISO 4217 code')
  .transform((v) => v as Currency);

export class Money {
  constructor(
    readonly amount: bigint,
    readonly currency: Currency,
  ) {}

  static zero(c: Currency): Money {
    return new Money(0n, c);
  }

  plus(other: Money): Money {
    this.requireSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  minus(other: Money): Money {
    this.requireSameCurrency(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  negate(): Money {
    return new Money(-this.amount, this.currency);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount === other.amount;
  }

  isZero(): boolean {
    return this.amount === 0n;
  }

  isPositive(): boolean {
    return this.amount > 0n;
  }

  isNegative(): boolean {
    return this.amount < 0n;
  }

  toJSON(): { amount: string; currency: Currency } {
    return { amount: this.amount.toString(), currency: this.currency };
  }

  private requireSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

export const moneySchema = z
  .object({
    amount: z.union([z.bigint(), z.string(), z.number().int()]).transform((v) => BigInt(v)),
    currency: currencySchema,
  })
  .transform(({ amount, currency }) => new Money(amount, currency));
