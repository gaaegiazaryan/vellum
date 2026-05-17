import { describe, it, expect } from 'vitest';
import { canonicalize, requestHash } from './canonicalize.js';

describe('canonicalize', () => {
  it('produces the same string for objects with reordered keys', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('serializes primitives via JSON.stringify', () => {
    expect(canonicalize('hi')).toBe('"hi"');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
  });

  it('collapses null and undefined to null', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(undefined)).toBe('null');
  });

  it('handles nested objects', () => {
    const a = canonicalize({ a: 1, nested: { y: 2, x: 1 } });
    const b = canonicalize({ nested: { x: 1, y: 2 }, a: 1 });
    expect(a).toBe(b);
  });

  it('handles arrays as ordered', () => {
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('serializes bigint with an n marker', () => {
    expect(canonicalize(123n)).toBe('"123n"');
  });

  it('serializes Date as ISO string', () => {
    expect(canonicalize(new Date('2026-05-17T00:00:00Z'))).toBe('"2026-05-17T00:00:00.000Z"');
  });

  it('rejects functions', () => {
    expect(() => canonicalize(() => 1)).toThrow();
  });

  it('rejects symbols', () => {
    expect(() => canonicalize(Symbol('s'))).toThrow();
  });
});

describe('requestHash', () => {
  it('is deterministic for the same logical request', () => {
    expect(requestHash('POST', '/journal-entries', { amount: 1, currency: 'USD' })).toBe(
      requestHash('POST', '/journal-entries', { currency: 'USD', amount: 1 }),
    );
  });

  it('differs when method differs', () => {
    const body = { x: 1 };
    expect(requestHash('POST', '/x', body)).not.toBe(requestHash('PATCH', '/x', body));
  });

  it('differs when path differs', () => {
    const body = { x: 1 };
    expect(requestHash('POST', '/a', body)).not.toBe(requestHash('POST', '/b', body));
  });

  it('differs when body differs', () => {
    expect(requestHash('POST', '/x', { a: 1 })).not.toBe(requestHash('POST', '/x', { a: 2 }));
  });

  it('case-folds the method so post and POST hash the same', () => {
    expect(requestHash('post', '/x', null)).toBe(requestHash('POST', '/x', null));
  });

  it('produces a 64-character hex string', () => {
    const h = requestHash('POST', '/x', { a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
