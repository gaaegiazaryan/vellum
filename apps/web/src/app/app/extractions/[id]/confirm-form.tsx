'use client';

import { useActionState, useMemo, useState } from 'react';
import { confirmExtractionAction, type ConfirmState } from './actions';

export interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

export interface ReceiptTaxLine {
  name: string;
  amountMajor: string;
}

const INITIAL: ConfirmState = {};

interface SplitRow {
  id: number;
  accountId: string;
  amountMajor: string;
  memo: string;
}

let splitRowKey = 0;
const nextKey = (): number => ++splitRowKey;

export function ConfirmForm({
  extractionId,
  accounts,
  defaultDescription,
  defaultTotal,
  defaultOccurredAt,
  defaultCurrency,
  suggestedDebitId,
  suggestedCreditId,
  receiptSubtotalMajor,
  receiptTaxes,
}: {
  extractionId: string;
  accounts: AccountOption[];
  defaultDescription: string;
  defaultTotal: string;
  defaultOccurredAt: string;
  defaultCurrency: string;
  suggestedDebitId?: string | null;
  suggestedCreditId?: string | null;
  receiptSubtotalMajor?: string;
  receiptTaxes?: ReceiptTaxLine[];
}) {
  const accountIds = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);
  const debitDefault = suggestedDebitId && accountIds.has(suggestedDebitId) ? suggestedDebitId : '';
  const creditDefault =
    suggestedCreditId && accountIds.has(suggestedCreditId) ? suggestedCreditId : '';

  const [state, formAction, pending] = useActionState(confirmExtractionAction, INITIAL);
  const [split, setSplit] = useState(false);
  const [debitRows, setDebitRows] = useState<SplitRow[]>(() => [
    { id: nextKey(), accountId: debitDefault, amountMajor: defaultTotal, memo: 'subtotal' },
  ]);
  const [creditAccountId, setCreditAccountId] = useState(creditDefault);
  const [creditAmountMajor, setCreditAmountMajor] = useState(defaultTotal);

  // Live totals on the split path. The values are major-unit decimals
  // (locale-independent dot decimals); a NaN value drops out of the
  // sum so a partial typing state does not silently flip the form to
  // "balanced" when it isn't.
  const debitTotal = sumMajor(debitRows.map((r) => r.amountMajor));
  const creditTotal = sumMajor([creditAmountMajor]);
  const balanced = split
    ? toCents(debitTotal) === toCents(creditTotal) && toCents(debitTotal) > 0
    : true;

  function startSplit(): void {
    setSplit(true);
    // If the receipt has a subtotal + tax breakdown, pre-fill rows
    // from it; otherwise leave the single existing row in place.
    if (receiptSubtotalMajor && receiptTaxes && receiptTaxes.length > 0) {
      const rows: SplitRow[] = [
        {
          id: nextKey(),
          accountId: debitDefault,
          amountMajor: receiptSubtotalMajor,
          memo: 'subtotal',
        },
        ...receiptTaxes.map((t) => ({
          id: nextKey(),
          accountId: '',
          amountMajor: t.amountMajor,
          memo: t.name,
        })),
      ];
      setDebitRows(rows);
    }
  }

  function cancelSplit(): void {
    setSplit(false);
    setDebitRows([
      { id: nextKey(), accountId: debitDefault, amountMajor: defaultTotal, memo: 'subtotal' },
    ]);
    setCreditAmountMajor(defaultTotal);
  }

  function addRow(): void {
    setDebitRows((rs) => [...rs, { id: nextKey(), accountId: '', amountMajor: '', memo: '' }]);
  }

  function removeRow(id: number): void {
    setDebitRows((rs) => (rs.length <= 1 ? rs : rs.filter((r) => r.id !== id)));
  }

  function patchRow(id: number, patch: Partial<SplitRow>): void {
    setDebitRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  // When split, build the JSON payload the server action consumes. Done
  // synchronously off render so the value is up to date when the form
  // submits.
  const linesJson = split
    ? JSON.stringify([
        ...debitRows.map((r) => ({
          side: 'DEBIT',
          accountId: r.accountId,
          amountMajor: r.amountMajor,
          memo: r.memo?.trim() || undefined,
        })),
        {
          side: 'CREDIT',
          accountId: creditAccountId,
          amountMajor: creditAmountMajor,
        },
      ])
    : '';

  return (
    <form action={formAction} className="upload-form">
      <input type="hidden" name="extractionId" value={extractionId} />
      <input type="hidden" name="linesJson" value={linesJson} />

      {!split ? (
        <>
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
        </>
      ) : null}

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

      {!split ? (
        <>
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

          <p className="muted">
            One expense account on the receipt total.{' '}
            <button type="button" className="link-button" onClick={startSplit}>
              + split into multiple lines
            </button>
          </p>
        </>
      ) : (
        <SplitTable
          accounts={accounts}
          debitRows={debitRows}
          creditAccountId={creditAccountId}
          creditAmountMajor={creditAmountMajor}
          debitTotal={debitTotal}
          creditTotal={creditTotal}
          balanced={balanced}
          onAddRow={addRow}
          onRemoveRow={removeRow}
          onPatchRow={patchRow}
          onCreditAccount={setCreditAccountId}
          onCreditAmount={setCreditAmountMajor}
          onCancel={cancelSplit}
        />
      )}

      <label>
        <span>Description</span>
        <input name="description" type="text" maxLength={500} defaultValue={defaultDescription} />
      </label>

      <button type="submit" disabled={pending || !balanced}>
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

function SplitTable({
  accounts,
  debitRows,
  creditAccountId,
  creditAmountMajor,
  debitTotal,
  creditTotal,
  balanced,
  onAddRow,
  onRemoveRow,
  onPatchRow,
  onCreditAccount,
  onCreditAmount,
  onCancel,
}: {
  accounts: AccountOption[];
  debitRows: SplitRow[];
  creditAccountId: string;
  creditAmountMajor: string;
  debitTotal: number;
  creditTotal: number;
  balanced: boolean;
  onAddRow: () => void;
  onRemoveRow: (id: number) => void;
  onPatchRow: (id: number, patch: Partial<SplitRow>) => void;
  onCreditAccount: (v: string) => void;
  onCreditAmount: (v: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <fieldset className="split-fieldset">
      <legend>Split (debit side)</legend>
      <table className="split-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Amount</th>
            <th>Memo</th>
            <th aria-label="remove" />
          </tr>
        </thead>
        <tbody>
          {debitRows.map((r) => (
            <tr key={r.id}>
              <td>
                <select
                  value={r.accountId}
                  onChange={(e) => onPatchRow(r.id, { accountId: e.target.value })}
                  required
                >
                  <option value="" disabled>
                    select account
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
                  type="text"
                  inputMode="decimal"
                  pattern="\d+(\.\d+)?"
                  value={r.amountMajor}
                  onChange={(e) => onPatchRow(r.id, { amountMajor: e.target.value })}
                  required
                />
              </td>
              <td>
                <input
                  type="text"
                  maxLength={500}
                  value={r.memo}
                  onChange={(e) => onPatchRow(r.id, { memo: e.target.value })}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onRemoveRow(r.id)}
                  disabled={debitRows.length <= 1}
                >
                  remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        <button type="button" className="link-button" onClick={onAddRow}>
          + add row
        </button>
      </p>

      <label>
        <span>Credit (paid from)</span>
        <select value={creditAccountId} onChange={(e) => onCreditAccount(e.target.value)} required>
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
        <span>Credit amount</span>
        <input
          type="text"
          inputMode="decimal"
          pattern="\d+(\.\d+)?"
          value={creditAmountMajor}
          onChange={(e) => onCreditAmount(e.target.value)}
          required
        />
      </label>

      <p className={balanced ? 'muted' : 'auth-error'} role="status">
        Debit total: {fmt(debitTotal)} · Credit total: {fmt(creditTotal)}
        {balanced ? ' · balanced' : ' · not balanced'}
      </p>
      <p className="muted">
        <button type="button" className="link-button" onClick={onCancel}>
          cancel split
        </button>
      </p>
    </fieldset>
  );
}

function sumMajor(values: string[]): number {
  let s = 0;
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) s += n;
  }
  return s;
}

function toCents(n: number): number {
  // Avoid floating-point sum mismatches by comparing rounded
  // hundredths. Currency-specific scaling lives on the api side; the
  // banner just needs "do the rendered totals match?" which is 2dp in
  // every realistic case for the live indicator.
  return Math.round(n * 100);
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '-';
}
