import { apiClient } from '@/lib/api';

interface BudgetTodayResponse {
  spentUsd: string;
  spentByMeUsd: string;
  resetAt: string;
}

interface FallbackStatsResponse {
  total: number;
  fellBack: number;
  byReason: Record<string, number>;
  byPrimary: Record<string, number>;
  since: string;
  until: string;
}

/**
 * Quiet header line that shows how much the api has spent on AI
 * extractions today. Server component, refetches with every page
 * navigation; the api's own /budget/today is a single grouped SQL
 * query, cheap enough at this volume.
 *
 * Renders nothing on api errors (the banner is not load-bearing for
 * the ledger view) and nothing when both numbers are zero (a fresh
 * deploy should not show a "you spent $0" line).
 */
export async function BudgetBanner(): Promise<React.ReactElement | null> {
  const client = await apiClient();
  // Two endpoints run in parallel; either error individually drops out
  // of the banner without taking the other down. Banner is not
  // load-bearing for the ledger view.
  const [budget, fallback] = await Promise.all([
    client.get<BudgetTodayResponse>('/budget/today').catch(() => null),
    client.get<FallbackStatsResponse>('/extractions/fallback-stats').catch(() => null),
  ]);

  if (budget === null) return null;
  const total = Number(budget.spentUsd);
  const mine = Number(budget.spentByMeUsd);
  if (!Number.isFinite(total) || total === 0) return null;

  const reset = new Date(budget.resetAt);
  const resetLabel = reset.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const showMine = Number.isFinite(mine) && mine > 0 && mine !== total;

  // Surface fallback usage only when it actually happened today; a
  // healthy primary should not surface at all so the banner stays
  // quiet by default. Reasons appear sorted by count so the operator
  // can read the most-common failure first.
  const fallbackHint = fallback && fallback.fellBack > 0 ? renderFallbackHint(fallback) : null;

  return (
    <p className="muted budget-banner">
      Extraction spend today: <strong>${total.toFixed(2)}</strong>
      {showMine ? (
        <>
          {' '}
          (you: <strong>${mine.toFixed(2)}</strong>)
        </>
      ) : null}{' '}
      · resets at {resetLabel}
      {fallbackHint}
    </p>
  );
}

function renderFallbackHint(f: FallbackStatsResponse): React.ReactElement {
  const reasonEntries = Object.entries(f.byReason).sort((a, b) => b[1] - a[1]);
  const summary = reasonEntries.map(([reason, n]) => `${n} ${shortReason(reason)}`).join(', ');
  return (
    <>
      {' · '}
      <span className="auth-error">
        primary degraded: {f.fellBack} of {f.total} fell back ({summary})
      </span>
    </>
  );
}

function shortReason(reason: string): string {
  if (reason === 'ProviderTimeoutError') return 'timeouts';
  if (reason === 'InvalidProviderResponseError') return 'bad responses';
  return reason;
}
