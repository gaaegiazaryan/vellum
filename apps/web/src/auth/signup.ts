import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { users } from '@/db/schema/auth';
import { userCredentials } from '@/db/schema/credentials';
import { hashPassword } from './password';

export const signupInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string(),
  name: z.string().trim().min(1).max(120).optional(),
});

export type SignupInput = z.infer<typeof signupInputSchema>;

export class EmailAlreadyRegisteredError extends Error {
  constructor(readonly email: string) {
    super(`email already registered: ${email}`);
    this.name = 'EmailAlreadyRegisteredError';
  }
}

/**
 * Create a new user + matching credentials row in a single transaction.
 * Returns the user id so the caller can complete the sign-in flow
 * immediately if desired.
 *
 * The password is hashed with Argon2id before either insert happens;
 * a write failure leaves no plaintext-anywhere window.
 */
export async function signupWithCredentials(input: SignupInput): Promise<{ userId: string }> {
  const parsed = signupInputSchema.parse(input);
  const passwordHash = await hashPassword(parsed.password);
  const db = getDb();

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, parsed.email))
      .limit(1);
    if (existing[0]) {
      throw new EmailAlreadyRegisteredError(parsed.email);
    }

    const [inserted] = await tx
      .insert(users)
      .values({ email: parsed.email, name: parsed.name ?? null })
      .returning({ id: users.id });
    if (!inserted) {
      throw new Error('failed to insert user row');
    }

    await tx.insert(userCredentials).values({
      userId: inserted.id,
      passwordHash,
    });
    return { userId: inserted.id };
  });
}
