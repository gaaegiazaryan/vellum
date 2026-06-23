'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { removeItemAction } from './actions';

interface Props {
  itemId: string;
  institutionLabel: string;
}

export function DisconnectButton({ itemId, institutionLabel }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onClick() {
    if (
      !confirm(
        `Disconnect ${institutionLabel}? Imported transactions stay; the link to Plaid is revoked.`,
      )
    ) {
      return;
    }
    start(async () => {
      const res = await removeItemAction(itemId);
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <span className="disconnect">
      <button type="button" onClick={onClick} disabled={pending} className="link-button">
        {pending ? 'Disconnecting…' : 'Disconnect'}
      </button>
      {error && (
        <span className="auth-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
