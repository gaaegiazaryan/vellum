import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AUTH_SECRET_TOKEN } from '../auth/auth.guard.js';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Domain-separation salt for the key derivation. Any Plaid token
 * ciphertext written with the v1 derivation is unreadable to a
 * future derivation labeled "plaid-token-v2" so a key rotation
 * does not silently mint readable ciphertext from a separate
 * domain. The label is fixed in code; bumping it is a deliberate
 * migration.
 */
const DERIVATION_LABEL = 'vellum:plaid-token:v1';

export interface SealedToken {
  cipher: string;
  iv: string;
}

/**
 * AES-256-GCM seal/open for Plaid access tokens at rest (ADR-0018).
 * The key is derived from AUTH_SECRET via SHA-256 with a fixed
 * domain-separation label so the cipher rotates if the operator
 * rotates the secret. The IV is 12 bytes random per encryption; the
 * auth tag is appended to the ciphertext and read on decrypt.
 *
 * Wire format: `cipher` is base64(ciphertext || tag) with the tag
 * being the last 16 bytes; `iv` is base64 of the 12-byte IV. open()
 * splits on the known tag length.
 */
@Injectable()
export class TokenCipher {
  private readonly key: Buffer;

  constructor(@Inject(AUTH_SECRET_TOKEN) secret: string) {
    this.key = deriveKey(secret);
  }

  seal(plaintext: string): SealedToken {
    const iv = randomBytes(IV_LENGTH);
    const cipherStream = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([
      cipherStream.update(plaintext, 'utf8'),
      cipherStream.final(),
    ]);
    const tag = cipherStream.getAuthTag();
    return {
      cipher: Buffer.concat([ciphertext, tag]).toString('base64'),
      iv: iv.toString('base64'),
    };
  }

  open(sealed: SealedToken): string {
    const ivBuf = Buffer.from(sealed.iv, 'base64');
    const blob = Buffer.from(sealed.cipher, 'base64');
    const ciphertext = blob.subarray(0, blob.length - AUTH_TAG_LENGTH);
    const tag = blob.subarray(blob.length - AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGO, this.key, ivBuf);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }
}

function deriveKey(secret: string): Buffer {
  // SHA-256(label || \0 || secret) gives a deterministic 32-byte key.
  // HKDF would be stricter; SHA-256 is sufficient here because the
  // secret is already the high-entropy AUTH_SECRET (validated min 32
  // chars in env.ts) and we only need domain separation, not
  // extract-then-expand semantics.
  const h = createHash('sha256');
  h.update(DERIVATION_LABEL);
  h.update('\0');
  h.update(secret);
  return h.digest();
}
