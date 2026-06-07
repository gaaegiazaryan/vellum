'use client';

import { useActionState } from 'react';
import { confirmExtractionAction, type ConfirmState } from './actions';

export interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

const INITIAL: ConfirmState = {};

export function ConfirmForm({
  extractionId,
  accounts,
  defaultDescription,
  defaultTotal,
  defaultOccurredAt,
  defaultCurrency,
  suggestedDebitId,
  suggestedCreditId,
}: {
  extractionId: string;
  accounts: AccountOption[];
  defaultDescription: string;
  defaultTotal: string;
  defaultOccurredAt: string;
  defaultCurrency: string;
  suggestedDebitId?: string | null;
  suggestedCreditId?: string | null;
}) {
  // Only honor a suggestion if it points at an account that actually exists
  // in the chart we just rendered; an orphaned id would silently render as
  // "no selection" and confuse the user.
  const accountIds = new Set(accounts.map((a) => a.id));
  const debitDefault = suggestedDebitId && accountIds.has(suggestedDebitId) ? suggestedDebitId : '';
  const creditDefault =
    suggestedCreditId && accountIds.has(suggestedCreditId) ? suggestedCreditId : '';
  const [state, formAction, pending] = useActionState(confirmExtractionAction, INITIAL);

  return (
    <form action={formAction} className="upload-form">
      <input type="hidden" name="extractionId" value={extractionId} />

      <label>
        <span>Total</span>
        <input
          name="total"
          type="text"
          inputMode="decimal"
          pattern="\d+(\.\d+)?"
          placeholder={defaultTotal || '0'}
          defaultValue={defaultTotal}
          required
        />
      </label>

      <label>
        <span>Date</span>
        <input name="occurredAt" type="date" defaultValue={defaultOccurredAt} required />
      </label>

      <label>
        <span>Currency</span>
        <input
          name="currency"
          type="text"
          maxLength={3}
          pattern="[A-Za-z]{3}"
          defaultValue={defaultCurrency}
          required
        />
      </label>

      <label>
        <span>Debit (expense account)</span>
        <select name="debitAccountId" defaultValue={debitDefault} required>
          <option value="" disabled>
            select account
          </option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name} ({a.type})
            </option>
          ))}
        </select>
      </label>

      <label>
        <span>Credit (paid from)</span>
        <select name="creditAccountId" defaultValue={creditDefault} required>
          <option value="" disabled>
            select account
          </option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name} ({a.type})
            </option>
          ))}
        </select>
      </label>

      <label>
        <span>Description</span>
        <input name="description" type="text" maxLength={500} defaultValue={defaultDescription} />
      </label>

      <button type="submit" disabled={pending}>
        {pending ? 'Posting entry...' : 'Confirm and create journal entry'}
      </button>

      {state.error ? (
        <p className="auth-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
