/**
 * The ingestion loop.
 *
 * Fixes #5, #13, #14 and #17 together, because they are the same problem seen from
 * different angles: v1's sync ran on a two-minute timer, did at most one batch per cycle,
 * dropped any height that failed to fetch *forever*, never checked for reorgs, and never
 * ran the retention cleanup that its own database code contained.
 *
 * Structure:
 *   - one tip poll per `pollSeconds` once caught up; back-to-back cycles while behind
 *   - tip-following gets priority; backfill only runs once the tip is caught up
 *   - heights are derived in memory, then committed in one transaction per batch
 *   - a failure records the height in `missing_blocks` with backoff; a repair pass retries it
 *   - the last N block hashes are re-checked each cycle to catch a reorg
 *   - old data is pruned past the retention window
 */

import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db/database.js';
import type { LabelLookup } from '../labels.js';
import { createLimiter, HttpError, type Limiter } from '../http.js';
import type { FailoverDataSource } from './datasource/circuitbreaker.js';
import type { NormalisedBlock } from './datasource/types.js';
import { deriveBlock, type DerivedBlock } from './derive.js';
import { BlockWriter, logWarnings } from './writer.js';

/** FLUX targets a 30-second block, so a day is 2,880 blocks. */
const BLOCKS_PER_DAY = 2_880;

/**
 * Prune runs on a clock, not only on idle cycles.
 *
 * With 30-second blocks and a 30-second poll, almost every cycle has one new block. Running
 * maintenance only when a cycle found nothing new starved it: retention lagged indefinitely.
 * Gap repair needs no clock of its own; each missing height carries its own backoff.
 */
const PRUNE_INTERVAL_MS = 60 * 60_000;

/** Throughput is averaged over this window, so the rate reflects current work. */
const THROUGHPUT_WINDOW_MS = 10 * 60_000;

/**
 * How far below the reorg window to look for the fork point.
 *
 * The window shows where a fork *became visible*, not where it began. FLUX reorgs are a
 * few blocks; this bound only stops a source that disagrees with everything from walking
 * the whole database.
 */
const MAX_FORK_SEARCH = 500;

/**
 * Blocks covered by a retention window.
 *
 * Expressed as a helper because getting it wrong in either direction either deletes live
 * data or never prunes at all, and both failures are silent.
 */
export function retentionBlocks(days: number): number {
  return Math.floor(days * BLOCKS_PER_DAY);
}

/** An inclusive list of heights. An empty list when the range is inverted. */
function range(from: number, to: number): number[] {
  if (from > to) return [];

  const heights: number[] = [];
  for (let height = from; height <= to; height++) heights.push(height);

  return heights;
}

export interface SyncStats {
  readonly cycles: number;
  readonly synced: number;
  readonly failed: number;
  readonly repaired: number;
  readonly backfilled: number;
  readonly reorgedHeights: number;
  readonly prunedBlocks: number;
  readonly lastCycleMs: number;
  readonly lastCycleAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly blocksPerMinute: number;
  readonly tip: number | null;
  readonly running: boolean;
}

export interface SyncOptions {
  readonly config: Config;
  readonly db: Db;
  readonly labels: LabelLookup;
  readonly dataSource: FailoverDataSource;
  readonly log: Logger;
  /**
   * Called when a cycle shows ingestion is working: blocks were committed, or the stored
   * tip already matches the chain.
   *
   * This is how `/api/health` learns that sync works. Reading the tip alone is not enough —
   * a source can answer `getTip` while every block request fails, and a service that
   * commits nothing must go stale rather than report itself healthy.
   */
  readonly onSuccess?: (at: number) => void;
  /**
   * Used only by {@link SyncService.drain}, to wait for in-flight requests on shutdown.
   *
   * Ingestion itself is limited by the limiter the `FailoverDataSource` applies to each
   * source — see {@link SyncService.fetchAll} for why applying a second one deadlocks.
   */
  readonly limiter?: Limiter;
}

export class SyncService {
  private readonly writer: BlockWriter;
  private readonly limiter: Limiter;
  private timer: NodeJS.Timeout | undefined;
  /** The last cycle made progress and there is more to fetch: run the next one at once. */
  private behind = false;
  private inFlight: Promise<void> | undefined;
  private stopped = true;
  private lastSuccessAt: number | null = null;
  private lastPruneAt = 0;
  private counters = {
    cycles: 0,
    synced: 0,
    failed: 0,
    repaired: 0,
    backfilled: 0,
    reorgedHeights: 0,
    prunedBlocks: 0,
    lastCycleMs: 0,
    lastCycleAt: null as number | null,
    /** Committed batches: when the fetch started and how many blocks landed. */
    throughput: [] as { startedAt: number; blocks: number }[]
  };

