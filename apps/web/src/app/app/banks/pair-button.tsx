'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { pairAction, suggestForBankAction, type EntrySuggestion } from './actions';
import { formatMoney } from '@/lib/money';

interface Props {
  bankTransactionId: string;
}

/**
 * Two-step opt-in pairing. The user clicks "Pair"; we fetch the top-3
 * candidate journal entries via /matching/suggest-for-bank; the picker
 * opens inline. On select we POST /matching/pair and router.refresh()
 * the page (revalidatePath in the action also drops the cache).
 *
 * If the fetch returns no candidates the picker shows a clear empty
 * state so the user knows there is nothing to pair to (not a UI bug).
 */
export function PairButton({ bankTransactionId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, startLoading] = useTransition();
  const [pairing, startPair] = useTransition();
  const [suggestions, setSuggestions] = useState<EntrySuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onOpen() {
    setError(null);
    setOpen(true);
    startLoading(async () => {
      const res = await suggestForBankAction(bankTransactionId);
      if (res.error) {
        setError(res.error);
        setSuggestions([]);
        return;
      }
      setSuggestions(res.suggestions ?? []);
    });
  }

  function onClose() {
    setOpen(false);
    setSuggestions(null);
    setError(null);
  }

  function onPick(journalEntryId: string) {
    startPair(async () => {
      const res = await pairAction(journalEntryId, bankTransactionId);
      if (res.error) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button type="button" onClick={onOpen} className="link-button">
        Pair
      </button>
    );
  }

  return (
    <div className="pair-picker">
      <header>
        <span>Pair with an entry</span>
        <button type="button" onClick={onClose} className="link-button">
          close
        </button>
      </header>
      {loading ? (
        <p className="hint">Looking for candidates…</p>
      ) : error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : !suggestions || suggestions.length === 0 ? (
        <p className="hint">No matching journal entries within 7 days at this amount and vendor.</p>
      ) : (
        <ul>
          {suggestions.map((s) => (
            <li key={s.journalEntryId}>
              <button
                type="button"
                onClick={() => onPick(s.journalEntryId)}
                disabled={pairing}
                className="pair-candidate"
              >
                <span className="description">{s.description}</span>
                <span className="amount">{formatMoney(s.totalMinor, s.currency)}</span>
                <span className="date">{s.occurredAt.slice(0, 10)}</span>
                <span className="score" title="match confidence">
                  {Math.round(s.score * 100)}%
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
