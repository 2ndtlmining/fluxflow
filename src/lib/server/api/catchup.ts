/**
 * Whether the stored chain is still catching up with the network, for the status bar.
 *
 * A fresh deployment syncs six months of history oldest-first, forward towards today. Until it reaches the tip,
 * "24H" means the newest day *stored*, months in the past, and every batch moves the
 * figures. Health stays `ok` meanwhile (the service works, and the deploy script waits on
 * it), so this is reported separately: how far behind, how far along, which date the data
 * runs up to, and roughly how long is left.
 */

/** Further behind than this (~10 minutes of blocks) is catching up, not following the tip. */
export const CATCH_UP_BLOCKS = 20;

export interface CatchUp {
  /** The network's tip as last seen by ingestion, or null before the first cycle. */
  readonly tip: number | null;
  readonly behindBlocks: number | null;
  readonly catchingUp: boolean;
  /** Share of the range from the oldest stored block to the tip that is stored, 0-100. */
  readonly progress: number | null;
  /** Block time of the oldest stored block (seconds): where the sync started. */
  readonly dataFrom: number | null;
  /** Block time of the newest stored block (seconds): what "latest" figures describe. */
  readonly dataAsOf: number | null;
  /** At the current rate; null when the rate is unknown. */
  readonly etaSeconds: number | null;
}

export function catchUpState(input: {
  readonly latestHeight: number;
  readonly oldestHeight: number;
  readonly latestTime: number;
  readonly oldestTime: number;
  readonly tip: number | null | undefined;
  readonly blocksPerMinute: number | null | undefined;
}): CatchUp {
  const { latestHeight, oldestHeight, latestTime } = input;
  const tip = input.tip && input.tip > 0 ? input.tip : null;
  const dataAsOf = latestTime > 0 ? latestTime : null;
  const dataFrom = input.oldestTime > 0 ? input.oldestTime : null;

  if (tip === null) {
    return {
      tip: null,
      behindBlocks: null,
      // Nothing stored and no tip yet: the very first cycle is still running.
      catchingUp: latestHeight === 0,
      progress: latestHeight === 0 ? 0 : null,
      dataFrom,
      dataAsOf,
      etaSeconds: null
    };
  }

  const behindBlocks = Math.max(0, tip - latestHeight);
  const catchingUp = latestHeight === 0 || behindBlocks > CATCH_UP_BLOCKS;
  const span = tip - oldestHeight + 1;
  const stored = latestHeight > 0 ? latestHeight - oldestHeight + 1 : 0;
  const progress =
    span > 0 ? Math.min(100, Math.max(0, Number(((stored / span) * 100).toFixed(1)))) : null;
  const rate = input.blocksPerMinute ?? 0;

  return {
    tip,
    behindBlocks,
    catchingUp,
    progress: catchingUp ? progress : 100,
    dataFrom,
    dataAsOf,
    etaSeconds: catchingUp && rate > 0 ? Math.round((behindBlocks / rate) * 60) : null
  };
}
