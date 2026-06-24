import { describe, it, expect } from 'vitest';
import { score, scoreAmount, scoreDate, scoreVendor, MIN_SUGGEST_SCORE } from './scorer.js';

describe('scoreAmount', () => {
  it('exact minor-unit match scores 1', () => {
    expect(scoreAmount(979n, 979n)).toBe(1);
  });

  it('1 minor unit off scores 0.9 (rounding from major-unit float)', () => {
    expect(scoreAmount(980n, 979n)).toBe(0.9);
    expect(scoreAmount(979n, 980n)).toBe(0.9);
  });

  it('2 minor units off scores 0', () => {
    expect(scoreAmount(981n, 979n)).toBe(0);
  });

  it('large difference scores 0', () => {
    expect(scoreAmount(10000n, 979n)).toBe(0);
  });
});

describe('scoreDate', () => {
  const d = (iso: string) => new Date(iso);

  it('same calendar day scores 1', () => {
    expect(scoreDate(d('2026-06-20T08:00:00Z'), d('2026-06-20T08:00:00Z'))).toBe(1);
  });

  it('exactly one day apart scores 0.8', () => {
    expect(scoreDate(d('2026-06-21T08:00:00Z'), d('2026-06-20T08:00:00Z'))).toBe(0.8);
  });

  it('three days apart scores 0.4 (boundary)', () => {
    expect(scoreDate(d('2026-06-23T08:00:00Z'), d('2026-06-20T08:00:00Z'))).toBe(0.4);
  });

  it('four to seven days apart scores 0.1', () => {
    expect(scoreDate(d('2026-06-24T08:00:00Z'), d('2026-06-20T08:00:00Z'))).toBe(0.1);
    expect(scoreDate(d('2026-06-27T08:00:00Z'), d('2026-06-20T08:00:00Z'))).toBe(0.1);
  });

  it('eight or more days apart scores 0', () => {
    expect(scoreDate(d('2026-06-28T08:00:00Z'), d('2026-06-20T08:00:00Z'))).toBe(0);
  });

  it('is symmetric around the entry date', () => {
    expect(scoreDate(d('2026-06-18T08:00:00Z'), d('2026-06-20T08:00:00Z'))).toBe(0.4);
    expect(scoreDate(d('2026-06-22T08:00:00Z'), d('2026-06-20T08:00:00Z'))).toBe(0.4);
  });

  it('uses calendar-day semantics, not a 24h rolling delta (late-night vs morning-after on same date)', () => {
    // 23:30 UTC and 02:30 UTC the SAME date both fall on calendar-day 0.
    expect(scoreDate(d('2026-06-20T23:30:00Z'), d('2026-06-20T02:30:00Z'))).toBe(1);
    // 23:30 UTC and 02:30 UTC the NEXT calendar day are 1 day apart, not 0
    // (Math.round of a 3h delta would have rounded to 0).
    expect(scoreDate(d('2026-06-20T23:30:00Z'), d('2026-06-21T02:30:00Z'))).toBe(0.8);
  });
});

