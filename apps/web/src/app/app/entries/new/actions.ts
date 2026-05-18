'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { apiClient, ApiError } from '@/lib/api';

export interface NewEntryState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

const formSchema = z.object({
  occurredAt: z.string().min(1, 'occurredAt is required'),
  description: z.string().trim().min(1, 'description is required').max(500),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter code'),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        side: z.enum(['DEBIT', 'CREDIT']),
        amount: z.string().regex(/^\d+$/, 'amount must be a non-negative integer in minor units'),
        memo: z.string().max(500).optional(),
      }),
    )
    .min(2, 'at least two lines are required'),
});

export async function createEntryAction(
  _prev: NewEntryState,
  formData: FormData,
): Promise<NewEntryState> {
  const rawLines: Array<{ accountId: string; side: string; amount: string; memo?: string }> = [];
  for (const key of formData.keys()) {
    const m = /^lines\[(\d+)]\.(accountId|side|amount|memo)$/.exec(key);
    if (!m) continue;
    const idx = Number(m[1]);
    const field = m[2] as 'accountId' | 'side' | 'amount' | 'memo';
    rawLines[idx] = rawLines[idx] ?? { accountId: '', side: '', amount: '' };
    const v = formData.get(key);
    if (typeof v === 'string') (rawLines[idx] as Record<string, string>)[field] = v;
  }

  const parsed = formSchema.safeParse({
    occurredAt: formData.get('occurredAt'),
    description: formData.get('description'),
    currency: formData.get('currency'),
    lines: rawLines.filter(Boolean).map((l) => ({
      accountId: l.accountId,
      side: l.side,
      amount: l.amount,
      memo: l.memo || undefined,
    })),
  });

  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'invalid entry',
    };
  }

  const client = await apiClient();
  const idempotencyKey = `entry-${randomUUID()}`;
  try {
    await client.post('/journal-entries', parsed.data, idempotencyKey);
  } catch (err) {
    if (err instanceof ApiError) {
      const detail = safeParseJson(err.body);
      if (detail && typeof detail === 'object' && 'error' in detail) {
        return { error: friendly(String((detail as { error: string }).error)) };
      }
      return { error: `api error ${err.status}` };
    }
    return { error: 'network error while submitting' };
  }

  redirect('/app');
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function friendly(code: string): string {
  switch (code) {
    case 'unbalanced_entry':
      return 'debits and credits do not match';
    case 'mixed_currency_entry':
      return 'all lines must share a currency';
    case 'entry_too_small':
      return 'at least two lines are required';
    case 'negative_amount':
      return 'line amounts must be non-negative';
    case 'account_not_found':
      return 'one of the selected accounts no longer exists';
    case 'validation_failed':
      return 'request did not pass validation';
    case 'idempotency_key_conflict':
      return 'a different entry was already submitted under this session; refresh and retry';
    default:
      return code;
  }
}