  constructor(private readonly options: SyncOptions) {
    this.writer = new BlockWriter(options.db);
    this.limiter = options.limiter ?? createLimiter(options.config.sync.concurrency);
  }

  get stats(): SyncStats {
    const now = Date.now();
    const recent = this.counters.throughput.filter(
      (sample) => sample.startedAt >= now - THROUGHPUT_WINDOW_MS
    );
    const blocks = recent.reduce((sum, sample) => sum + sample.blocks, 0);
    // Floored at one second so a single fast batch reads as a rate, not as infinity.
    const minutes = recent.length > 0 ? Math.max((now - recent[0]!.startedAt) / 60_000, 1 / 60) : 0;

    return {
      cycles: this.counters.cycles,
      synced: this.counters.synced,
      failed: this.counters.failed,
      repaired: this.counters.repaired,
      backfilled: this.counters.backfilled,
      reorgedHeights: this.counters.reorgedHeights,
      prunedBlocks: this.counters.prunedBlocks,
      lastCycleMs: this.counters.lastCycleMs,
      lastCycleAt: this.counters.lastCycleAt,
      lastSuccessAt: this.lastSuccessAt,
      blocksPerMinute: minutes > 0 ? Number((blocks / minutes).toFixed(1)) : 0,
      tip: this.tip(),
      running: !this.stopped
    };
  }

  /** Highest stored height, or null when nothing has been synced. */
  tip(): number | null {
    const row = this.options.db
      .prepare<[], { max: number | null }>(`SELECT MAX(height) AS max FROM blocks`)
      .get();

    return row?.max ?? null;
  }

