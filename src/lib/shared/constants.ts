/**
 * Constants shared by the server and the browser.
 *
 * Everything in `$lib/shared` is safe to import from Svelte components: it must not
 * contain secrets, hostnames or anything else that only the server should know about.
 * Server-side configuration lives in `$lib/server/config.ts` instead, which SvelteKit
 * keeps out of the client bundle.
 */

/** Nominal FLUX block time. Used to translate between block counts and wall-clock periods. */
export const BLOCK_TIME_SECONDS = 30;

const SECONDS_PER = {
  HOUR: 60 * 60,
  DAY: 24 * 60 * 60
};

/** The periods the dashboard can display, keyed by id. */
export const PERIODS = {
  '24H': Math.floor(SECONDS_PER.DAY / BLOCK_TIME_SECONDS),
  '7D': Math.floor((7 * SECONDS_PER.DAY) / BLOCK_TIME_SECONDS),
  '30D': Math.floor((30 * SECONDS_PER.DAY) / BLOCK_TIME_SECONDS),
  '90D': Math.floor((90 * SECONDS_PER.DAY) / BLOCK_TIME_SECONDS),
  '6M': Math.floor((180 * SECONDS_PER.DAY) / BLOCK_TIME_SECONDS)
} as const;

export type PeriodId = keyof typeof PERIODS;

export const PERIOD_IDS = Object.keys(PERIODS) as PeriodId[];

/** Human-readable label for each period. */
export const PERIOD_LABELS: Record<PeriodId, string> = {
  '24H': 'Today',
  '7D': 'This Week',
  '30D': 'This Month',
  '90D': 'This Quarter',
  '6M': 'Last 6 Months'
};

export const DEFAULT_PERIOD: PeriodId = '24H';

/** How often the dashboard re-polls for new data. */
export const FRONTEND_REFRESH_INTERVAL = 300_000;

export function isPeriodId(value: string): value is PeriodId {
  return Object.prototype.hasOwnProperty.call(PERIODS, value);
}

/** Number of blocks covered by a period. Falls back to `DEFAULT_PERIOD` for unknown ids. */
export function getPeriodBlocks(period: string): number {
  return isPeriodId(period) ? PERIODS[period] : PERIODS[DEFAULT_PERIOD];
}

/** Whether the synced history is deep enough to render a period without a partial-data warning. */
export function hasEnoughBlocks(blockCount: number, period: string): boolean {
  return blockCount >= getPeriodBlocks(period);
}

/** Convert a block count to a compact `1d 4h` style duration. */
export function blocksToTime(blocks: number): string {
  const totalSeconds = blocks * BLOCK_TIME_SECONDS;
  const days = Math.floor(totalSeconds / SECONDS_PER.DAY);
  const hours = Math.floor((totalSeconds % SECONDS_PER.DAY) / SECONDS_PER.HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER.HOUR) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Convert an hour count to a block count. */
export function timeToBlocks(hours: number): number {
  return Math.floor((hours * SECONDS_PER.HOUR) / BLOCK_TIME_SECONDS);
}
