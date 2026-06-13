import { apiClient } from '@/lib/api';

interface BudgetTodayResponse {
  spentUsd: string;
  spentByMeUsd: string;
  resetAt: string;
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
  let data: BudgetTodayResponse;
  try {
    const client = await apiClient();
    data = await client.get<BudgetTodayResponse>('/budget/today');
  } catch {
    return null;
  }

  const total = Number(data.spentUsd);
  const mine = Number(data.spentByMeUsd);
  if (!Number.isFinite(total) || total === 0) return null;

  const reset = new Date(data.resetAt);
  const resetLabel = reset.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const showMine = Number.isFinite(mine) && mine > 0 && mine !== total;

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
    </p>
  );
}
