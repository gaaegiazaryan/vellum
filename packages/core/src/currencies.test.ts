import { describe, it, expect } from 'vitest';
import { Money, currency } from './money.js';
import {
  CURRENCIES,
  InvalidMajorUnitsError,
  decimalsFor,
  formatMinorUnits,
  isKnownCurrency,
  parseMajorUnits,
} from './currencies.js';

const USD = currency('USD');
const JPY = currency('JPY');
const BHD = currency('BHD');
const XYZ = currency('XYZ');

describe('CURRENCIES registry', () => {
  it('has expected decimals for sample currencies', () => {
    expect(CURRENCIES[USD]?.decimals).toBe(2);
    expect(CURRENCIES[JPY]?.decimals).toBe(0);
    expect(CURRENCIES[BHD]?.decimals).toBe(3);
  });

  it('does not include unknown codes', () => {
    expect(CURRENCIES[XYZ]).toBeUndefined();
  });
});

describe('decimalsFor', () => {
  it('returns the registered decimals for known currencies', () => {
    expect(decimalsFor(USD)).toBe(2);
    expect(decimalsFor(JPY)).toBe(0);
    expect(decimalsFor(BHD)).toBe(3);
  });

  it('falls back to 2 decimals for unknown codes', () => {
    expect(decimalsFor(XYZ)).toBe(2);
  });
});

describe('isKnownCurrency', () => {
  it('returns true for registered codes', () => {
    expect(isKnownCurrency(USD)).toBe(true);
  });

  it('returns false for unregistered codes', () => {
    expect(isKnownCurrency(XYZ)).toBe(false);
  });
});

describe('formatMinorUnits', () => {
  it('formats USD with 2 decimals', () => {
    expect(formatMinorUnits(new Money(1000n, USD))).toBe('10.00');
    expect(formatMinorUnits(new Money(1n, USD))).toBe('0.01');
    expect(formatMinorUnits(new Money(0n, USD))).toBe('0.00');
  });

  it('formats JPY with 0 decimals', () => {
    expect(formatMinorUnits(new Money(1000n, JPY))).toBe('1000');
    expect(formatMinorUnits(new Money(0n, JPY))).toBe('0');
  });

  it('formats BHD with 3 decimals', () => {
    expect(formatMinorUnits(new Money(1000n, BHD))).toBe('1.000');
    expect(formatMinorUnits(new Money(1n, BHD))).toBe('0.001');
  });

  it('formats negative amounts', () => {
    expect(formatMinorUnits(new Money(-1234n, USD))).toBe('-12.34');
    expect(formatMinorUnits(new Money(-5n, JPY))).toBe('-5');
  });

  it('uses default 2 decimals for unknown currencies', () => {
    expect(formatMinorUnits(new Money(100n, XYZ))).toBe('1.00');
  });

  it('handles bigint amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = new Money(9_999_999_999_999_999_999n, USD);
    expect(formatMinorUnits(huge)).toBe('99999999999999999.99');
  });
});

describe('parseMajorUnits', () => {
  it('parses a USD amount with two decimals', () => {
    const m = parseMajorUnits('10.50', USD);
    expect(m.amount).toBe(1050n);
    expect(m.currency).toBe(USD);
  });

  it('parses a JPY amount without decimals', () => {
    expect(parseMajorUnits('1000', JPY).amount).toBe(1000n);
  });

  it('parses a BHD amount with three decimals', () => {
    expect(parseMajorUnits('1.234', BHD).amount).toBe(1234n);
  });

  it('parses a negative amount', () => {
    expect(parseMajorUnits('-5.00', USD).amount).toBe(-500n);
  });

  it('pads missing fraction digits to full precision', () => {
    expect(parseMajorUnits('1.5', USD).amount).toBe(150n);
    expect(parseMajorUnits('1', USD).amount).toBe(100n);
  });

  it('rejects a string with more decimals than the currency allows', () => {
    expect(() => parseMajorUnits('1.5', JPY)).toThrow(InvalidMajorUnitsError);
    expect(() => parseMajorUnits('1.2345', BHD)).toThrow(InvalidMajorUnitsError);
  });

  it('rejects malformed input', () => {
    expect(() => parseMajorUnits('1.5.0', USD)).toThrow(InvalidMajorUnitsError);
    expect(() => parseMajorUnits('abc', USD)).toThrow(InvalidMajorUnitsError);
    expect(() => parseMajorUnits('', USD)).toThrow(InvalidMajorUnitsError);
    expect(() => parseMajorUnits('1,000', USD)).toThrow(InvalidMajorUnitsError);
  });

  it('round-trips through formatMinorUnits', () => {
    const cases: Array<[string, ReturnType<typeof currency>]> = [
      ['12.34', USD],
      ['0.01', USD],
      ['1000', JPY],
      ['1.234', BHD],
      ['-5.00', USD],
    ];
    for (const [value, code] of cases) {
      expect(formatMinorUnits(parseMajorUnits(value, code))).toBe(value);
    }
  });
});
