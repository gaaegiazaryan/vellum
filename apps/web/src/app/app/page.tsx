import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiClient, ApiError } from '@/lib/api';
import { currency as toCurrency, formatMinorUnits, Money } from '@vellum/core';

export const metadata = {
  title: 'Vellum',
};

interface LedgerLine {
  id: string;
  accountId: string;
  side: 'DEBIT' | 'CREDIT';
  amount: string;
  memo: string | null;
  position: number;
}

interface Entry {
  id: string;
  occurredAt: string;
  description: string;
  currency: string;
  lines: LedgerLine[];
}

interface ListResponse {
  entries: Entry[];
  nextCursor: string | null;
}

export default async function AppHome() {
  const session = await auth();
  if (!session) redirect('/signin');

  const client = await apiClient();
  let data: ListResponse;
  try {
    data = await client.get<ListResponse>('/journal-entries?limit=20');
  } catch (err) {
    if (err instanceof ApiError) {
      return (
        <main className="auth-page">
          <h1>Ledger</h1>
          <p className="auth-error" role="alert">
            api returned {err.status}; check that the api process is running and reachable.
          </p>
        </main>
      );
    }
    throw err;
  }

  return (
    <main className="ledger">
      <header className="ledger-header">
        <h1>Ledger</h1>
        <p className="muted">
          Signed in as {session.user?.email ?? 'unknown'}.{' '}
          <Link href="/app/entries/new">+ new entry</Link>
          {' · '}
          <Link href="/app/uploads">upload receipt</Link>
        </p>
      </header>

      {data.entries.length === 0 ? (
        <p className="muted">No journal entries yet. Add one to get started.</p>
      ) : (
        <ol className="entries">
          {data.entries.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </ol>
      )}
    </main>
  );
}

function EntryRow({ entry }: { entry: Entry }): React.ReactElement {
  const code = toCurrency(entry.currency);
  const occurredAt = new Date(entry.occurredAt);
  return (
    <li className="entry">
      <div className="entry-head">
        <time dateTime={entry.occurredAt}>{occurredAt.toISOString().slice(0, 10)}</time>
        <span className="entry-description">{entry.description}</span>
        <span className="entry-currency">{entry.currency}</span>
      </div>
      <ul className="entry-lines">
        {entry.lines.map((line) => {
          const money = new Money(BigInt(line.amount), code);
          return (
            <li key={line.id} className={`line line-${line.side.toLowerCase()}`}>
              <span className="line-side">{line.side}</span>
              <span className="line-account" title={line.accountId}>
                {line.accountId.slice(0, 8)}
              </span>
              <span className="line-amount">{formatMinorUnits(money)}</span>
              {line.memo ? <span className="line-memo">{line.memo}</span> : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}
