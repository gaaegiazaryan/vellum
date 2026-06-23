import { describe, it, expect } from 'vitest';
import { TokenCipher } from './token-cipher.js';

const SECRET = 'a'.repeat(48);

describe('TokenCipher', () => {
  it('seal then open round-trips the plaintext', () => {
    const c = new TokenCipher(SECRET);
    const sealed = c.seal('access-sandbox-deadbeef');
    expect(c.open(sealed)).toBe('access-sandbox-deadbeef');
  });

  it('produces a fresh IV (and therefore a fresh ciphertext) on every seal', () => {
    const c = new TokenCipher(SECRET);
    const a = c.seal('same-plaintext');
    const b = c.seal('same-plaintext');
    expect(a.iv).not.toBe(b.iv);
    expect(a.cipher).not.toBe(b.cipher);
    expect(c.open(a)).toBe('same-plaintext');
    expect(c.open(b)).toBe('same-plaintext');
  });

  it('rejects a tampered ciphertext (GCM auth tag mismatch)', () => {
    const c = new TokenCipher(SECRET);
    const sealed = c.seal('access-sandbox-deadbeef');
    // Flip a single bit in the middle of the ciphertext.
    const raw = Buffer.from(sealed.cipher, 'base64');
    const i = Math.floor(raw.length / 2);
    raw.writeUInt8(raw.readUInt8(i) ^ 0x01, i);
    const tampered = { cipher: raw.toString('base64'), iv: sealed.iv };
    expect(() => c.open(tampered)).toThrow();
  });

  it('rejects a ciphertext sealed under a different secret', () => {
    const a = new TokenCipher(SECRET);
    const b = new TokenCipher('b'.repeat(48));
    const sealed = a.seal('plaintext');
    expect(() => b.open(sealed)).toThrow();
  });

  it('rejects an IV that is not 12 bytes', () => {
    const c = new TokenCipher(SECRET);
    const sealed = c.seal('plaintext');
    const bad = { cipher: sealed.cipher, iv: Buffer.alloc(8).toString('base64') };
    expect(() => c.open(bad)).toThrow(/iv length/);
  });

  it('rejects a ciphertext that is too short to carry the auth tag', () => {
    const c = new TokenCipher(SECRET);
    const sealed = c.seal('plaintext');
    const bad = { cipher: Buffer.alloc(4).toString('base64'), iv: sealed.iv };
    expect(() => c.open(bad)).toThrow(/auth tag/);
  });

  it('refuses to construct when AUTH_SECRET is too short for AES-256', () => {
    expect(() => new TokenCipher('short')).toThrow(/at least 32/);
  });

  it('matches() returns true for a sealed record and the same plaintext', () => {
    const c = new TokenCipher(SECRET);
    const sealed = c.seal('access-sandbox-deadbeef');
    expect(c.matches(sealed, 'access-sandbox-deadbeef')).toBe(true);
  });

  it('matches() returns false for a sealed record and the wrong plaintext', () => {
    const c = new TokenCipher(SECRET);
    const sealed = c.seal('access-sandbox-deadbeef');
    expect(c.matches(sealed, 'wrong')).toBe(false);
  });

  it('matches() returns false on a tampered cipher (no throw on the caller side)', () => {
    const c = new TokenCipher(SECRET);
    const sealed = c.seal('access-sandbox-deadbeef');
    const raw = Buffer.from(sealed.cipher, 'base64');
    raw.writeUInt8(raw.readUInt8(0) ^ 0x01, 0);
    const tampered = { cipher: raw.toString('base64'), iv: sealed.iv };
    expect(c.matches(tampered, 'access-sandbox-deadbeef')).toBe(false);
  });

  it('seal rejects a non-string or empty plaintext', () => {
    const c = new TokenCipher(SECRET);
    expect(() => c.seal('')).toThrow();
    expect(() => c.seal(null as unknown as string)).toThrow();
  });
});
