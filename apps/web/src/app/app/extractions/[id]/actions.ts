'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { apiClient, ApiError } from '@/lib/api';

export interface ConfirmState {
  error?: string;
}

// Most ISO 4217 currencies have two minor-unit digits. JPY (0) and a
// handful with 3 are not covered here; revisit if a user actually needs
// one of them. Reject anything but a non-negative decimal with at most
// two fractional digits.
const MAJOR_AMOUNT = /^\d+(\.\d{1,2})?$/;

function majorToMinor(s: string): string | null {
  if (!MAJOR_AMOUNT.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  const fracPadded = (frac + '00').slice(0, 2);
  const minor = BigInt(whole) * 100n + BigInt(fracPadded);
  return minor.toString();
}

const formSchema = z.object({
  extractionId: z.string().uuid(),
  debitAccountId: z.string().uuid('pick an expense account'),
  creditAccountId: z.string().uuid('pick a payment account'),
  description: z.string().trim().max(500).optional(),
  total: z.string().regex(MAJOR_AMOUNT, 'total must look like 12.34').optional(),
  occurredAt: z.string().min(1).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter code')
    .optional(),
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
    total: (formData.get('total') as string)?.trim() || undefined,
    occurredAt: (formData.get('occurredAt') as string) || undefined,
    currency: (formData.get('currency') as string)?.toUpperCase() || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid form' };
  }
  if (parsed.data.debitAccountId === parsed.data.creditAccountId) {
    return { error: 'debit and credit accounts must differ' };
  }

  let totalMinor: string | undefined;
  if (parsed.data.total !== undefined) {
    const m = majorToMinor(parsed.data.total);
    if (m === null) return { error: 'total must look like 12.34' };
    if (m === '0') return { error: 'total must be greater than zero' };
    totalMinor = m;
  }

  const { extractionId, total: _total, ...rest } = parsed.data;
  void _total;
  const body = { ...rest, ...(totalMinor !== undefined ? { totalMinor } : {}) };
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
