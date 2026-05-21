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
}: {
  extractionId: string;
  accounts: AccountOption[];
  defaultDescription: string;
}) {
  const [state, formAction, pending] = useActionState(confirmExtractionAction, INITIAL);

  return (
    <form action={formAction} className="upload-form">
      <input type="hidden" name="extractionId" value={extractionId} />

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
