'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { usePlaidLink } from 'react-plaid-link';
import { createLinkTokenAction, exchangePublicTokenAction } from './actions';

interface Props {
  enabled: boolean;
}

/**
 * Two-step launcher. The user clicks "Connect a bank"; we fetch a
 * short-lived link token from /plaid/link-token via a server action
 * (the api owns the Plaid credentials), then open the Plaid Link
 * drop-in with that token. On success the drop-in returns a
 * public_token which we exchange via /plaid/exchange. The api seals
 * the access token, persists items + accounts, and enqueues a first
 * sync job; we router.refresh() to pick up the new row.
 *
 * Token is fetched lazily on click rather than on mount so the user
 * doesn't burn a token unless they actually launch.
 */
export function LinkLauncher({ enabled }: Props) {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingExchange, startExchange] = useTransition();
  const launchOnReadyRef = useRef(false);

  const onSuccess = useCallback(
    (publicToken: string) => {
      startExchange(async () => {
        const res = await exchangePublicTokenAction(publicToken);
        if (res.error) {
          setError(res.error);
          setLinkToken(null);
          return;
        }
        setLinkToken(null);
        router.refresh();
      });
    },
    [router, startExchange],
  );

  const onExit = useCallback(() => {
    setLinkToken(null);
    launchOnReadyRef.current = false;
  }, []);

  const { open, ready } = usePlaidLink({
    token: linkToken ?? '',
    onSuccess,
    onExit,
  });

  // usePlaidLink can take a tick after `token` is set before `ready`
  // flips. Auto-open the moment it does, only when the user has
  // actively asked.
  useEffect(() => {
    if (linkToken && ready && launchOnReadyRef.current) {
      launchOnReadyRef.current = false;
      open();
    }
  }, [linkToken, ready, open]);

  async function handleClick() {
    setError(null);
    launchOnReadyRef.current = true;
    const res = await createLinkTokenAction();
    if (res.error || !res.linkToken) {
      setError(res.error ?? 'could not create a link token');
      launchOnReadyRef.current = false;
      return;
    }
    setLinkToken(res.linkToken);
  }

  if (!enabled) {
    return (
      <p className="hint">
        Plaid is not configured on this server. Set <code>PLAID_ENABLED=true</code> and the
        corresponding <code>PLAID_*</code> credentials to connect a bank.
      </p>
    );
  }

  return (
    <div className="link-launcher">
      <button type="button" onClick={handleClick} disabled={pendingExchange}>
        {pendingExchange ? 'Connecting…' : 'Connect a bank'}
      </button>
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
