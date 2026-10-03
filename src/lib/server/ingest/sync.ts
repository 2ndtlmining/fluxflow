/**
 * The ingestion loop.
 *
 * Fixes #5, #13, #14 and #17 together, because they are the same problem seen from
 * different angles: v1's sync ran on a two-minute timer, did at most one batch per cycle,
 * dropped any height that failed to fetch *forever*, never checked for reorgs, and never
 * ran the retention cleanup that its own database code contained.
 *
 * Structure:
 *   - one tip poll per `pollSeconds`
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
   * Called after a cycle confirms the data sources are reachable.
   *
   * This is how `/api/health` learns that sync is working. Without it the health check keeps
   * reporting `degraded: no successful sync yet` for the life of the process, however many
   * blocks land — a container that is ingesting perfectly looks permanently unhealthy, and an
   * orchestrator will restart it.
   */
  readonly onSuccess?: (at: number) => void;
  /**
   * Used only by {@link SyncService.drain}, to wait for in-flight requests on shutdown.
   *
   * Ingestion work itself is limited by the limiter the `FailoverDataSource` applies to each
   * source — see {@link SyncService.fetchAll} for why applying a second one deadlocks.
   */
  readonly limiter?: Limiter;
}

export class SyncService {
  private readonly writer: BlockWriter;
  private readonly limiter: Limiter;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = true;
  private lastSuccessAt: number | null = null;
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
    recentBlocks: [] as number[]
  };

  constructor(private readonly options: SyncOptions) {
    this.writer = new BlockWriter(options.db);
    this.limiter = options.limiter ?? createLimiter(options.config.sync.concurrency);
  }

  get stats(): SyncStats {
    const recent = this.counters.recentBlocks;
    const span = recent.length > 1 ? (recent[recent.length - 1]! - recent[0]!) / 60_000 : 0;

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
      blocksPerMinute: span > 0 ? Number((recent.length / span).toFixed(1)) : 0,
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
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);

    // Never hold the process open for a poll.
    this.timer.unref?.();

    void this.runOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.timer) {
      clearInterval(this.timer);
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

    try {
      await this.checkForReorg();

      const tip = await this.options.dataSource.withFailover((source) => source.getTip());
      this.markSuccess(Date.now());
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

      const result = await this.syncRange(
        range(start, end),
        stored === null ? 'backfill' : 'forward'
      );

      if (result.synced > 0) {
        this.recordThroughput(result.synced, startedAt);
        // Anything else can wait until the tip is current.
        return;
      }

      /*
       * Stop here if this pass had failures.
       *
       * The failed heights are already queued in `missing_blocks` with a backoff. Running
       * repair and backfill in the same cycle would re-fetch them immediately — tripling
       * the load on a source that is already struggling, which is how a brief slowdown
       * becomes a sustained outage.
       */
      if (result.failed > 0) {
        log.info(
          { failed: result.failed },
          'cycle had failures; deferring repair and backfill to a later cycle'
        );
        return;
      }

      await this.repairGaps();
      await this.backfill();

      if (this.counters.cycles % 12 === 0) this.prune();
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
   * Heights are fetched concurrently through the shared limiter, then committed in one
   * transaction. A failure is recorded against its own height, never against the batch.
   */
  private async syncRange(
    heights: number[],
    phase: 'forward' | 'backfill' | 'repair'
  ): Promise<{ synced: number; failed: number }> {
    if (heights.length === 0) return { synced: 0, failed: 0 };

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
      derived.push(block);
    }

    if (derived.length > 0) {
      try {
        const written = this.writer.writeBatch(derived);
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
    if (phase === 'forward') this.counters.synced += derived.length;
    else if (phase === 'repair') this.counters.repaired += derived.length;
    else this.counters.backfilled += derived.length;

    this.counters.failed += failures.length;

    if (failures.length > 0) {
      this.options.log.warn(
        { phase, failed: failures.length, of: heights.length, first: failures[0]!.height },
        'heights recorded as missing and queued for retry'
      );
    }

    return { synced: derived.length, failed: failures.length };
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
     * so wrapping again here would acquire two slots for one request. Since a limiter holds
     * its slot while awaiting the work inside it, `concurrency` callers would each take one
     * slot and then block forever waiting for a second — a self-deadlock that stalls every
     * sync cycle while the service reports itself perfectly healthy.
     *
     * Found by running the image: the pool was probed, 10 nodes were serving, and no block
     * was ever committed. No unit test caught it because the tests build the failover source
     * without a limiter, so only one level of wrapping was ever in play.
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
  private async repairGaps(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    const pending = this.options.db
      .prepare<[number, number], { height: number; attempts: number }>(
        `SELECT height, attempts FROM missing_blocks
         WHERE next_retry_at <= ?
         ORDER BY next_retry_at ASC
         LIMIT ?`
      )
      .all(now, this.options.config.sync.batchSize);

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
  private async backfill(): Promise<void> {
    const { config } = this.options;

    if (config.sync.retentionDays <= 0) return;

    const tip = await this.options.dataSource.withFailover((source) => source.getTip());
    const floor = Math.max(1, tip - retentionBlocks(config.sync.retentionDays));
    const base = this.base();

    if (base === null) {
      await this.syncRange(range(floor, tip), 'backfill');
      return;
    }

    if (base <= floor) return;

    const end = Math.max(floor, base - config.sync.batchSize);
    await this.syncRange(range(end, base - 1), 'backfill');
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
      const live = await this.options.dataSource
        .withFailover((source) => source.getBlock(row.height))
        .catch(() => null);

      if (!live) continue; // Cannot verify; do not roll back on a fetch failure.
      if (live.hash !== row.hash) {
        mismatch = row.height;
        break;
      }
    }

    if (mismatch === null) return;

    this.options.log.error(
      { from: mismatch, tip },
      'reorg detected, rolling back and re-syncing from the fork point'
    );

    this.writer.rollbackFrom(mismatch);
    this.counters.reorgedHeights += tip - mismatch + 1;
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
    const recent = this.counters.recentBlocks;

    recent.push(blocks);
    // Keep two hours of samples so the rate stays meaningful after an idle period.
    while (recent.length > 240) recent.shift();

    this.options.log.debug(
      { blocks, blocksPerMinute: Number((blocks / elapsedMinutes).toFixed(1)) },
      'throughput'
    );
  }

  /**
   * Record that the chain was successfully read, for the staleness check.
   *
   * Called once the tip has been read, which is the point at which we know the data sources
   * are reachable. A cycle that later commits nothing is still a *successful* cycle — there
   * is simply nothing new to fetch — so this must not wait for a commit, or a fully caught-up
   * service reports itself unhealthy forever.
   */
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
