import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiClient, ApiError } from '@/lib/api';
import { ConfirmForm, type AccountOption } from './confirm-form';
import { AutoRefresh } from './auto-refresh';

export const metadata = {
  title: 'Review extraction - Vellum',
};

interface ReceiptView {
  vendor: { name: string };
  occurredAt: string;
  currency: string;
  subtotalMinor: string;
  taxes: Array<{ name: string; amountMinor: string }>;
  totalMinor: string;
  paymentMethod?: string;
  lineItems: Array<{ description: string; quantity: number; totalMinor: string }>;
}

interface ExtractionView {
  id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'needs_review';
  confidence: string | null;
  receipt: ReceiptView | null;
  journalEntryId: string | null;
  errorMessage: string | null;
}

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
}

function formatMinor(minor: string, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return `${currency} ${minor}`;
  return `${currency} ${(n / 100).toFixed(2)}`;
}

export default async function ReviewExtractionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session) redirect('/signin');

  const { id } = await params;
  const client = await apiClient();

  let extraction: ExtractionView;
  try {
    extraction = await client.get<ExtractionView>(`/extractions/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return (
        <main className="ledger">
          <header className="ledger-header">
            <h1>Review extraction</h1>
            <p className="muted">
              No extraction with id <code>{id}</code>.{' '}
              <Link href="/app/uploads">upload a receipt</Link>
            </p>
          </header>
        </main>
      );
    }
    throw err;
  }

  if (extraction.journalEntryId) {
    return (
      <main className="ledger">
        <header className="ledger-header">
          <h1>Already confirmed</h1>
          <p className="muted">
            This receipt was turned into journal entry{' '}
            <code>{extraction.journalEntryId.slice(0, 8)}</code>.{' '}
            <Link href="/app">back to ledger</Link>
          </p>
        </header>
      </main>
    );
  }

  if (extraction.status === 'pending') {
    return (
      <main className="ledger">
        <header className="ledger-header">
          <h1>Extracting...</h1>
          <p className="muted">
            The model is reading this receipt. This page updates itself when it is done.{' '}
            <Link href="/app/uploads">back to uploads</Link>
          </p>
        </header>
        <AutoRefresh />
      </main>
    );
  }

  if (extraction.status === 'failed' || !extraction.receipt) {
    return (
      <main className="ledger">
        <header className="ledger-header">
          <h1>Nothing to confirm</h1>
          <p className="muted">
            {extraction.errorMessage ?? 'this extraction has no parsed receipt.'}{' '}
            <Link href="/app/uploads">try another upload</Link>
          </p>
        </header>
      </main>
    );
  }

  const receipt = extraction.receipt;
  const mismatch =
    BigInt(receipt.subtotalMinor) +
    receipt.taxes.reduce((sum, t) => sum + BigInt(t.amountMinor), 0n) -
    BigInt(receipt.totalMinor);
  const lowConfidence = extraction.status === 'needs_review';

  let accounts: AccountOption[] = [];
  try {
    const data = await client.get<{ accounts: AccountRow[] }>('/accounts');
    accounts = data.accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type }));
  } catch (err) {
    if (err instanceof ApiError) {
      return (
        <main className="ledger">
          <header className="ledger-header">
            <h1>Review extraction</h1>
            <p className="auth-error" role="alert">
              api returned {err.status} fetching accounts.
            </p>
          </header>
        </main>
      );
    }
    throw err;
  }

  return (
    <main className="ledger">
      <header className="ledger-header">
        <h1>Review {receipt.vendor.name}</h1>
        <p className="muted">
          {new Date(receipt.occurredAt).toLocaleDateString()} ·{' '}
          {formatMinor(receipt.totalMinor, receipt.currency)}
          {extraction.confidence ? ` · confidence ${extraction.confidence}` : ''}{' '}
          <Link href="/app/uploads">cancel</Link>
        </p>
      </header>

      {lowConfidence ? (
        <p className="auth-error" role="alert">
          Low confidence extraction. Check the parsed values against the receipt before confirming.
        </p>
      ) : null}

      {mismatch !== 0n ? (
        <p className="auth-error" role="alert">
          Subtotal plus taxes does not equal the total (off by {mismatch.toString()} minor units).
          The entry will post for the total; fix the receipt source if that is wrong.
        </p>
      ) : null}

      <ul className="entries">
        {receipt.lineItems.map((item, i) => (
          <li key={i}>
            {item.quantity} × {item.description} · {formatMinor(item.totalMinor, receipt.currency)}
          </li>
        ))}
      </ul>

      {accounts.length < 2 ? (
        <p className="muted">
          You need at least two accounts before you can post an entry. Seed the chart of accounts
          via <code>pnpm --filter @vellum/api db:seed</code>.
        </p>
      ) : (
        <ConfirmForm
          extractionId={extraction.id}
          accounts={accounts}
          defaultDescription={receipt.vendor.name}
          defaultTotalMinor={receipt.totalMinor}
          defaultOccurredAt={new Date(receipt.occurredAt).toISOString().slice(0, 10)}
          defaultCurrency={receipt.currency}
        />
      )}
    </main>
  );
}
