import {
  currency as toCurrency,
  formatMinorUnits,
  InvalidCurrencyError,
  Money,
} from '@vellum/core';

/**
 * Web-side canonical money formatter. Uses @vellum/core's per-currency
 * scale (USD/EUR/etc. = 2 decimals, JPY/KRW = 0, BHD/KWD/OMR = 3) so a
 * Yen receipt renders as "1000 JPY" and a Bahraini dinar charge renders
 * as "1.000 BHD" instead of the wrong-and-confusing "1000.00 JPY" / "1.00 BHD".
 *
 * Falls back to the raw minor + space + code when the currency is
 * unknown to the registry rather than throwing - the alternative
 * (page crash on an unknown code) is worse than the cosmetic drift.
 */
export function formatMoney(minorStr: string, code: string): string {
  try {
    const c = toCurrency(code);
    const amount = BigInt(minorStr);
    return `${formatMinorUnits(new Money(amount, c))} ${code}`;
  } catch (err) {
    if (err instanceof InvalidCurrencyError) return `${minorStr} ${code}`;
    // SyntaxError on BigInt(notInt) - render the raw input rather than
    // crash. The wire shape forbids this, but defensive at the boundary
    // is correct (caller is across a network).
    if (err instanceof SyntaxError) return `${minorStr} ${code}`;
    throw err;
  }
}
