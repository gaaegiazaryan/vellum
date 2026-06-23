import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiClient, ApiError } from '@/lib/api';
import { LinkLauncher } from './link-launcher';
import { DisconnectButton } from './disconnect-button';

export const metadata = {
  title: 'Banks — Vellum',
};

interface PlaidAccount {
  id: string;
  plaidAccountId: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  currency: string;
}

interface PlaidItem {
  id: string;
  plaidItemId: string;
  institutionName: string | null;
  status: string;
  lastSyncAt: string | null;
  createdAt: string;
  accounts: PlaidAccount[];
}

interface ListResponse {
  items: PlaidItem[];
}

export default async function BanksPage() {
  const session = await auth();
  if (!session) redirect('/signin');

  const client = await apiClient();
  let data: ListResponse | null = null;
  let plaidEnabled = true;
  let loadError: string | null = null;
  try {
    data = await client.get<ListResponse>('/plaid/items');
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // PlaidModule.forRoot returns an empty DynamicModule when
      // PLAID_ENABLED is false; the route literally does not exist.
      // Render the page with a hint instead of a hard error.
      plaidEnabled = false;
    } else if (err instanceof ApiError) {
      loadError = `api returned ${err.status}`;
    } else {
      loadError = 'network error while loading connected banks';
    }
  }

  return (
    <main className="banks-page">
      <header>
        <h1>Banks</h1>
        <p className="lede">
          Connect a bank to import transactions. Imports land in their own table; the matching flow
          pairs them with confirmed receipts.
        </p>
      </header>

      {loadError && (
        <p className="auth-error" role="alert">
          {loadError}
        </p>
      )}

      <section>
        <LinkLauncher enabled={plaidEnabled} />
      </section>

      {plaidEnabled && (
        <section>
          <h2>Connected ({data?.items.length ?? 0})</h2>
          {!data || data.items.length === 0 ? (
            <p className="hint">No banks connected yet.</p>
          ) : (
            <ul className="bank-list">
              {data.items.map((item) => (
                <li key={item.id} className="bank-card">
                  <div className="bank-card-header">
                    <h3>{item.institutionName ?? 'Unnamed institution'}</h3>
                    <BankStatus status={item.status} lastSyncAt={item.lastSyncAt} />
                  </div>
                  <ul className="account-list">
                    {item.accounts.length === 0 ? (
                      <li className="hint">No accounts on this item yet.</li>
                    ) : (
                      item.accounts.map((a) => (
                        <li key={a.id} className="account-row">
                          <span className="account-name">{a.officialName ?? a.name}</span>
                          <span className="account-meta">
                            {a.subtype ?? a.type}
                            {a.mask ? ` · …${a.mask}` : ''} · {a.currency}
                          </span>
                        </li>
                      ))
                    )}
                  </ul>
                  <div className="bank-card-footer">
                    <DisconnectButton
                      itemId={item.id}
                      institutionLabel={item.institutionName ?? 'this bank'}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <nav className="back-nav">
        <Link href="/app">Back to ledger</Link>
      </nav>
    </main>
  );
}

function BankStatus({ status, lastSyncAt }: { status: string; lastSyncAt: string | null }) {
  const label = lastSyncAt ? `synced ${formatRelative(lastSyncAt)}` : 'never synced';
  return (
    <span className={`bank-status status-${status}`}>
      {status} · {label}
    </span>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
