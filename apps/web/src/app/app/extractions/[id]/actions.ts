'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { apiClient, ApiError } from '@/lib/api';
import {
  currency,
  decimalsFor,
  InvalidCurrencyError,
  InvalidMajorUnitsError,
  parseMajorUnits,
} from '@vellum/core';

export interface ConfirmState {
  error?: string;
}

// Per-currency major-to-minor conversion. JPY accepts "1000", USD accepts
// "10.50", BHD accepts "1.000". The granular check happens in @vellum/core's
// parseMajorUnits; this regex is a permissive sieve so the zod schema can
// surface a generic error before the per-currency parse runs.
const MAJOR_AMOUNT_LOOSE = /^\d+(\.\d+)?$/;

const formSchema = z.object({
  extractionId: z.string().uuid(),
  debitAccountId: z.string().uuid('pick an expense account'),
  creditAccountId: z.string().uuid('pick a payment account'),
  description: z.string().trim().max(500).optional(),
  total: z.string().regex(MAJOR_AMOUNT_LOOSE, 'total must be a positive decimal').optional(),
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
    // If currency was not also submitted we cannot know how many minor digits
    // the amount carries; fall back to the api's per-request currency.
    const code = parsed.data.currency ?? 'USD';
    let c;
    try {
      c = currency(code);
    } catch {
      return { error: 'currency must be a 3-letter code' };
    }
    try {
      const money = parseMajorUnits(parsed.data.total, c);
      if (money.amount === 0n) return { error: 'total must be greater than zero' };
      if (money.amount < 0n) return { error: 'total must be positive' };
      totalMinor = money.amount.toString();
    } catch (err) {
      if (err instanceof InvalidMajorUnitsError) {
        const d = decimalsFor(c);
        return {
          error:
            d === 0
              ? `total for ${code} must be a whole number`
              : `total for ${code} must have at most ${d} decimal places`,
        };
      }
      if (err instanceof InvalidCurrencyError) {
        return { error: 'currency must be a 3-letter code' };
      }
      throw err;
    }
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
