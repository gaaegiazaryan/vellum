import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, WeakPasswordError } from './password';

describe('hashPassword', () => {
  it('produces an Argon2id-encoded string', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h).toMatch(/^\$argon2id\$/);
  });

  it('produces a different hash for the same password (random salt)', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
  });

  it('rejects passwords shorter than the minimum', async () => {
    await expect(hashPassword('short')).rejects.toThrow(WeakPasswordError);
  });

  it('rejects unreasonably long passwords', async () => {
    await expect(hashPassword('a'.repeat(2000))).rejects.toThrow(WeakPasswordError);
  });
});

describe('verifyPassword', () => {
  it('returns true for the original password', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
  });

  it('returns false for a wrong password', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', h)).toBe(false);
  });

  it('returns false for a malformed hash without throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-real-argon2-hash')).toBe(false);
  });
}, 30_000);
