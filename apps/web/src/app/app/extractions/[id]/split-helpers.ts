/**
 * Pure helpers for the ConfirmForm split path (ADR-0017). Lifted out
 * of the component so they can be unit-tested without rendering a
 * React tree. The component layer stays focused on state plumbing
 * and JSX.
 *
 * The balance check here is the client-side UX hint, not the
 * authoritative posting check; the server action re-validates with
 * BigInt math through @vellum/core.parseMajorUnits. These helpers
 * only need to be correct enough to disable the submit button.
 */

export interface SplitDebitRow {
  accountId: string;
  amountMajor: string;
  memo: string;
}

export interface SerializedSplitLine {
  side: 'DEBIT' | 'CREDIT';
  accountId: string;
  amountMajor: string;
  memo?: string;
}

/**
 * Sum an array of major-unit decimal strings, ignoring entries that
 * do not parse as numbers (a half-typed field or an empty cell). The
 * caller treats a NaN-only column as zero, which is the right thing
 * for the live indicator (no flicker from "" to NaN to a real number
 * during typing).
 */
export function sumMajor(values: readonly string[]): number {
  let s = 0;
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) s += n;
  }
  return s;
}

/**
 * Comparable representation for the balance check. Rounding to
 * hundredths avoids float drift cases like 0.1 + 0.2 != 0.3 from
 * silently flipping the submit button. The api side does the
 * currency-precise check in BigInt; this is the UX hint only.
 */
export function toCents(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function isBalanced(debits: readonly string[], credits: readonly string[]): boolean {
  const d = toCents(sumMajor(debits));
  const c = toCents(sumMajor(credits));
  return d > 0 && d === c;
}

/**
 * Build the JSON payload the server action consumes when split mode
 * is active. memo is dropped when empty so the server schema does
 * not have to special-case the empty-string case.
 */
export function buildLinesJson(
  debitRows: readonly SplitDebitRow[],
  credit: { accountId: string; amountMajor: string },
): string {
  const lines: SerializedSplitLine[] = [
    ...debitRows.map((r) => ({
      side: 'DEBIT' as const,
      accountId: r.accountId,
      amountMajor: r.amountMajor,
      ...(r.memo.trim() ? { memo: r.memo.trim() } : {}),
    })),
    {
      side: 'CREDIT' as const,
      accountId: credit.accountId,
      amountMajor: credit.amountMajor,
    },
  ];
  return JSON.stringify(lines);
}
