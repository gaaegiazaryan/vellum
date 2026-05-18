import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiClient, ApiError } from '@/lib/api';
import { NewEntryForm, type AccountOption } from './form';

export const metadata = {
  title: 'New entry - Vellum',
};

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
}

export default async function NewEntryPage() {
  const session = await auth();
  if (!session) redirect('/signin');

  const client = await apiClient();
  let accounts: AccountOption[] = [];
  try {
    const data = await client.get<{ accounts: AccountRow[] }>('/accounts');
    accounts = data.accounts.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
    }));
  } catch (err) {
    if (err instanceof ApiError) {
      return (
        <main className="auth-page">
          <h1>New entry</h1>
          <p className="auth-error" role="alert">
            api returned {err.status} fetching accounts.
          </p>
        </main>
      );
    }
    throw err;
  }

  if (accounts.length < 2) {
    return (
      <main className="auth-page">
        <h1>New entry</h1>
        <p>
          You need at least two accounts before you can write a journal entry. Seed the chart of
          accounts via <code>pnpm --filter @vellum/api db:seed</code> or add accounts through{' '}
          <code>POST /accounts</code> on the api.
        </p>
        <p>
          <Link href="/app">back to ledger</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="ledger">
      <header className="ledger-header">
        <h1>New journal entry</h1>
        <p className="muted">
          Debits must equal credits. All lines share one currency. <Link href="/app">cancel</Link>
        </p>
      </header>
      <NewEntryForm accounts={accounts} />
    </main>
  );
}
