'use client';

import { useState } from 'react';

export interface BankSuggestion {
  bankTransactionId: string;
  occurredAt: string;
  amountMinor: string;
  currency: string;
  merchantName: string | null;
  description: string | null;
  score: number;
}

interface Props {
  suggestions: BankSuggestion[];
}

/**
 * Renders top-N (max 3 server-side per ADR-0019) bank transaction
 * candidates above the submit button. Default selection is none (the
 * user opts in); the picked id rides through the confirm submit as a
 * hidden input named bankTransactionId and the api pairs it with the
 * freshly-created journal entry. Selecting nothing is equivalent to
 * "skip" - the entry is still created, the bank row stays unmatched
 * and the user can pair from /app/banks later.
 */
export function BankSuggestionPicker({ suggestions }: Props) {
  const [selected, setSelected] = useState<string>('');

  if (suggestions.length === 0) return null;

  return (
    <fieldset className="bank-suggestion-picker">
      <legend>Matching bank charges</legend>
      <p className="hint">
        Pick one to link this receipt to a bank row. Skip to leave it unpaired.
      </p>
      <ul>
        {suggestions.map((s) => (
          <li key={s.bankTransactionId}>
            <label>
              <input
                type="radio"
                name="bankTransactionId"
                value={s.bankTransactionId}
                checked={selected === s.bankTransactionId}
                onChange={() => setSelected(s.bankTransactionId)}
              />
              <span className="merchant">{s.merchantName ?? s.description ?? 'Unnamed'}</span>
              <span className="amount">{formatMoney(s.amountMinor, s.currency)}</span>
              <span className="date">{formatDate(s.occurredAt)}</span>
              <span className="score" title="match confidence">
                {Math.round(s.score * 100)}%
              </span>
            </label>
          </li>
        ))}
      </ul>
      <label className="skip">
        <input
          type="radio"
          name="bankTransactionId"
          value=""
          checked={selected === ''}
          onChange={() => setSelected('')}
        />
        Skip - leave the bank row unmatched for now
      </label>
    </fieldset>
  );
}

function formatMoney(minorStr: string, currency: string): string {
  // v1 assumes 2-decimal currencies on this surface (matches the
  // existing confirm form's hardcoding). The per-currency-scale
  // refactor on Day 17+ list applies here too when it lands.
  const cents = Number(minorStr);
  if (!Number.isFinite(cents)) return `${minorStr} ${currency}`;
  const major = (cents / 100).toFixed(2);
  return `${major} ${currency}`;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}
