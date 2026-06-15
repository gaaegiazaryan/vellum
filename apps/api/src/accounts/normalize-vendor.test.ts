import { describe, it, expect } from 'vitest';
import { normalizeVendor } from './accounts.service.js';

/**
 * Unit-level cases for normalizeVendor. The DB-side mirror of this
 * chain lives in accounts.service.ts and is covered end to end by
 * accounts.db.test.ts; this file pins the JS half so a future
 * refactor cannot silently desync the two without CI catching it.
 */
describe('normalizeVendor', () => {
  it('lowercases', () => {
    expect(normalizeVendor('Blue Bottle')).toBe('blue bottle');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeVendor('  Blue Bottle  ')).toBe('blue bottle');
  });

  it('collapses internal whitespace and tabs', () => {
    expect(normalizeVendor('Blue   Bottle')).toBe('blue bottle');
    expect(normalizeVendor('Blue\tBottle')).toBe('blue bottle');
  });

  it('drops a leading "the "', () => {
    expect(normalizeVendor('The Acme')).toBe('acme');
    expect(normalizeVendor('THE ACME')).toBe('acme');
  });

  it('does not drop "the" mid-string', () => {
    expect(normalizeVendor('Some Other The Place')).toBe('some other the place');
  });

  it('strips trailing "Inc"', () => {
    expect(normalizeVendor('Acme Inc')).toBe('acme');
    expect(normalizeVendor('Acme, Inc')).toBe('acme');
    expect(normalizeVendor('Acme Inc.')).toBe('acme');
    expect(normalizeVendor('Acme, Inc.')).toBe('acme');
  });

  it('strips trailing "LLC", "Ltd", "Co", "Corp", "Company", "Corporation"', () => {
    expect(normalizeVendor('Acme LLC')).toBe('acme');
    expect(normalizeVendor('Acme Ltd')).toBe('acme');
    expect(normalizeVendor('Acme Co.')).toBe('acme');
    expect(normalizeVendor('Acme Corp')).toBe('acme');
    expect(normalizeVendor('Acme Company')).toBe('acme');
    expect(normalizeVendor('Acme Corporation')).toBe('acme');
  });

  it('does NOT strip non-suffix words like "Coffee"', () => {
    expect(normalizeVendor('Blue Bottle Coffee')).toBe('blue bottle coffee');
  });

  it('does NOT strip a suffix that appears in the middle', () => {
    expect(normalizeVendor('Acme Inc Holdings')).toBe('acme inc holdings');
  });

  it('handles combinations: leading "the" plus trailing suffix', () => {
    expect(normalizeVendor('The Acme, LLC')).toBe('acme');
    expect(normalizeVendor('THE  ACME,   LLC.')).toBe('acme');
  });

  it('returns an empty string for blank input', () => {
    expect(normalizeVendor('')).toBe('');
    expect(normalizeVendor('   ')).toBe('');
  });
});
