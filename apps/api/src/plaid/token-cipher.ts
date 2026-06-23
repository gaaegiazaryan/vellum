import { Inject, Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
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
 * Cipher and IV are persisted as separate columns
 * (plaid_items.access_token_cipher, access_token_iv) so a database
 * leak that exposes the cipher without the IV still does not yield
 * the plaintext under GCM's authentication guarantee.
 *
 * The output `cipher` field contains the GCM ciphertext + auth tag
 * concatenated in that order, base64-encoded. open() splits them
 * back apart using the known 16-byte tag length.
 */
@Injectable()
export class TokenCipher {
  private readonly key: Buffer;

  constructor(@Inject(AUTH_SECRET_TOKEN) secret: string) {
    if (!secret || secret.length < 32) {
      throw new Error('AUTH_SECRET must be at least 32 characters to derive an AES-256 key');
    }
    this.key = deriveKey(secret);
  }

  seal(plaintext: string): SealedToken {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new Error('seal() requires a non-empty plaintext string');
    }
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
    if (ivBuf.length !== IV_LENGTH) {
      throw new Error('iv length mismatch');
    }
    const blob = Buffer.from(sealed.cipher, 'base64');
    if (blob.length < AUTH_TAG_LENGTH + 1) {
      throw new Error('ciphertext too short to contain the auth tag');
    }
    const ciphertext = blob.subarray(0, blob.length - AUTH_TAG_LENGTH);
    const tag = blob.subarray(blob.length - AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGO, this.key, ivBuf);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  /**
   * Defensive equality check for the rare path where the caller has
   * the plaintext and wants to confirm it matches a stored sealed
   * record without re-encrypting (which is non-deterministic under
   * a fresh IV anyway). Uses timingSafeEqual on the decrypted side.
   */
  matches(sealed: SealedToken, expectedPlaintext: string): boolean {
    let decrypted: string;
    try {
      decrypted = this.open(sealed);
    } catch {
      return false;
    }
    const a = Buffer.from(decrypted, 'utf8');
    const b = Buffer.from(expectedPlaintext, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

function deriveKey(secret: string): Buffer {
  // SHA-256(label || secret) gives a deterministic 32-byte key.
  // HKDF would be stricter; SHA-256 is sufficient here because the
  // secret is already the high-entropy AUTH_SECRET and we only need
  // domain separation, not extract-then-expand semantics.
  const h = createHash('sha256');
  h.update(DERIVATION_LABEL);
  h.update('\0');
  h.update(secret);
  return h.digest();
}