describe('scoreVendor', () => {
  it('exact case-insensitive trim match scores 1', () => {
    expect(scoreVendor('Blue Bottle', 'blue bottle')).toBe(1);
    expect(scoreVendor('  Blue Bottle  ', 'Blue Bottle')).toBe(1);
  });

  it('substring containment in either direction scores 0.7', () => {
    expect(scoreVendor('AMAZON DIGITAL', 'amazon')).toBe(0.7);
    expect(scoreVendor('amazon', 'AMAZON DIGITAL')).toBe(0.7);
  });

  it('first-token equality after normalizing punctuation scores 0.3', () => {
    expect(scoreVendor('TST* CAFE DU MONDE', 'TST CAFE OUTLET')).toBe(0.3);
  });

  it('no relation scores 0', () => {
    expect(scoreVendor('Blue Bottle', 'Starbucks')).toBe(0);
  });

  it('null or empty either side scores 0', () => {
    expect(scoreVendor(null, 'Blue Bottle')).toBe(0);
    expect(scoreVendor('Blue Bottle', null)).toBe(0);
    expect(scoreVendor('', 'Blue Bottle')).toBe(0);
  });

  it("apostrophes do not fragment the vendor name (McDonalds vs McDonald's)", () => {
    // Common Plaid (punctuation-stripped) vs OCR (apostrophe-preserving)
    // shape. Before the apostrophe normalization fix the impl turned
    // "McDonald's" into "mcdonald s" and missed the exact match.
    expect(scoreVendor("McDonald's", 'MCDONALDS')).toBe(1);
    // Curly apostrophe variant some OCRs emit.
    expect(scoreVendor('McDonald’s', 'MCDONALDS')).toBe(1);
  });

  it('strips POS prefixes (TST*, SQ*, PAYPAL *) so the meaningful name matches', () => {
    expect(scoreVendor('TST* Blue Bottle', 'Blue Bottle')).toBe(1);
    expect(scoreVendor('SQ *Blue Bottle', 'Blue Bottle')).toBe(1);
    expect(scoreVendor('PAYPAL *MERCH', 'merch')).toBe(1);
    // AMZN MKTP US -> 'mktp us' against 'Amazon' scores 0 because the
    // tokenization does not encode the AMZN -> Amazon alias. A future
    // alias table (or the fuzzy vendor ADR) closes this; v1 acknowledges
    // the limitation and lets the user pair manually from /app/banks.
    expect(scoreVendor('AMZN MKTP US', 'Amazon')).toBe(0);
  });

  it('strips legal suffixes (Inc, LLC, Ltd, Corporation) so corporate aliases match', () => {
    expect(scoreVendor('Acme Inc', 'ACME')).toBe(1);
    expect(scoreVendor('Acme LLC.', 'Acme')).toBe(1);
    expect(scoreVendor('Acme Corporation', 'acme')).toBe(1);
  });

  it('strips store / ref numbers so trailing identifiers do not fragment', () => {
    expect(scoreVendor('WHOLE FOODS #1234', 'Whole Foods')).toBe(1);
    expect(scoreVendor('Trader Joes 42', 'Trader Joes')).toBe(1);
  });
});

describe('score (combined)', () => {
  const baseDate = new Date('2026-06-20T12:00:00Z');

  it('all signals perfect produces a combined score of 1', () => {
    const s = score({
      bankAmountMinor: 979n,
      bankOccurredAt: baseDate,
      bankMerchantName: 'Blue Bottle',
      entryTotalMinor: 979n,
      entryOccurredAt: baseDate,
      entryVendorName: 'Blue Bottle',
    });
    expect(s.combined).toBe(1);
  });

  it('amount + date perfect, vendor zero crosses the suggest threshold', () => {
    const s = score({
      bankAmountMinor: 979n,
      bankOccurredAt: baseDate,
      bankMerchantName: null,
      entryTotalMinor: 979n,
      entryOccurredAt: baseDate,
      entryVendorName: 'Blue Bottle',
    });
    // 0.5*1 + 0.35*1 + 0.15*0 = 0.85
    expect(s.combined).toBe(0.85);
    expect(s.combined).toBeGreaterThanOrEqual(MIN_SUGGEST_SCORE);
  });

  it('wrong amount alone drops a candidate below the threshold even with good date+vendor', () => {
    const s = score({
      bankAmountMinor: 5000n,
      bankOccurredAt: baseDate,
      bankMerchantName: 'Blue Bottle',
      entryTotalMinor: 979n,
      entryOccurredAt: baseDate,
      entryVendorName: 'Blue Bottle',
    });
    // 0.5*0 + 0.35*1 + 0.15*1 = 0.5 exactly
    expect(s.combined).toBe(0.5);
  });

  it('right amount + 1 day off + first-token vendor stays above the threshold', () => {
    const s = score({
      bankAmountMinor: 979n,
      bankOccurredAt: new Date('2026-06-21T12:00:00Z'),
      bankMerchantName: 'TST* CAFE DU MONDE',
      entryTotalMinor: 979n,
      entryOccurredAt: baseDate,
      entryVendorName: 'TST CAFE OUTLET',
    });
    // 0.5*1 + 0.35*0.8 + 0.15*0.3 = 0.825
    expect(s.combined).toBe(0.825);
  });

  it('all signals far off lands at 0', () => {
    const s = score({
      bankAmountMinor: 9999n,
      bankOccurredAt: new Date('2026-01-01T00:00:00Z'),
      bankMerchantName: 'Wholly Unrelated Co',
      entryTotalMinor: 100n,
      entryOccurredAt: baseDate,
      entryVendorName: 'Blue Bottle',
    });
    expect(s.combined).toBe(0);
  });
});
