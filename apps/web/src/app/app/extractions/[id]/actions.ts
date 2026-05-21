'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { apiClient, ApiError } from '@/lib/api';

export interface ConfirmState {
  error?: string;
}

const formSchema = z.object({
  extractionId: z.string().uuid(),
  debitAccountId: z.string().uuid('pick an expense account'),
  creditAccountId: z.string().uuid('pick a payment account'),
  description: z.string().trim().max(500).optional(),
});

export async function confirmExtractionAction(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const parsed = formSchema.safeParse({
    extractionId: formData.get('extractionId'),
    debitAccountId: formData.get('debitAccountId'),
    creditAccountId: formData.get('creditAccountId'),
    description: (formData.get('description') as string) || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid form' };
  }
  if (parsed.data.debitAccountId === parsed.data.creditAccountId) {
    return { error: 'debit and credit accounts must differ' };
  }

  const { extractionId, ...body } = parsed.data;
  const client = await apiClient();
  try {
    await client.post(`/extractions/${extractionId}/confirm`, body, `confirm-${randomUUID()}`);
  } catch (err) {
    if (err instanceof ApiError) {
      return { error: friendly(err.status, err.body) };
    }
    return { error: 'network error while confirming' };
  }

  redirect('/app');
}

function friendly(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    switch (parsed.error) {
      case 'already_confirmed':
        return 'this receipt was already turned into a journal entry';
      case 'not_confirmable':
        return 'this extraction cannot be confirmed (it failed or is still pending)';
      case 'no_receipt':
        return 'this extraction has no parsed receipt to confirm';
      case 'account_not_found':
        return 'one of the selected accounts no longer exists';
      case 'same_account':
        return 'debit and credit accounts must differ';
      case 'non_positive_total':
        return 'the receipt total is not a positive amount';
      default:
        return parsed.message ?? `api error ${status}`;
    }
  } catch {
    return `api error ${status}`;
  }
}
