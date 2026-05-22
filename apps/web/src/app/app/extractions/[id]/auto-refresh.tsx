'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-runs the server component on an interval so a pending extraction
 * page picks up the worker's result without the user reloading. Renders
 * nothing; it just polls via router.refresh(). Mounted only while the
 * extraction is pending, so it stops once a terminal state renders.
 */
export function AutoRefresh({ intervalMs = 1500 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