  /** Oldest stored height, or null. */
  base(): number | null {
    const row = this.options.db
      .prepare<[], { min: number | null }>(`SELECT MIN(height) AS min FROM blocks`)
      .get();

    return row?.min ?? null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;

    const intervalMs = this.options.config.sync.pollSeconds * 1000;

    /*
     * Self-scheduling rather than `setInterval`.
     *
     * A fixed interval ran one batch per poll, so however fast the source, a fresh install
     * advanced 250 blocks every 30 s: six months took ~17 hours with a node that can serve
     * them in minutes. While a cycle makes progress and more remains, the next one starts
     * immediately; the poll interval applies only once caught up, or after a failure, so a
     * struggling source still gets its breathing room.
     */
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      await this.runOnce();
      if (this.stopped) return;

      this.timer = setTimeout(() => void tick(), this.behind ? 0 : intervalMs);
      // Never hold the process open for a poll.
      this.timer.unref?.();
    };

    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    // Let an in-flight cycle finish so it does not commit half a batch behind us.
    await this.inFlight?.catch(() => {});
  }

  /**
   * Run one cycle.
   *
   * Guarded so overlapping timers cannot double-process a height: v1's scheduler logged
   * "previous sync still running, skipping" and, once a request hung, did so forever.
   */
  async runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    const run = this.cycle().finally(() => {
      this.inFlight = undefined;
    });

    this.inFlight = run;
    return run;
  }

  private async cycle(): Promise<void> {
    const startedAt = Date.now();
    const { log } = this.options;
    // Only a cycle that gets to the end with progress made sets this; anything else backs off.
    this.behind = false;

    try {
      await this.checkForReorg();

      const tip = await this.options.dataSource.withFailover((source) => source.getTip());
      const stored = this.tip();
      const { batchSize } = this.options.config.sync;

      /*
       * Tip-following, bounded by SYNC_BATCH_SIZE.
       *
       * Two constraints that are easy to get wrong separately:
       *
       *  - An empty database must not start at height 0: that is the entire chain. v1's
       *    equivalent walked backwards from the tip, so a new install could never fill the
       *    range it had skipped and never reached 100%.
       *
       *  - Each cycle must advance by at most `batchSize`. Unbounded, a fresh install fires
       *    the whole retention window at once — ~2,900 requests against a public, rate-limited
       *    API. That is how a source gets throttled into an outage, and it is exactly what
       *    SYNC_BATCH_SIZE exists to prevent.
       *
       * So the start is the retention floor when nothing is stored, and the range is always
       * capped. Each cycle continues from wherever the previous one stopped.
       */
      const floor = Math.max(1, tip - retentionBlocks(this.options.config.sync.retentionDays));
      const start = (stored ?? floor - 1) + 1;
      const end = Math.min(tip, start + batchSize - 1);

      if (stored === null) {
        this.options.log.info(
          { from: start, to: end, tip, days: this.options.config.sync.retentionDays },
          'empty database: starting from the retention floor'
        );
      }

      const heights = range(start, end);
      const result = await this.syncRange(heights, stored === null ? 'backfill' : 'forward');

      // Healthy means data is landing, or the stored tip already equals the chain's. Reading
      // the tip alone proves only that the source answers, and a tip *below* what is stored
      // also leaves nothing to fetch: that is a stuck or lagging source, not "caught up".
      if (result.synced > 0 || (heights.length === 0 && stored === tip)) {
        this.markSuccess(Date.now());
      } else if (stored !== null && tip < stored) {
        log.warn({ tip, stored }, 'source reports a tip below the stored tip; not marking healthy');
      }

      const now = Date.now();

      /*
       * Repair runs every cycle, even after a pass with failures.
       *
       * Its load is already bounded: only heights whose backoff has expired are retried, and
       * the heights that just failed were queued with a fresh backoff, so they are not among
       * them. Skipping repair whenever the forward pass failed meant a source that kept
       * failing on new tip blocks starved every older gap indefinitely.
       */
      await this.repairGaps(floor);

      /*
       * Stop here if this pass had failures.
       *
       * Backfill would add a whole batch of new requests on a source that is already
       * struggling, which is how a brief slowdown becomes a sustained outage.
       */
      if (result.failed > 0) {
        log.info({ failed: result.failed }, 'cycle had failures; deferring backfill');
        return;
      }

      // History can wait; the tip cannot. Backfill only once tip-following has caught up.
      const moreHistory = end >= tip ? await this.backfill(tip) : false;
      this.behind = (result.synced > 0 && end < tip) || moreHistory;

      if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
        this.lastPruneAt = now;
        this.prune();
      }
    } catch (error) {
      if (error instanceof HttpError) {
        log.warn(
          { status: error.status, url: error.url },
          'sync cycle could not reach a data source'
        );
      } else {
        log.error(
          { ...(error instanceof Error ? { stack: error.stack } : {}), error },
          'sync cycle failed'
        );
      }
    } finally {
      this.counters.lastCycleMs = Date.now() - startedAt;
      this.counters.lastCycleAt = Date.now();
      this.counters.cycles++;
      this.writer.setState('last_cycle_at', this.counters.lastCycleAt);
    }
  }

  /**
   * Fetch and commit a list of heights.
   *
   * Heights are fetched concurrently, bounded by the data source's limiter, then committed in one
   * transaction. A failure is recorded against its own height, never against the batch.
   */
  private async syncRange(
    heights: number[],
    phase: 'forward' | 'backfill' | 'repair'
  ): Promise<{ synced: number; failed: number }> {
    if (heights.length === 0) return { synced: 0, failed: 0 };

    const startedAt = Date.now();
    const fetched = await this.fetchAll(heights);
    const derived: DerivedBlock[] = [];
    const failures: { height: number; error: string; attempts?: number }[] = [];

    for (const height of heights) {
      const result = fetched.get(height);

      if (!result || 'error' in result) {
        failures.push({ height, error: result ? result.error : 'no response' });
        continue;
      }

      const block = deriveBlock(result.block, result.source, this.options.labels);
      logWarnings(this.options.log, block.warnings, height);

      // A transfer the source could not detail. Committing the block would mark the height
      // done with that buy or sell missing for good, so it is retried instead (#14).
      if (block.incomplete) {
        failures.push({ height, error: 'block has transfers the source could not detail' });
        continue;
      }

      derived.push(block);
    }

    let committed = 0;

    if (derived.length > 0) {
      try {
        const written = this.writer.writeBatch(derived);
        committed = derived.length;
        this.recordThroughput(committed, startedAt);
        this.options.log.info(
          {
            phase,
            blocks: written.blocks,
            deltas: written.deltas,
            flows: written.flows,
            ms: written.ms
          },
          'batch committed'
        );
      } catch (error) {
        // The write failed, so none of it landed. Record every height in the batch as
        // missing rather than losing them.
        for (const block of derived) {
          failures.push({
            height: block.height,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    this.writer.writeFailures(failures);

    // Counted per phase: "heights recovered after a failure" and "heights added to extend
    // history" are different numbers and conflating them hides whether repair works.
    if (phase === 'forward') this.counters.synced += committed;
    else if (phase === 'repair') this.counters.repaired += committed;
    else this.counters.backfilled += committed;

    this.counters.failed += failures.length;

    if (failures.length > 0) {
      this.options.log.warn(
        { phase, failed: failures.length, of: heights.length, first: failures[0]!.height },
        'heights recorded as missing and queued for retry'
      );
    }

    return { synced: committed, failed: failures.length };
  }

  /** Fetch heights concurrently, never rejecting: failures come back as values. */
  private async fetchAll(
    heights: number[]
  ): Promise<Map<number, { block: NormalisedBlock; source: string } | { error: string }>> {
    const results = new Map<
      number,
      { block: NormalisedBlock; source: string } | { error: string }
    >();

    /*
     * Concurrency is bounded by the limiter the *data source* applies, not by one applied here.
     *
     * `FailoverDataSource` already wraps every source it dispatches with the shared limiter,
     * so wrapping again here would acquire two slots for one request. A limiter holds its
     * slot while awaiting the work inside it, so `concurrency` callers would each take one
     * slot and then wait forever for a second — a self-deadlock that hangs every cycle.
     */
    const settled = await Promise.allSettled(
      heights.map((height) =>
        this.options.dataSource.withFailover(async (source) => ({
          block: await source.getBlock(height),
          source: source.id
        }))
      )
    );

    settled.forEach((outcome, index) => {
      const height = heights[index]!;

      if (outcome.status === 'fulfilled') {
        results.set(height, outcome.value);
      } else {
        results.set(height, {
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        });
      }
    });

    return results;
  }

  /**
   * Retry heights that previously failed.
   *
   * v1 dropped a failed height permanently: the next cycle started from `MAX(height) + 1`,
   * so the hole was never filled and the readme's "gap prevention" was never implemented.
   * Nothing here discards a height; it is retried with backoff until it succeeds.
   */
  private async repairGaps(floor: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Never below the retention floor: a repaired height there would be written only for
    // the next prune to delete it again.
    const pending = this.options.db
      .prepare<[number, number, number], { height: number; attempts: number }>(
        `SELECT height, attempts FROM missing_blocks
         WHERE next_retry_at <= ? AND height >= ?
         ORDER BY next_retry_at ASC
         LIMIT ?`
      )
      .all(now, floor, this.options.config.sync.batchSize);

    if (pending.length === 0) return;

    this.options.log.info({ count: pending.length }, 'retrying heights that previously failed');

    // Only the heights that actually failed. Fetching the span between two gaps would
    // re-download (and re-derive) blocks that are already stored.
    await this.syncRange(
      pending.map((row) => row.height),
      'repair'
    );
  }

  /**
   * Extend history backwards, within the retention window.
   *
   * The window is recomputed from the current tip every cycle. v1 computed `targetBlock`
   * once at startup and never moved it, so a long-running service kept trying to fetch a
   * range below its own retention floor forever.
   */
  /** @returns whether this pass stored blocks and older ones are still missing. */
  private async backfill(tip: number): Promise<boolean> {
    const { config } = this.options;

    if (config.sync.retentionDays <= 0) return false;

    const floor = Math.max(1, tip - retentionBlocks(config.sync.retentionDays));
    const base = this.base();

    if (base === null) {
      await this.syncRange(range(floor, tip), 'backfill');
      return false;
    }

    if (base <= floor) return false;

    const end = Math.max(floor, base - config.sync.batchSize);
    const result = await this.syncRange(range(end, base - 1), 'backfill');
    return result.synced > 0 && result.failed === 0 && end > floor;
  }

  /**
   * Compare the last N stored hashes with the chain and roll back on a mismatch.
   *
   * v1 stored hashes but never checked them, so a reorg silently left stale blocks and
   * everything derived from them permanently in the database (#13).
   */
  private async checkForReorg(): Promise<void> {
    const depth = this.options.config.sync.reorgCheckDepth;
    if (depth === 0) return;

    const tip = this.tip();
    if (tip === null || tip < depth) return;

    const from = tip - depth + 1;
    const stored = this.options.db
      .prepare<[number, number], { height: number; hash: string }>(
        `SELECT height, hash FROM blocks WHERE height BETWEEN ? AND ? ORDER BY height`
      )
      .all(from, tip);

    if (stored.length === 0) return;

    let mismatch: number | null = null;

    for (const row of stored) {
      const live = await this.liveHash(row.height);

      if (live === null) continue; // Cannot verify; do not roll back on a fetch failure.
      if (live !== row.hash) {
        if (!(await this.confirmHash(row.height, live))) continue;
        mismatch = row.height;
        break;
      }
    }

    if (mismatch === null) return;

    // The bottom of the window already differs, so the fork may be deeper than the window.
    // Rolling back only the window would leave the stale blocks below it stored for good.
    if (mismatch === stored[0]!.height) mismatch = await this.findForkPoint(mismatch);

    this.options.log.error(
      { from: mismatch, tip },
      'reorg detected, rolling back and re-syncing from the fork point'
    );

    this.writer.rollbackFrom(mismatch);
    this.counters.reorgedHeights += tip - mismatch + 1;
  }

  /**
   * Walk down from a mismatching height to the first height the chain agrees with.
   *
   * Stops, keeping the deepest confirmed mismatch, when a height cannot be verified or
   * nothing is stored below: rolling back further on a guess would destroy good data.
   */
  private async findForkPoint(from: number): Promise<number> {
    let fork = from;
    const lowest = Math.max(1, from - MAX_FORK_SEARCH);

    for (let height = from - 1; height >= lowest; height--) {
      const stored = this.options.db
        .prepare<[number], { hash: string }>(`SELECT hash FROM blocks WHERE height = ?`)
        .get(height);
      if (!stored) break;

      const live = await this.liveHash(height);
      if (live === null || live === stored.hash) break;
      if (!(await this.confirmHash(height, live))) break;

      fork = height;
    }

    return fork;
  }

  /**
   * Re-read a hash that disagrees with the stored one, before acting on it.
   *
   * A rollback deletes stored history, so it must never rest on a single remote answer: one
   * glitching or dishonest source (a node in a pool, a cache serving a stale view) would
   * otherwise be able to wipe blocks. The second read goes through failover again, so with a
   * pool it can come from a different node. Anything other than the same answer twice is
   * treated as unverified, which keeps the stored data.
   */
  private async confirmHash(height: number, first: string): Promise<boolean> {
    const second = await this.liveHash(height);

    if (second === first) return true;

    this.options.log.warn(
      { height, first, second },
      'hash mismatch was not confirmed by a second read; keeping stored block'
    );
    return false;
  }

  /**
   * The chain's hash at a height, or null when it cannot be read.
   *
   * Uses the source's cheap hash lookup when it has one; otherwise a full block download,
   * which costs a rate-limited source far more for the same answer.
   */
  private liveHash(height: number): Promise<string | null> {
    return this.options.dataSource
      .withFailover((source) =>
        source.getBlockHash
          ? source.getBlockHash(height)
          : source.getBlock(height).then((block) => block.hash)
      )
      .catch(() => null);
  }

  /** Prune on demand, e.g. from `POST /api/admin/retention`. */
  pruneNow(): void {
    this.prune();
  }

  /** Prune raw data past the retention window (#17). */
  private prune(): void {
    const tip = this.tip();
    if (tip === null) return;

    const floor = Math.max(1, tip - retentionBlocks(this.options.config.sync.retentionDays));

    const base = this.base();
    if (base === null || base >= floor) return;

    const result = this.writer.pruneBefore(floor);
    this.counters.prunedBlocks += result.blocks;

    this.options.log.info({ floor, ...result }, 'pruned data past the retention window');
  }

  private recordThroughput(blocks: number, startedAt: number): void {
    const elapsedMinutes = Math.max((Date.now() - startedAt) / 60_000, 1 / 60);
    const samples = this.counters.throughput;

    samples.push({ startedAt, blocks });
    while (samples.length > 0 && samples[0]!.startedAt < Date.now() - THROUGHPUT_WINDOW_MS) {
      samples.shift();
    }

    this.options.log.debug(
      { blocks, blocksPerMinute: Number((blocks / elapsedMinutes).toFixed(1)) },
      'throughput'
    );
  }

  /** Record that ingestion is working, for the staleness check behind `/api/health`. */
  markSuccess(at: number): void {
    this.lastSuccessAt = at;
    this.options.onSuccess?.(at);
  }

  /** Wait for an in-flight cycle. Used on shutdown. */
  async drain(): Promise<void> {
    await this.inFlight?.catch(() => {});
    await this.limiter.drain();
  }
}
