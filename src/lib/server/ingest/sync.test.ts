import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createTestConfig, createTestDb, silentLogger, type Db } from '../testkit.js';
import { FailoverDataSource } from './datasource/circuitbreaker.js';
import type { DataSource, NormalisedBlock } from './datasource/types.js';
import { SyncService, retentionBlocks } from './sync.js';
import type { LabelLookup } from '../labels.js';
import { createLimiter, type Limiter } from '../http.js';

const SATS = 100_000_000;
const NOW = 1_756_000_000;
const EXCHANGE = 't1coinex1';

const LABELS: LabelLookup = {
  kindOf: (address) => (address === EXCHANGE ? 'exchange' : 'unknown'),
  nameOf: (address) => (address === EXCHANGE ? 'Coinex' : null),
  reload: () => ({ exchanges: 1, foundation: 0, total: 1, source: 'test', loadedAt: 0 }),
  stats: () => ({ exchanges: 1, foundation: 0, total: 1, source: 'test', loadedAt: 0 }),
  entries: () => new Map()
};

function transferBlock(height: number): NormalisedBlock {
  return {
    height,
    hash: `hash-${height}`,
    prevHash: `hash-${height - 1}`,
    time: NOW,
    txCount: 1,
    transactions: [
      {
        txid: `tx-${height}`,
        kind: 'transfer',
        inputs: [{ address: EXCHANGE, sat: SATS, vout: 0 }],
        outputs: [{ n: 0, address: 't1whale', sat: SATS - 1_000, nulldata: false }],
        complete: true
      }
    ]
  };
}

interface FakeChain {
  tip: number;
  /** Heights whose first fetch should throw. */
  failingOnce?: Set<number>;
  /** Every height fetched, in order, so tests can assert what was and was not re-fetched. */
  fetched: number[];
  /** Simulate a fork: the chain's hash at a height, when it differs from `hash-<height>`. */
  forkedHash?: (height: number) => string | null;
}

/** The chain's block at a height, honouring a simulated fork. */
function chainBlock(chain: FakeChain, height: number): NormalisedBlock {
  const block = transferBlock(height);
  const hash = chain.forkedHash?.(height) ?? block.hash;
  const prevHash = chain.forkedHash?.(height - 1) ?? block.prevHash;

  return { ...block, hash, prevHash };
}

/**
 * A data source backed by an in-memory chain, so the sync loop can be driven deterministically
 * with no network and no sleeping.
 */
function chainSource(chain: FakeChain): DataSource & { chain: FakeChain } {
  const calls = new Map<number, number>();

  return {
    id: 'chain',
    description: 'in-memory chain',
    chain,

    async getTip() {
      return chain.tip;
    },

    async getBlock(height: number) {
      chain.fetched.push(height);
      const seen = (calls.get(height) ?? 0) + 1;
      calls.set(height, seen);

      // #13's acceptance criterion: three random heights fail on the first attempt, and
      // after two cycles there are no gaps.
      if (chain.failingOnce?.has(height) && seen === 1) {
        throw new Error(`transient failure for ${height}`);
      }

      return chainBlock(chain, height);
    },

    async isHealthy() {
      return true;
    }
  };
}

function buildSync(
  db: Db,
  source: DataSource,
  env: Record<string, string> = {},
  log: Logger = silentLogger(),
  extra: { limiter?: Limiter; onSuccess?: (at: number) => void } = {}
): SyncService {
  const config = createTestConfig(env);
  const dataSource = new FailoverDataSource({
    sources: [source],
    config,
    log: silentLogger(),
    ...(extra.limiter ? { limiter: extra.limiter } : {})
  });

  return new SyncService({ config, db, labels: LABELS, dataSource, log, ...extra });
}

/** Reject if `promise` has not settled within `ms`: how a deadlock shows up in a test. */
function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)
    )
  ]);
}

