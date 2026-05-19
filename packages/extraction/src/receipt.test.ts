import { describe, it, expect } from 'vitest';
import { receiptSchema, receiptTotalMismatch, type Receipt } from './receipt.js';

const baseReceipt = {
  vendor: { name: 'Blue Bottle Coffee' },
  occurredAt: '2026-05-19T10:15:00Z',
  currency: 'USD',
  subtotalMinor: '900',
  taxes: [{ name: 'sales tax', rate: 0.0875, amountMinor: '79' }],
  totalMinor: '979',
  paymentMethod: 'card' as const,
  lineItems: [
    {
      description: 'cappuccino',
      quantity: 2,
      unitPriceMinor: '450',
      totalMinor: '900',
    },
  ],
};

describe('receiptSchema', () => {
  it('parses a typical coffee-shop receipt', () => {
    const parsed = receiptSchema.parse(baseReceipt);
    expect(parsed.vendor.name).toBe('Blue Bottle Coffee');
    expect(parsed.occurredAt).toBeInstanceOf(Date);
    expect(parsed.lineItems).toHaveLength(1);
    expect(parsed.taxes).toHaveLength(1);
  });

  it('defaults taxes to empty array', () => {
    const withoutTaxes: Partial<typeof baseReceipt> = { ...baseReceipt };
    delete withoutTaxes.taxes;
    const parsed = receiptSchema.parse(withoutTaxes);
    expect(parsed.taxes).toEqual([]);
  });

  it('rejects empty line items', () => {
    expect(() => receiptSchema.parse({ ...baseReceipt, lineItems: [] })).toThrow();
  });

  it('rejects malformed currency', () => {
    expect(() => receiptSchema.parse({ ...baseReceipt, currency: 'usd' })).toThrow();
  });

  it('rejects non-integer total minor units', () => {
    expect(() => receiptSchema.parse({ ...baseReceipt, totalMinor: '9.79' })).toThrow();
  });

  it('rejects unknown payment method', () => {
    expect(() => receiptSchema.parse({ ...baseReceipt, paymentMethod: 'crypto' })).toThrow();
  });

  it('accepts optional address and tax id on vendor', () => {
    const parsed = receiptSchema.parse({
      ...baseReceipt,
      vendor: {
        name: 'Blue Bottle Coffee',
        address: '300 Webster St, Oakland CA',
        taxId: '94-1234567',
      },
    });
    expect(parsed.vendor.address).toContain('Webster');
    expect(parsed.vendor.taxId).toBe('94-1234567');
  });
});

describe('receiptTotalMismatch', () => {
  it('returns 0 when subtotal + taxes equals total', () => {
    const r = receiptSchema.parse(baseReceipt);
    expect(receiptTotalMismatch(r)).toBe(0n);
  });

  it('returns negative mismatch when the receipt undercounts the total', () => {
    const r: Receipt = receiptSchema.parse({
      ...baseReceipt,
      totalMinor: '1000',
    });
    // computed (subtotal 900 + tax 79 = 979) - total 1000 = -21
    expect(receiptTotalMismatch(r)).toBe(-21n);
  });

  it('returns positive mismatch when the receipt overcounts the total', () => {
    const r: Receipt = receiptSchema.parse({
      ...baseReceipt,
      totalMinor: '900',
    });
    expect(receiptTotalMismatch(r)).toBe(79n);
  });

  it('handles taxes-empty case correctly', () => {
    const r: Receipt = receiptSchema.parse({
      ...baseReceipt,
      taxes: [],
      totalMinor: '900',
    });
    expect(receiptTotalMismatch(r)).toBe(0n);
  });
});
