import { hash, verify } from '@node-rs/argon2';

// Algorithm.Argon2id is an ambient const enum (= 2); isolatedModules
// requires we inline the value rather than import the enum.
const ARGON2ID = 2;

/**
 * Argon2id parameters. OWASP 2023 recommendation for high-security
 * applications: 19 MiB memory, 2 iterations, parallelism 1.
 * (https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
 *
 * Encoded inside the hash string per the PHC format, so changing
 * parameters here only affects new hashes; existing hashes verify
 * against the parameters baked into their own encoded string.
 */
const PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  return hash(password, PARAMS);
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  try {
    return await verify(encodedHash, password);
  } catch {
    return false;
  }
}