/** A chain that also answers the cheap hash lookup, counting how often each is used. */
function hashingSource(chain: FakeChain): DataSource & { chain: FakeChain; hashCalls: number[] } {
  const base = chainSource(chain);
  const hashCalls: number[] = [];

  return Object.assign(base, {
    hashCalls,
    async getBlockHash(height: number) {
      hashCalls.push(height);
      return chainBlock(chain, height).hash;
    }
  });
}

/**
 * The wiring `createService` actually builds: one shared limiter, passed to both the
 * failover source and the sync service.
 *
 * Every other test omits the limiter from the failover source, which hides double-wrapping
 * bugs. This is the shape that ships.
 */
function buildSyncWithSharedLimiter(
  db: Db,
  source: DataSource,
  env: Record<string, string> = {}
): SyncService {
  const config = createTestConfig(env);
  const limiter = createLimiter(config.sync.concurrency);

  const dataSource = new FailoverDataSource({
    sources: [source],
    config,
    log: silentLogger(),
    limiter
  });

  return new SyncService({ config, db, labels: LABELS, dataSource, log: silentLogger(), limiter });
}

describe('retentionBlocks', () => {
  it('converts days to blocks at a 30-second block time', () => {
    expect(retentionBlocks(1)).toBe(2_880);
    expect(retentionBlocks(180)).toBe(518_400);
    expect(retentionBlocks(0)).toBe(0);
  });
});

