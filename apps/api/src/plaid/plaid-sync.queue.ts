export const PLAID_SYNC_QUEUE_NAME = 'plaid-sync';
export const PLAID_SYNC_QUEUE = Symbol('PLAID_SYNC_QUEUE');

/**
 * Two job shapes share one queue (BullMQ dispatches by name). 'tick'
 * runs on the 15-minute repeatable schedule and enqueues per-item
 * 'sync-item' jobs for any plaid_item whose last_sync_at is older than
 * the freshness window. 'sync-item' runs one /transactions/sync round
 * for one item.
 */
export type PlaidSyncJobData = { kind: 'tick' } | { kind: 'sync-item'; plaidItemRowId: string };

export const SYNC_TICK_INTERVAL_MS = 15 * 60 * 1000;
export const SYNC_FRESHNESS_WINDOW_MS = 10 * 60 * 1000;
