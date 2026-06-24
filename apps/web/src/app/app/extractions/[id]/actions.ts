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
  debitAccountId: z.string().uuid('pick an expense account').optional(),
  creditAccountId: z.string().uuid('pick a payment account').optional(),
  description: z.string().trim().max(500).optional(),
  total: z.string().regex(MAJOR_AMOUNT_LOOSE, 'total must be a positive decimal').optional(),
  linesJson: z.string().optional(),
  occurredAt: z.string().min(1).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter code')
    .optional(),
  bankTransactionId: z.string().min(1).optional(),
});

const splitLineSchema = z.object({
  side: z.enum(['DEBIT', 'CREDIT']),
  accountId: z.string().uuid(),
  amountMajor: z.string().regex(MAJOR_AMOUNT_LOOSE),
  memo: z.string().trim().min(1).max(500).optional(),
});

export async function confirmExtractionAction(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const parsed = formSchema.safeParse({
    extractionId: formData.get('extractionId'),
    debitAccountId: (formData.get('debitAccountId') as string) || undefined,
    creditAccountId: (formData.get('creditAccountId') as string) || undefined,
    description: (formData.get('description') as string) || undefined,
    total: (formData.get('total') as string)?.trim() || undefined,
    linesJson: (formData.get('linesJson') as string) || undefined,
    occurredAt: (formData.get('occurredAt') as string) || undefined,
    currency: (formData.get('currency') as string)?.toUpperCase() || undefined,
    bankTransactionId: (formData.get('bankTransactionId') as string) || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid form' };
  }
  const { extractionId, linesJson, total: _total, bankTransactionId, ...rest } = parsed.data;
  void _total;

  // The currency code drives major-to-minor conversion on either path,
  // so resolve it once up front and reuse.
  const code = parsed.data.currency ?? 'USD';
  let c;
  try {
    c = currency(code);
  } catch {
    return { error: 'currency must be a 3-letter code' };
  }
  const toMinor = (s: string): { ok: true; v: string } | { ok: false; error: string } => {
    try {
      const m = parseMajorUnits(s, c);
      if (m.amount <= 0n) return { ok: false, error: 'amounts must be positive' };
      return { ok: true, v: m.amount.toString() };
    } catch (err) {
      if (err instanceof InvalidMajorUnitsError) {
        const d = decimalsFor(c);
        return {
          ok: false,
          error:
            d === 0
              ? `amount for ${code} must be a whole number`
              : `amount for ${code} must have at most ${d} decimal places`,
        };
      }
      if (err instanceof InvalidCurrencyError) return { ok: false, error: 'currency invalid' };
      throw err;
    }
  };

  let body: Record<string, unknown>;
  if (linesJson) {
    // Multi-line confirm (ADR-0017).
    let raw: unknown;
    try {
      raw = JSON.parse(linesJson);
    } catch {
      return { error: 'invalid split payload' };
    }
    const linesRes = z.array(splitLineSchema).min(2).safeParse(raw);
    if (!linesRes.success) {
      return { error: linesRes.error.issues[0]?.message ?? 'split rows are invalid' };
    }
    const minorLines: Array<{
      side: string;
      accountId: string;
      amountMinor: string;
      memo?: string;
    }> = [];
    for (const l of linesRes.data) {
      const m = toMinor(l.amountMajor);
      if (!m.ok) return { error: m.error };
      minorLines.push({ side: l.side, accountId: l.accountId, amountMinor: m.v, memo: l.memo });
    }
    const debitSum = minorLines
      .filter((l) => l.side === 'DEBIT')
      .reduce((s, l) => s + BigInt(l.amountMinor), 0n);
    const creditSum = minorLines
      .filter((l) => l.side === 'CREDIT')
      .reduce((s, l) => s + BigInt(l.amountMinor), 0n);
    if (debitSum !== creditSum) {
      return { error: 'sum of debit lines must equal sum of credit lines' };
    }
    body = { ...rest, lines: minorLines };
  } else {
    // Sugar form (ADR-0006). debit + credit accounts are required here;
    // the schema made them optional so the split path could omit them.
    if (!parsed.data.debitAccountId || !parsed.data.creditAccountId) {
      return { error: 'pick a debit and a credit account' };
    }
    if (parsed.data.debitAccountId === parsed.data.creditAccountId) {
      return { error: 'debit and credit accounts must differ' };
    }
    let totalMinor: string | undefined;
    if (parsed.data.total !== undefined) {
      const m = toMinor(parsed.data.total);
      if (!m.ok) return { error: m.error };
      totalMinor = m.v;
    }
    body = { ...rest, ...(totalMinor !== undefined ? { totalMinor } : {}) };
  }

  const client = await apiClient();
  let confirmResult: { journalEntry: { id: string } };
  try {
    confirmResult = await client.post<{ journalEntry: { id: string } }>(
      `/extractions/${extractionId}/confirm`,
      body,
      `confirm-${randomUUID()}`,
    );
  } catch (err) {
    if (err instanceof ApiError) {
      return { error: friendly(err.status, err.body) };
    }
    return { error: 'network error while confirming' };
  }

  // Pair the picked bank transaction (if any) with the freshly-created
  // journal entry. ADR-0019: the user picks the candidate BEFORE the
  // confirm submit, so the pair happens in the same "click confirm"
  // moment. Failure here is non-fatal; the entry exists and the user
  // can pair it manually from /app/banks.
  if (bankTransactionId) {
    try {
      await client.post(
        '/matching/pair',
        { journalEntryId: confirmResult.journalEntry.id, bankTransactionId },
        `pair-${randomUUID()}`,
      );
    } catch {
      // Silent. Entry was created; this is the only place the form
      // submits, so we cannot show a partial-success state without
      // routing the user to a different page first.
    }
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
      case 'non_positive_line':
        return 'every line amount must be greater than zero';
      case 'unbalanced_entry':
        return 'the split rows do not sum to the credit total';
      case 'mixed_body_shape':
        return 'pass either the split rows or the single-account form, not both';
      case 'missing_accounts':
        return 'pick a debit and a credit account';
      default:
        return parsed.message ?? `api error ${status}`;
    }
  } catch {
    return `api error ${status}`;
  }
}