describe('SyncService', () => {
  let db: Db;
  let sync: SyncService | null = null;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(async () => {
    await sync?.stop();
    sync = null;
    db.close();
  });

  function count(table: string): number {
    return db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
  }

  function storedHeights(): number[] {
    return db
      .prepare<[], { height: number }>(`SELECT height FROM blocks ORDER BY height`)
      .all()
      .map((row) => row.height);
  }

  describe('tip following', () => {
    it('fetches only new blocks on a later cycle', async () => {
      const source = chainSource({ tip: 100, fetched: [] });
      sync = buildSync(db, source, {
        SYNC_BATCH_SIZE: '1000',
        RETENTION_DAYS: '180',
        // Reorg checking costs REORG_CHECK_DEPTH extra fetches per cycle; disabled here so
        // this test measures tip-following alone.
        REORG_CHECK_DEPTH: '0'
      });

      await sync.runOnce();
      expect(sync.tip()).toBe(100);
      const fetchedAfterFirst = source.chain.fetched.length;

      source.chain.tip = 103;
      await sync.runOnce();

      // Only the three new heights on the second pass, not another sweep of the range.
      expect(source.chain.fetched.length - fetchedAfterFirst).toBe(3);
      expect(count('blocks')).toBe(103);
    });

    it('spends REORG_CHECK_DEPTH fetches verifying hashes each cycle', async () => {
      const source = chainSource({ tip: 100, fetched: [] });
      sync = buildSync(db, source, {
        SYNC_BATCH_SIZE: '1000',
        REORG_CHECK_DEPTH: '5'
      });

      await sync.runOnce();
      const fetchedAfterFirst = source.chain.fetched.length;

      await sync.runOnce();

      // Nothing is stored on the first cycle, so there is nothing to verify yet; the second
      // cycle spends REORG_CHECK_DEPTH fetches re-reading the last 5 hashes. Without that
      // check a fork leaves stale blocks in the database permanently (#13).
      expect(fetchedAfterFirst).toBe(100);
      expect(source.chain.fetched.length - fetchedAfterFirst).toBe(5);
    });

    it('starts from the retention floor on an empty database, not height 0', async () => {
      const source = chainSource({ tip: 1_000_000, fetched: [] });
      // One day of retention keeps 2,880 blocks.
      sync = buildSync(db, source, { RETENTION_DAYS: '1', SYNC_BATCH_SIZE: '5000' });

      await sync.runOnce();

      // Fetching from height 0 would be the entire chain. v1's equivalent started at the
      // tip and walked backwards, which could never fill the gap it left.
      const lowest = Math.min(...source.chain.fetched);
      expect(lowest).toBeGreaterThanOrEqual(1_000_000 - 2_880);
      expect(source.chain.fetched).not.toContain(0);
    });

    it('reports throughput and cycle counts', async () => {
      const source = chainSource({ tip: 50, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();
      const stats = sync.stats;

      expect(stats.cycles).toBe(1);
      // An empty database's first pass is history, so it counts as backfill rather than
      // tip-following.
      expect(stats.backfilled).toBeGreaterThan(0);
      expect(stats.lastCycleAt).toBeGreaterThan(0);
      expect(stats.running).toBe(false);
    });

    it('counts new blocks as tip-following', async () => {
      const source = chainSource({ tip: 100, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();
      expect(sync.stats.synced).toBe(0);
      expect(sync.stats.backfilled).toBe(100);

      // Only heights that appear after the first pass are tip-following.
      source.chain.tip = 105;
      await sync.runOnce();

      expect(sync.stats.synced).toBe(5);
    });

    it('advances at most SYNC_BATCH_SIZE heights per cycle', async () => {
      const source = chainSource({ tip: 10_000, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '250' });

      await sync.runOnce();

      // The 180-day window covers all 10,000 heights, so the start is 1. Unbounded, this
      // single cycle would fire all 10,000 requests at once against a public, rate-limited
      // API - which is what SYNC_BATCH_SIZE exists to prevent.
      expect(source.chain.fetched.length).toBe(250);
      expect(sync.tip()).toBe(250);
    });

    it('does not run two cycles concurrently', async () => {
      const source = chainSource({ tip: 100, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await Promise.all([sync.runOnce(), sync.runOnce(), sync.runOnce()]);

      // v1's scheduler logged "previous sync still running, skipping" and, once a request
      // hung, did so forever.
      expect(sync.stats.cycles).toBe(1);
      expect(storedHeights().filter((height) => height === 100)).toHaveLength(1);
    });

    it('completes a cycle when the data source applies the shared limiter', async () => {
      /*
       * Regression: the limiter used to be applied twice, once by `FailoverDataSource` and
       * once again around each fetch. A limiter holds its slot while awaiting the work
       * inside it, so with `concurrency` callers every one of them took a slot and then
       * blocked forever waiting for a second. Nothing was written, nothing was logged as
       * failed, and the service reported itself healthy — the pool was probed and serving,
       * and not one block was ever committed.
       *
       * No earlier test caught this because the tests build the failover source without a
       * limiter, so only one level of wrapping was ever exercised. This one uses the real
       * wiring, and has a timeout so a deadlock fails as a failure rather than a hang.
       */
      const source = chainSource({ tip: 40, fetched: [] });
      sync = buildSyncWithSharedLimiter(db, source, { SYNC_BATCH_SIZE: '1000' });

      await Promise.race([
        sync.runOnce(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('sync cycle deadlocked')), 5_000)
        )
      ]);

      expect(count('blocks')).toBe(40);
      expect(sync.stats.cycles).toBe(1);
    });
  });

  describe('gap repair (#13)', () => {
    it('never discards a height that failed to fetch', async () => {
      const chain = { tip: 20, fetched: [] as number[], failingOnce: new Set([5, 11, 17]) };
      const source = chainSource(chain);
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();

      // The gap must be visible, not papered over.
      const missing = db
        .prepare<[], { height: number }>(`SELECT height FROM missing_blocks ORDER BY height`)
        .all()
        .map((row) => row.height);

      expect(missing).toEqual([5, 11, 17]);
      expect(storedHeights()).not.toContain(5);
      // And progress must be reported as incomplete while a gap exists.
      expect(count('missing_blocks')).toBe(3);
    });

    it('fills every gap after two cycles', async () => {
      const chain = { tip: 20, fetched: [] as number[], failingOnce: new Set([5, 11, 17]) };
      const source = chainSource(chain);
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();
      expect(count('missing_blocks')).toBe(3);

      // Make the backoff due immediately rather than waiting a minute.
      db.exec(`UPDATE missing_blocks SET next_retry_at = 0`);
      await sync.runOnce();

      expect(count('missing_blocks')).toBe(0);
      expect(count('blocks')).toBe(20);
      expect(sync.stats.repaired).toBe(3);
    });
    it('leaves no hole in the stored range', async () => {
      const chain = { tip: 30, fetched: [] as number[], failingOnce: new Set([4, 5, 29]) };
      const source = chainSource(chain);
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();
      db.exec(`UPDATE missing_blocks SET next_retry_at = 0`);
      await sync.runOnce();

      const heights = storedHeights();
      for (let height = heights[0]! + 1; height < heights[heights.length - 1]!; height++) {
        expect(heights).toContain(height);
      }
    });

    it('backs off a repeatedly failing height instead of hammering it', async () => {
      const source = chainSource({ tip: 10, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      // Always fails.
      (source as unknown as { getBlock: () => Promise<never> }).getBlock = async () => {
        throw new Error('down');
      };

      await sync.runOnce();
      const first = db
        .prepare<[], { attempts: number }>(`SELECT attempts FROM missing_blocks`)
        .get()!.attempts;

      db.exec(`UPDATE missing_blocks SET next_retry_at = 0`);
      await sync.runOnce();

      expect(
        db.prepare<[], { attempts: number }>(`SELECT attempts FROM missing_blocks`).get()!.attempts
      ).toBe(first + 1);
    });

    it('keeps the failed height out of the blocks table', async () => {
      const source = chainSource({ tip: 10, fetched: [], failingOnce: new Set([3]) });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();

      // A block row is what marks a height done. It must not exist without its flows.
      expect(storedHeights()).not.toContain(3);
    });
  });

  describe('atomicity (#14)', () => {
    it('never writes a block row without its flow events', async () => {
      const source = chainSource({ tip: 12, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();

      // Every stored block that has a transfer must have the matching flow and deltas.
      const orphaned = db
        .prepare<[], { n: number }>(
          `SELECT COUNT(*) AS n FROM blocks b
           WHERE EXISTS (SELECT 1 FROM tx_deltas d WHERE d.height = b.height)
             AND NOT EXISTS (SELECT 1 FROM flows f WHERE f.height = b.height)`
        )
        .get()!.n;

      expect(orphaned).toBe(0);
      expect(count('blocks')).toBe(count('flows'));
    });

    it('commits the whole batch or none of it', async () => {
      const source = chainSource({ tip: 10, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      // Force a mid-batch failure.
      db.exec(`CREATE TRIGGER boom BEFORE INSERT ON flows
               WHEN NEW.height = 7 BEGIN SELECT RAISE(ABORT, 'boom'); END`);

      await sync.runOnce();

      expect(count('blocks')).toBe(0);
      expect(count('flows')).toBe(0);
      // Every height is queued for retry rather than silently lost.
      expect(count('missing_blocks')).toBe(10);
    });
  });

  describe('reorgs (#13)', () => {
    it('rolls back and re-syncs when a stored hash no longer matches', async () => {
      const source = chainSource({ tip: 30, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000', REORG_CHECK_DEPTH: '5' });

      await sync.runOnce();
      expect(count('blocks')).toBe(30);

      // The chain now reports a different hash at height 28.
      const original = source.getBlock;
      source.getBlock = async (height: number) => {
        const block = await original(height);
        return height === 28 ? { ...block, hash: 'reorged' } : block;
      };

      await sync.runOnce();

      expect(sync.stats.reorgedHeights).toBeGreaterThan(0);
      // The fork point is rolled back and re-synced, so it matches the chain again.
      expect(
        db.prepare<[number], { hash: string }>(`SELECT hash FROM blocks WHERE height = ?`).get(28)!
          .hash
      ).toBe('reorged');
      expect(count('blocks')).toBe(30);
    });

    it('does not roll back when a hash cannot be verified', async () => {
      const source = chainSource({ tip: 20, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000', REORG_CHECK_DEPTH: '5' });

      await sync.runOnce();

      // Verification fails: roll back then and a transient outage would destroy good data.
      source.getBlock = async () => {
        throw new Error('cannot verify');
      };

      await sync.runOnce();

      expect(sync.stats.reorgedHeights).toBe(0);
      expect(count('blocks')).toBe(20);
    });

    it('can be disabled', async () => {
      const source = chainSource({ tip: 20, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000', REORG_CHECK_DEPTH: '0' });

      await sync.runOnce();
      source.getBlock = async (height: number) => ({
        ...transferBlock(height),
        hash: 'reorged'
      });
      await sync.runOnce();

      expect(sync.stats.reorgedHeights).toBe(0);
    });
  });

  describe('retention (#17)', () => {
    it('prunes data below the retention floor', async () => {
      const source = chainSource({ tip: 10_000, fetched: [] });
      sync = buildSync(db, source, { RETENTION_DAYS: '1', SYNC_BATCH_SIZE: '5000' });

      // A fresh sync starts AT the floor, so seed older blocks to give retention something
      // to reclaim - which is exactly the situation on a service that has been running long
      // enough for the chain to move past its own window.
      const seed = db.transaction(() => {
        const insert = db.prepare(
          `INSERT OR REPLACE INTO blocks (height, hash, time, tx_count, source) VALUES (?, ?, 0, 0, 'test')`
        );
        for (let height = 100; height < 7_120; height++) insert.run(height, `h${height}`);
        // The tip, so the floor is measured from 10,000 rather than from 7,119.
        insert.run(10_000, 'h10000');
      });
      seed();

      sync.pruneNow();

      const lowest = Math.min(...storedHeights());

      // One day = 2,880 blocks, so the floor is 10,000 - 2,880 = 7,120. Nothing below it
      // survives, and the seeded gap between 7,120 and 10,000 means the tip is the minimum.
      expect(lowest).toBeGreaterThanOrEqual(7_120);
      expect(sync.stats.prunedBlocks).toBe(7_020);
    });

    it('keeps everything when the window covers the whole range', async () => {
      const source = chainSource({ tip: 100, fetched: [] });
      sync = buildSync(db, source, { RETENTION_DAYS: '180', SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();
      sync.pruneNow();

      expect(count('blocks')).toBe(100);
      expect(sync.stats.prunedBlocks).toBe(0);
    });

    it('never deletes the live tip', async () => {
      const source = chainSource({ tip: 5_000, fetched: [] });
      sync = buildSync(db, source, { RETENTION_DAYS: '1', SYNC_BATCH_SIZE: '5000' });

      await sync.runOnce();
      sync.pruneNow();

      expect(sync.tip()).toBe(5_000);
    });
  });

  describe('backfill', () => {
    it('extends history backwards within the retention window', async () => {
      const source = chainSource({ tip: 5_000, fetched: [] });
      sync = buildSync(db, source, { RETENTION_DAYS: '180', SYNC_BATCH_SIZE: '200' });

      // Only the tip area lands on the first cycle...
      db.exec(
        `INSERT INTO blocks (height, hash, time, tx_count, source) VALUES (4900, 'h', ${NOW}, 1, 'test')`
      );

      await sync.runOnce();

      // ...then the backfill walks down from there.
      expect(Math.min(...storedHeights())).toBeLessThan(4_900);
    });

    it('stops at the retention floor rather than fetching all history', async () => {
      const source = chainSource({ tip: 100_000, fetched: [] });
      sync = buildSync(db, source, { RETENTION_DAYS: '2', SYNC_BATCH_SIZE: '500' });

      db.exec(
        `INSERT INTO blocks (height, hash, time, tx_count, source) VALUES (99_000, 'h', ${NOW}, 1, 'test')`
      );

      await sync.runOnce();
      await sync.runOnce();
      await sync.runOnce();

      const lowest = Math.min(...storedHeights());

      // Two days = 5,760 blocks before the tip. v1 computed this floor once at startup and
      // never moved it, so it looped forever trying to fetch a range below its own limit.
      expect(lowest).toBeGreaterThanOrEqual(100_000 - 5_760);
    });
  });

  describe('lifecycle', () => {
    it('starts and stops cleanly', async () => {
      const source = chainSource({ tip: 10, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000', SYNC_POLL_SECONDS: '5' });

      sync.start();
      expect(sync.stats.running).toBe(true);

      await sync.stop();
      expect(sync.stats.running).toBe(false);
    });

    it('records the last successful cycle for the staleness check', async () => {
      const source = chainSource({ tip: 10, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      expect(sync.stats.lastSuccessAt).toBeNull();
      await sync.runOnce();
      expect(sync.stats.lastSuccessAt).toBeGreaterThan(0);
    });

    it('reports success when there is simply nothing new to fetch', async () => {
      /*
       * A caught-up service commits no blocks, which is not a failure. Recording success
       * only on a commit would leave a fully-synced service reporting itself stale, and an
       * orchestrator would eventually restart it for doing its job correctly.
       */
      const source = chainSource({ tip: 10, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();
      const first = sync.stats.lastSuccessAt;

      await sync.runOnce();
      await sync.runOnce();

      // The tip has not moved, so nothing was committed — and the service is still healthy.
      expect(sync.stats.lastSuccessAt).toBeGreaterThanOrEqual(first!);
    });

    it('reports success when a pass had some failures but other blocks landed', async () => {
      const chain = { tip: 10, fetched: [] as number[], failingOnce: new Set([3, 7]) };
      const source = chainSource(chain);
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();

      // Data is landing. Individual heights failing is a different thing, and is already
      // visible as `missing_blocks` and the `failed` counter.
      expect(sync.stats.lastSuccessAt).toBeGreaterThan(0);
      expect(count('missing_blocks')).toBe(2);
    });

    it('notifies its listener on success, which is how /api/health learns sync is working', async () => {
      const seen: number[] = [];
      const source = chainSource({ tip: 10, fetched: [] });

      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' }, silentLogger(), {
        onSuccess: (at) => seen.push(at)
      });

      await sync.runOnce();

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeGreaterThan(0);
    });

    it('does not notify its listener when no data source could be reached', async () => {
      const seen: number[] = [];
      const source = chainSource({ tip: 10, fetched: [] });
      source.getTip = async () => {
        throw new Error('network down');
      };

      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' }, silentLogger(), {
        onSuccess: (at) => seen.push(at)
      });

      await sync.runOnce();

      expect(seen).toEqual([]);
    });

    it('survives a total data-source outage without throwing', async () => {
      const warn = vi.fn();
      const source = chainSource({ tip: 10, fetched: [] });
      source.getTip = async () => {
        throw new Error('network down');
      };

      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' }, silentLogger());

      await expect(sync.runOnce()).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('persists the last cycle time so a restart can see it', async () => {
      const source = chainSource({ tip: 10, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();

      expect(
        db
          .prepare<[], { key: string }>(`SELECT key FROM sync_state WHERE key = 'last_cycle_at'`)
          .get()!.key
      ).toBe('last_cycle_at');
    });
  });

  describe('review fixes (#42)', () => {
    it('does not deadlock when the data source shares the sync limiter', async () => {
      // index.ts hands the same limiter to FailoverDataSource and SyncService. Acquiring it
      // twice per request deadlocks once every slot is held by an outer acquisition.
      const limiter = createLimiter(2);
      const source = chainSource({ tip: 10, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' }, silentLogger(), { limiter });

      await within(sync.runOnce());

      expect(count('blocks')).toBe(10);
    });

    it('reports success to onSuccess once blocks are committed', async () => {
      const onSuccess = vi.fn();
      const source = chainSource({ tip: 10, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' }, silentLogger(), { onSuccess });

      await sync.runOnce();

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(sync.stats.lastSuccessAt).toBeGreaterThan(0);
    });

    it('reports success when caught up, with nothing new to fetch', async () => {
      const onSuccess = vi.fn();
      const source = chainSource({ tip: 10, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' }, silentLogger(), { onSuccess });

      await sync.runOnce();
      await sync.runOnce();

      expect(onSuccess).toHaveBeenCalledTimes(2);
    });

    it('does not report success when the tip is readable but no block can be fetched', async () => {
      const onSuccess = vi.fn();
      const source = chainSource({ tip: 10, fetched: [] });
      source.getBlock = async () => {
        throw new Error('no block for you');
      };
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' }, silentLogger(), { onSuccess });

      await sync.runOnce();

      // Reading the tip proves the source answers, not that sync works. A service that
      // commits nothing must go stale and fail its healthcheck.
      expect(onSuccess).not.toHaveBeenCalled();
      expect(sync.stats.lastSuccessAt).toBeNull();
    });

    it('does not count a cycle that threw as a success', async () => {
      const source = chainSource({ tip: 10, fetched: [] });
      source.getTip = async () => {
        throw new Error('HTTP 429');
      };
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();

      expect(sync.stats.lastSuccessAt).toBeNull();
    });

    it('reports a positive block rate across cycles of different sizes', async () => {
      const source = chainSource({ tip: 100, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000', REORG_CHECK_DEPTH: '0' });

      await sync.runOnce();
      source.chain.tip = 105;
      await sync.runOnce();

      // Samples were block counts treated as timestamps, so [100, 5] gave a negative span
      // and a rate of 0 while the service was syncing.
      expect(sync.stats.blocksPerMinute).toBeGreaterThan(0);
      expect(Number.isFinite(sync.stats.blocksPerMinute)).toBe(true);
    });

    it('repairs due gaps on a cycle that also follows the tip', async () => {
      const chain = { tip: 20, fetched: [] as number[], failingOnce: new Set([5]) };
      const source = chainSource(chain);
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000', REORG_CHECK_DEPTH: '0' });

      await sync.runOnce();
      expect(count('missing_blocks')).toBe(1);

      // With 30-second blocks, almost every cycle has one new block. Returning early on
      // those starved repair forever.
      db.exec(`UPDATE missing_blocks SET next_retry_at = 0`);
      chain.tip = 21;
      await sync.runOnce();

      expect(sync.tip()).toBe(21);
      expect(count('missing_blocks')).toBe(0);
    });

    it('prunes on a cycle that also follows the tip', async () => {
      const source = chainSource({ tip: 10_000, fetched: [] });
      sync = buildSync(db, source, {
        RETENTION_DAYS: '1',
        SYNC_BATCH_SIZE: '5000',
        REORG_CHECK_DEPTH: '0'
      });

      const seed = db.transaction(() => {
        const insert = db.prepare(
          `INSERT OR REPLACE INTO blocks (height, hash, time, tx_count, source) VALUES (?, ?, 0, 0, 'test')`
        );
        for (let height = 100; height < 200; height++) insert.run(height, `hash-${height}`);
        insert.run(9_999, 'hash-9999');
      });
      seed();

      // One new block, so this is a tip-following cycle.
      await sync.runOnce();

      expect(sync.tip()).toBe(10_000);
      expect(Math.min(...storedHeights())).toBeGreaterThanOrEqual(10_000 - 2_880);
    });

    it('does not commit a block that has an incomplete transfer', async () => {
      const source = chainSource({ tip: 5, fetched: [] });
      const original = source.getBlock;
      source.getBlock = async (height: number) => {
        const block = await original(height);
        if (height !== 3) return block;
        return {
          ...block,
          transactions: [
            { txid: 'tx-3', kind: 'transfer', inputs: [], outputs: [], complete: false }
          ]
        };
      };
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' });

      await sync.runOnce();

      // Committing it marks the height done with a buy or sell missing, permanently.
      expect(storedHeights()).not.toContain(3);
      expect(db.prepare<[], { height: number }>(`SELECT height FROM missing_blocks`).all()).toEqual(
        [{ height: 3 }]
      );
    });

    it('verifies hashes with the cheap lookup when the source has one', async () => {
      const source = hashingSource({ tip: 100, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000', REORG_CHECK_DEPTH: '5' });

      await sync.runOnce();
      const fetchedAfterFirst = source.chain.fetched.length;
      await sync.runOnce();

      // Ten full block downloads per cycle just to compare hashes is what pushed a
      // rate-limited source into 429s.
      expect(source.chain.fetched.length - fetchedAfterFirst).toBe(0);
      expect(source.hashCalls.length).toBeGreaterThanOrEqual(5);
    });

    it('rolls back to the real fork point when a reorg is deeper than the check window', async () => {
      const chain: FakeChain = { tip: 30, fetched: [] };
      const source = hashingSource(chain);
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000', REORG_CHECK_DEPTH: '5' });

      await sync.runOnce();

      // Every block from 20 up is replaced; the window only covers 26..30.
      chain.forkedHash = (height) => (height >= 20 ? `fork-${height}` : null);
      await sync.runOnce();

      const hashAt = (height: number) =>
        db
          .prepare<[number], { hash: string }>(`SELECT hash FROM blocks WHERE height = ?`)
          .get(height)?.hash;

      expect(hashAt(19)).toBe('hash-19');
      expect(hashAt(20)).toBe('fork-20');
      expect(hashAt(22)).toBe('fork-22');
      expect(count('blocks')).toBe(30);
    });

    it('does not report success when the source tip is behind what is stored', async () => {
      const onSuccess = vi.fn();
      const source = chainSource({ tip: 10, fetched: [] });
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000' }, silentLogger(), { onSuccess });

      await sync.runOnce();
      expect(onSuccess).toHaveBeenCalledTimes(1);

      // A stuck or lagging source answers with an old tip. There is nothing to fetch, but
      // that is not "caught up": ingestion has stalled and health must go stale.
      source.chain.tip = 5;
      await sync.runOnce();

      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('does not roll back on a single disagreeing hash answer', async () => {
      const chain: FakeChain = { tip: 30, fetched: [] };
      const source = hashingSource(chain);
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000', REORG_CHECK_DEPTH: '5' });

      await sync.runOnce();

      // One node in a pool lies (or glitches) once. Acting on that alone would let any single
      // remote answer delete stored history.
      let lied = false;
      chain.forkedHash = (height) => {
        if (height === 28 && !lied) {
          lied = true;
          return 'liar';
        }
        return null;
      };
      await sync.runOnce();

      expect(sync.stats.reorgedHeights).toBe(0);
      expect(count('blocks')).toBe(30);
    });

    it('repairs due gaps even while forward passes keep failing', async () => {
      const chain: FakeChain = { tip: 20, fetched: [], failingOnce: new Set([5]) };
      const source = chainSource(chain);
      sync = buildSync(db, source, { SYNC_BATCH_SIZE: '1000', REORG_CHECK_DEPTH: '0' });

      await sync.runOnce();
      expect(count('missing_blocks')).toBe(1);

      // Every new tip block fails, so every cycle's forward pass has a failure. Deferring
      // repair on any failure meant height 5 was never retried.
      const original = source.getBlock;
      source.getBlock = async (height: number) => {
        if (height > 20) throw new Error(`tip block ${height} unavailable`);
        return original(height);
      };
      db.exec(`UPDATE missing_blocks SET next_retry_at = 0`);
      chain.tip = 21;
      await sync.runOnce();

      expect(storedHeights()).toContain(5);
    });
  });
});
