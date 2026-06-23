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

  it('round-trips a non-ASCII utf-8 plaintext', () => {
    const c = new TokenCipher(SECRET);
    const sealed = c.seal('токен-üñîçødé-🔐');
    expect(c.open(sealed)).toBe('токен-üñîçødé-🔐');
  });

  it('round-trips across independent instances sharing the same secret', () => {
    const sealer = new TokenCipher(SECRET);
    const opener = new TokenCipher(SECRET);
    const sealed = sealer.seal('cross-instance');
    expect(opener.open(sealed)).toBe('cross-instance');
  });
});
