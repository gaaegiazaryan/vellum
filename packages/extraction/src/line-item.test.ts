import { describe, it, expect } from 'vitest';
import { lineItemSchema } from './line-item.js';

describe('lineItemSchema', () => {
  it('parses a minimal valid line', () => {
    const parsed = lineItemSchema.parse({
      description: 'coffee',
      unitPriceMinor: '450',
      totalMinor: '450',
    });
    expect(parsed.description).toBe('coffee');
    expect(parsed.quantity).toBe(1);
    expect(parsed.unitPriceMinor).toBe('450');
  });

  it('accepts decimal quantity', () => {
    const parsed = lineItemSchema.parse({
      description: 'beans',
      quantity: 2.5,
      unitPriceMinor: '1000',
      totalMinor: '2500',
    });
    expect(parsed.quantity).toBe(2.5);
  });

  it('rejects negative quantity', () => {
    expect(() =>
      lineItemSchema.parse({
        description: 'x',
        quantity: -1,
        unitPriceMinor: '100',
        totalMinor: '100',
      }),
    ).toThrow();
  });

  it('rejects zero quantity (positive required)', () => {
    expect(() =>
      lineItemSchema.parse({
        description: 'x',
        quantity: 0,
        unitPriceMinor: '100',
        totalMinor: '100',
      }),
    ).toThrow();
  });

  it('rejects non-integer minor amounts', () => {
    expect(() =>
      lineItemSchema.parse({
        description: 'x',
        unitPriceMinor: '4.50',
        totalMinor: '4.50',
      }),
    ).toThrow();
  });

  it('rejects negative minor amounts via regex', () => {
    expect(() =>
      lineItemSchema.parse({
        description: 'x',
        unitPriceMinor: '-100',
        totalMinor: '-100',
      }),
    ).toThrow();
  });

  it('rejects empty description', () => {
    expect(() =>
      lineItemSchema.parse({
        description: '',
        unitPriceMinor: '100',
        totalMinor: '100',
      }),
    ).toThrow();
  });

  it('trims whitespace in description', () => {
    const parsed = lineItemSchema.parse({
      description: '  espresso  ',
      unitPriceMinor: '350',
      totalMinor: '350',
    });
    expect(parsed.description).toBe('espresso');
  });

  it('accepts optional category and notes', () => {
    const parsed = lineItemSchema.parse({
      description: 'taxi',
      unitPriceMinor: '1200',
      totalMinor: '1200',
      category: 'travel',
      notes: 'airport to hotel',
    });
    expect(parsed.category).toBe('travel');
    expect(parsed.notes).toBe('airport to hotel');
  });
});
