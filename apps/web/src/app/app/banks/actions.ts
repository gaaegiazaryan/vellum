'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { apiClient, ApiError } from '@/lib/api';

export interface LinkTokenResult {
  linkToken?: string;
  error?: string;
}

/**
 * Server action proxy to POST /plaid/link-token. The web side never
 * holds Plaid credentials; the api mints a short-lived token bound to
 * the requesting user's id and returns it so the browser-side Link
 * drop-in can open.
 */
export async function createLinkTokenAction(): Promise<LinkTokenResult> {
  const client = await apiClient();
  try {
    const { linkToken } = await client.post<{ linkToken: string; expiration: string }>(
      '/plaid/link-token',
      {},
      randomUUID(),
    );
    return { linkToken };
  } catch (err) {
    return { error: friendlyApiError(err, 'could not start a Plaid Link session') };
  }
}

export interface ExchangeResult {
  itemId?: string;
  error?: string;
}

/**
 * Server action proxy to POST /plaid/exchange. On success the api has
 * already enqueued a first-time sync job; we revalidate the banks
 * route so the page rerenders with the new connection.
 */
export async function exchangePublicTokenAction(publicToken: string): Promise<ExchangeResult> {
  if (!publicToken || typeof publicToken !== 'string') {
    return { error: 'missing public token' };
  }
  const client = await apiClient();
  try {
    const { itemId } = await client.post<{ itemId: string }>(
      '/plaid/exchange',
      { publicToken },
      randomUUID(),
    );
    revalidatePath('/app/banks');
    return { itemId };
  } catch (err) {
    return { error: friendlyApiError(err, 'could not finish connecting the bank') };
  }
}

export interface RemoveItemResult {
  ok?: true;
  error?: string;
}

export async function removeItemAction(plaidItemRowId: string): Promise<RemoveItemResult> {
  if (!plaidItemRowId) return { error: 'missing item id' };
  const client = await apiClient();
  try {
    await client.delete(`/plaid/items/${encodeURIComponent(plaidItemRowId)}`);
    revalidatePath('/app/banks');
    return { ok: true };
  } catch (err) {
    return { error: friendlyApiError(err, 'could not disconnect the bank') };
  }
}

export interface EntrySuggestion {
  journalEntryId: string;
  occurredAt: string;
  description: string;
  totalMinor: string;
  currency: string;
  vendorName: string | null;
  score: number;
}

export interface SuggestForBankResult {
  suggestions?: EntrySuggestion[];
  error?: string;
}

export async function suggestForBankAction(
  bankTransactionId: string,
): Promise<SuggestForBankResult> {
  if (!bankTransactionId) return { error: 'missing bank transaction id' };
  const client = await apiClient();
  try {
    const res = await client.get<{ suggestions: EntrySuggestion[] }>(
      `/matching/suggest-for-bank/${encodeURIComponent(bankTransactionId)}`,
    );
    return { suggestions: res.suggestions };
  } catch (err) {
    return { error: friendlyApiError(err, 'could not load candidate entries') };
  }
}

export interface PairResult {
  ok?: true;
  error?: string;
}

export async function pairAction(
  journalEntryId: string,
  bankTransactionId: string,
): Promise<PairResult> {
  if (!journalEntryId || !bankTransactionId) return { error: 'missing ids' };
  const client = await apiClient();
  try {
    await client.post(
      '/matching/pair',
      { journalEntryId, bankTransactionId },
      `pair-${bankTransactionId}-${journalEntryId}`,
    );
    revalidatePath('/app/banks');
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError) {
      // Pin the audit-fixed error slugs so the UI can tell the user
      // exactly why a race lost: someone else paired this row first,
      // or the entry was already claimed.
      try {
        const body = JSON.parse(err.body) as { error?: string };
        if (body.error === 'bank_transaction_already_paired') {
          return { error: 'someone else paired this bank row already' };
        }
        if (body.error === 'journal_entry_already_paired') {
          return { error: 'this journal entry is already paired with another bank charge' };
        }
        if (body.error === 'currency_mismatch') {
          return { error: 'currency does not match' };
        }
      } catch {
        // Fall through to the generic message
      }
    }
    return { error: friendlyApiError(err, 'could not pair') };
  }
}

function friendlyApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'session expired; sign in again';
    if (err.status === 404) return 'plaid is not configured on this server';
    return `${fallback} (api ${err.status})`;
  }
  return fallback;
}
