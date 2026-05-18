'use client';

import { useActionState, useState } from 'react';
import { createEntryAction, type NewEntryState } from './actions';

export interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface LineDraft {
  accountId: string;
  side: 'DEBIT' | 'CREDIT';
  amount: string;
  memo: string;
}

const INITIAL_STATE: NewEntryState = {};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function newLine(side: 'DEBIT' | 'CREDIT'): LineDraft {
  return { accountId: '', side, amount: '', memo: '' };
}

export function NewEntryForm({ accounts }: { accounts: AccountOption[] }) {
  const [state, formAction, pending] = useActionState(createEntryAction, INITIAL_STATE);
  const [lines, setLines] = useState<LineDraft[]>([newLine('DEBIT'), newLine('CREDIT')]);

  const debitTotal = totalForSide(lines, 'DEBIT');
  const creditTotal = totalForSide(lines, 'CREDIT');
  const balanced = debitTotal === creditTotal && debitTotal > 0n;

  function updateLine(index: number, patch: Partial<LineDraft>): void {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine(): void {
    setLines((prev) => [...prev, newLine('DEBIT')]);
  }

  function removeLine(index: number): void {
    setLines((prev) => (prev.length > 2 ? prev.filter((_, i) => i !== index) : prev));
  }

  return (
    <form action={formAction} className="entry-form">
      <div className="row">
        <label className="grow">
          <span>Description</span>
          <input
            name="description"
            type="text"
            required
            maxLength={500}
            placeholder="invoice #42 paid"
          />
        </label>
        <label>
          <span>Date</span>
          <input name="occurredAt" type="date" required defaultValue={todayIso()} />
        </label>
        <label>
          <span>Currency</span>
          <input
            name="currency"
            type="text"
            required
            defaultValue="USD"
            pattern="[A-Z]{3}"
            maxLength={3}
          />
        </label>
      </div>

      <table className="lines-table">
        <thead>
          <tr>
            <th>Side</th>
            <th>Account</th>
            <th className="amount">Amount (minor units)</th>
            <th>Memo</th>
            <th aria-label="remove" />
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td>
                <select
                  name={`lines[${i}].side`}
                  value={line.side}
                  onChange={(e) => updateLine(i, { side: e.target.value as 'DEBIT' | 'CREDIT' })}
                >
                  <option value="DEBIT">DEBIT</option>
                  <option value="CREDIT">CREDIT</option>
                </select>
              </td>
              <td>
                <select
                  name={`lines[${i}].accountId`}
                  value={line.accountId}
                  onChange={(e) => updateLine(i, { accountId: e.target.value })}
                  required
                >
                  <option value="" disabled>
                    pick an account
                  </option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name} ({a.type})
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  name={`lines[${i}].amount`}
                  type="text"
                  inputMode="numeric"
                  pattern="\d+"
                  required
                  value={line.amount}
                  onChange={(e) => updateLine(i, { amount: e.target.value })}
                  placeholder="1500"
                />
              </td>
              <td>
                <input
                  name={`lines[${i}].memo`}
                  type="text"
                  maxLength={500}
                  value={line.memo}
                  onChange={(e) => updateLine(i, { memo: e.target.value })}
                  placeholder="optional"
                />
              </td>
              <td>
                {lines.length > 2 ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => removeLine(i)}
                    aria-label={`remove line ${i + 1}`}
                  >
                    remove
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>
              <button type="button" className="link-button" onClick={addLine}>
                + add line
              </button>
            </td>
            <td className="amount">
              D: {debitTotal.toString()} C: {creditTotal.toString()}
            </td>
            <td colSpan={2}>
              {balanced ? (
                <span className="muted">balanced</span>
              ) : (
                <span className="auth-error">debits and credits must match</span>
              )}
            </td>
          </tr>
        </tfoot>
      </table>

      {state.error ? (
        <p className="auth-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <button type="submit" disabled={pending || !balanced}>
        {pending ? 'Saving...' : 'Save entry'}
      </button>
    </form>
  );
}

function totalForSide(lines: LineDraft[], side: 'DEBIT' | 'CREDIT'): bigint {
  let total = 0n;
  for (const line of lines) {
    if (line.side !== side) continue;
    if (!/^\d+$/.test(line.amount)) continue;
    total += BigInt(line.amount);
  }
  return total;
}
