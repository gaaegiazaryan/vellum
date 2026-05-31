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
}: {
  extractionId: string;
  accounts: AccountOption[];
  defaultDescription: string;
  defaultTotal: string;
  defaultOccurredAt: string;
  defaultCurrency: string;
}) {
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
          pattern="\d+(\.\d{1,2})?"
          placeholder="0.00"
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
        <select name="debitAccountId" defaultValue="" required>
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
        <select name="creditAccountId" defaultValue="" required>
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
