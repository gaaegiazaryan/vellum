import { describe, it, expect } from 'vitest';
import { formatMoney } from './money';

describe('formatMoney', () => {
  it('formats USD with 2 decimals', () => {
    expect(formatMoney('979', 'USD')).toBe('9.79 USD');
    expect(formatMoney('1000', 'USD')).toBe('10.00 USD');
    expect(formatMoney('0', 'USD')).toBe('0.00 USD');
  });

  it('formats JPY with no decimals', () => {
    expect(formatMoney('1000', 'JPY')).toBe('1000 JPY');
    expect(formatMoney('1', 'JPY')).toBe('1 JPY');
  });

  it('formats BHD with 3 decimals', () => {
    expect(formatMoney('1000', 'BHD')).toBe('1.000 BHD');
    expect(formatMoney('1', 'BHD')).toBe('0.001 BHD');
  });

  it('treats unknown 3-letter codes as 2-decimal (the safest default)', () => {
    // 'XYZ' passes the format check; @vellum/core's decimalsFor returns 2
    // for any code not in its registry, which is the right default for
    // user-issued or crypto codes.
    expect(formatMoney('1000', 'XYZ')).toBe('10.00 XYZ');
  });

  it('falls back to the raw string when the code is malformed (not 3 uppercase letters)', () => {
    expect(formatMoney('1000', 'usd')).toBe('1000 usd');
    expect(formatMoney('1000', 'USDD')).toBe('1000 USDD');
  });

  it('falls back to raw on a malformed minor string instead of crashing', () => {
    expect(formatMoney('not-a-number', 'USD')).toBe('not-a-number USD');
  });
});
