import { Money, currency, type Currency } from './money.js';
import { InvalidCurrencyError } from './errors.js';

export interface CurrencyMeta {
  code: Currency;
  decimals: number;
  name: string;
}

function meta(code: string, decimals: number, name: string): [Currency, CurrencyMeta] {
  const c = currency(code);
  return [c, { code: c, decimals, name }];
}

/**
 * ISO 4217 currencies we expect to actually see in the wild. Not exhaustive;
 * this is the set we render with confidence today. Unknown codes fall back
 * to 2 decimals at parse time so the system stays usable for user-defined
 * codes (crypto, internal accounting units, regional issuers).
 */
export const CURRENCIES: Record<Currency, CurrencyMeta> = Object.fromEntries([
  meta('USD', 2, 'United States dollar'),
  meta('EUR', 2, 'Euro'),
  meta('GBP', 2, 'Pound sterling'),
  meta('CAD', 2, 'Canadian dollar'),
  meta('AUD', 2, 'Australian dollar'),
  meta('CHF', 2, 'Swiss franc'),
  meta('NZD', 2, 'New Zealand dollar'),
  meta('SEK', 2, 'Swedish krona'),
  meta('NOK', 2, 'Norwegian krone'),
  meta('DKK', 2, 'Danish krone'),
  meta('PLN', 2, 'Polish zloty'),
  meta('CZK', 2, 'Czech koruna'),
  meta('HUF', 2, 'Hungarian forint'),
  meta('SGD', 2, 'Singapore dollar'),
  meta('HKD', 2, 'Hong Kong dollar'),
  meta('CNY', 2, 'Chinese yuan'),
  meta('INR', 2, 'Indian rupee'),
  meta('BRL', 2, 'Brazilian real'),
  meta('MXN', 2, 'Mexican peso'),
  meta('ZAR', 2, 'South African rand'),
  meta('TRY', 2, 'Turkish lira'),
  meta('AED', 2, 'United Arab Emirates dirham'),
  meta('SAR', 2, 'Saudi riyal'),
  meta('JPY', 0, 'Japanese yen'),
  meta('KRW', 0, 'South Korean won'),
  meta('VND', 0, 'Vietnamese dong'),
  meta('CLP', 0, 'Chilean peso'),
  meta('ISK', 0, 'Icelandic krona'),
  meta('BHD', 3, 'Bahraini dinar'),
  meta('KWD', 3, 'Kuwaiti dinar'),
  meta('OMR', 3, 'Omani rial'),
  meta('JOD', 3, 'Jordanian dinar'),
  meta('TND', 3, 'Tunisian dinar'),
]) as Record<Currency, CurrencyMeta>;

const DEFAULT_DECIMALS = 2;

export function decimalsFor(code: Currency): number {
  return CURRENCIES[code]?.decimals ?? DEFAULT_DECIMALS;
}

export function isKnownCurrency(code: Currency): boolean {
  return code in CURRENCIES;
}

/**
 * Format a Money as a major-unit string with the right number of decimals
 * for its currency. JPY 1000 renders as "1000", USD 1000 as "10.00",
 * BHD 1000 as "1.000". No thousands separators; that is a locale concern,
 * not a domain concern.
 */
export function formatMinorUnits(money: Money): string {
  const decimals = decimalsFor(money.currency);
  const negative = money.amount < 0n;
  const abs = negative ? -money.amount : money.amount;
  if (decimals === 0) {
    return `${negative ? '-' : ''}${abs.toString()}`;
  }
  const divisor = 10n ** BigInt(decimals);
  const major = abs / divisor;
  const minor = abs % divisor;
  return `${negative ? '-' : ''}${major.toString()}.${minor.toString().padStart(decimals, '0')}`;
}

/**
 * Parse a major-unit string into a Money. "10.50" + USD → Money(1050n, USD).
 * Rejects more decimals than the currency allows ("1.5" against JPY throws)
 * to surface caller bugs early instead of silently truncating.
 */
export function parseMajorUnits(value: string, code: Currency): Money {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidMajorUnitsError(value, code);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [majorPart, fracPart = ''] = unsigned.split('.');
  const decimals = decimalsFor(code);
  if (fracPart.length > decimals) {
    throw new InvalidMajorUnitsError(value, code);
  }
  const padded = fracPart.padEnd(decimals, '0');
  const amount = BigInt(`${majorPart ?? ''}${padded}` || '0');
  return new Money(negative ? -amount : amount, code);
}

export class InvalidMajorUnitsError extends Error {
  constructor(
    readonly value: string,
    readonly currency: Currency,
  ) {
    super(`cannot parse ${JSON.stringify(value)} as a ${currency} amount`);
    this.name = 'InvalidMajorUnitsError';
  }
}

// Used at boundary validation in callers that might receive unknown codes.
export { InvalidCurrencyError };
