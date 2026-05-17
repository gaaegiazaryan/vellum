'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { signIn } from '@/auth';
import {
  signupWithCredentials,
  signupInputSchema,
  EmailAlreadyRegisteredError,
} from '@/auth/signup';
import { WeakPasswordError } from '@/auth/password';

export interface ActionState {
  error?: string;
}

const signinInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'password is required'),
});

export async function signinAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signinInputSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: 'enter a valid email and password' };
  }
  try {
    await signIn('credentials', {
      ...parsed.data,
      redirect: false,
    });
  } catch {
    return { error: 'invalid email or password' };
  }
  redirect('/app');
}

export async function signupAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signupInputSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    name: formData.get('name') || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'enter a valid email and password' };
  }
  try {
    await signupWithCredentials(parsed.data);
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      return { error: 'an account with this email already exists' };
    }
    if (err instanceof WeakPasswordError) {
      return { error: err.message };
    }
    return { error: 'sign up failed; please try again' };
  }
  try {
    await signIn('credentials', { ...parsed.data, redirect: false });
  } catch {
    return { error: 'account created but sign-in failed; try signing in manually' };
  }
  redirect('/app');
}
