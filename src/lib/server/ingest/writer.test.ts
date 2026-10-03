import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../testkit.js';
import { deriveBlock, type DerivedBlock, type Resolver } from './derive.js';
import { BlockWriter } from './writer.js';
import type { NormalisedBlock } from './datasource/types.js';

const SATS = 100_000_000;
const NOW = 1_756_000_000;
const EXCHANGE = 't1coinex1';

const RESOLVE: Resolver = {
  kindOf: (address) => (address === EXCHANGE ? 'exchange' : 'unknown'),
  nameOf: (address) => (address === EXCHANGE ? 'Coinex' : null)
};

function transferBlock(height: number, sat = 5 * SATS): NormalisedBlock {
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
        inputs: [{ address: EXCHANGE, sat, vout: 0 }],
        outputs: [{ n: 0, address: 't1whale', sat: sat - 1_000, nulldata: false }],
        complete: true
      }
    ]
  };
}

function coinbaseBlock(height: number): NormalisedBlock {
  return {
    height,
    hash: `hash-${height}`,
    prevHash: `hash-${height - 1}`,
    time: NOW,
    txCount: 1,
    transactions: [
      {
        txid: `cb-${height}`,
        kind: 'coinbase',
        inputs: [{ address: null, sat: 5 * SATS, vout: -1 }],
        outputs: [{ n: 0, address: 't1miner', sat: 5 * SATS, nulldata: false }],
        complete: true
      }
    ]
  };
}

function derive(...blocks: NormalisedBlock[]): DerivedBlock[] {
  return blocks.map((block) => deriveBlock(block, 'blockbook', RESOLVE));
}

describe('BlockWriter', () => {
  let db: Db;
  let writer: BlockWriter;

  beforeEach(() => {
    db = createTestDb();
    writer = new BlockWriter(db);
  });

  afterEach(() => db.close());

  function count(table: 'blocks' | 'tx_deltas' | 'flows' | 'node_rewards'): number {
    return db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
  }

  describe('writeBatch', () => {
    it('writes blocks, deltas, flows and rewards together', () => {
      const result = writer.writeBatch(derive(transferBlock(1), coinbaseBlock(2)));

      // The transfer contributes two address deltas (exchange out, whale in) and the
      // coinbase one (the miner), so three in total.
      expect(result).toMatchObject({ blocks: 2, deltas: 3, flows: 1, nodeRewards: 1 });
      expect(count('blocks')).toBe(2);
      expect(count('tx_deltas')).toBe(3);
      expect(count('flows')).toBe(1);
      expect(count('node_rewards')).toBe(1);
    });

    it('is idempotent for facts: re-writing a block does not duplicate deltas', () => {
      const batch = derive(transferBlock(1));

      writer.writeBatch(batch);
      const afterFirstWrite = count('tx_deltas');
      writer.writeBatch(batch);

      // tx_deltas is keyed (txid, address) and written with INSERT OR IGNORE precisely so
      // a re-sync cannot duplicate history. v1's INSERT OR REPLACE deleted and reinserted,
      // wiping enhancement results and renumbering row ids (#16).
      expect(count('tx_deltas')).toBe(afterFirstWrite);
      expect(count('blocks')).toBe(1);
      expect(count('flows')).toBe(1);
    });

    it('updates derived flows in place on re-sync', () => {
      const block = transferBlock(1);
      writer.writeBatch(derive(block));

      // Re-derive with the address now labelled as a node operator instead of an exchange.
      const relabelled = deriveBlock(block, 'blockbook', {
        kindOf: () => 'node_operator',
        nameOf: () => null
      });
      writer.writeBatch([relabelled]);

      const flow = db
        .prepare<[], { from_kind: string; flow_type: string }>(
          `SELECT from_kind, flow_type FROM flows`
        )
        .get();

      expect(count('flows')).toBe(1);
      expect(flow).toEqual({ from_kind: 'node_operator', flow_type: 'p2p' });
    });

    it('overwrites node rewards for a re-synced block rather than adding to them', () => {
      const batch = derive(coinbaseBlock(1));

      writer.writeBatch(batch);
      writer.writeBatch(batch);
      writer.writeBatch(batch);

      const row = db
        .prepare<[], { reward_count: number; sat: number }>(
          `SELECT reward_count, sat FROM node_rewards WHERE height = 1`
        )
        .get();

      expect(count('node_rewards')).toBe(1);
      expect(row).toEqual({ reward_count: 1, sat: 5 * SATS });
    });

    it('commits nothing when the batch throws', () => {
      const poisoned = derive(transferBlock(1), transferBlock(2));
      // A block whose derived rows violate a constraint, standing in for any mid-batch
      // failure. The whole batch must roll back, not half of it.
      db.exec(`CREATE TRIGGER boom BEFORE INSERT ON flows
               WHEN NEW.txid = 'tx-2' BEGIN SELECT RAISE(ABORT, 'boom'); END`);

      expect(() => writer.writeBatch(poisoned)).toThrow();

      // This is the #14 guarantee: a block row must never exist without its flow events.
      expect(count('blocks')).toBe(0);
      expect(count('flows')).toBe(0);
      expect(count('tx_deltas')).toBe(0);
    });

    it('clears a height from missing once it lands', () => {
      writer.writeFailures([{ height: 7, error: 'timeout' }]);
      expect(
        db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM missing_blocks`).get()!.n
      ).toBe(1);

      writer.writeBatch(derive(transferBlock(7)));

      expect(
        db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM missing_blocks`).get()!.n
      ).toBe(0);
    });

    it('records the source on each block', () => {
      writer.writeBatch([deriveBlock(transferBlock(1), 'flux-indexer', RESOLVE)]);

      expect(db.prepare<[], { source: string }>(`SELECT source FROM blocks`).get()!.source).toBe(
        'flux-indexer'
      );
    });
  });

  describe('writeFailures', () => {
    it('records the height with an error', () => {
      writer.writeFailures([{ height: 42, error: 'HTTP 503' }]);

      expect(
        db
          .prepare<[], { height: number; attempts: number; last_error: string }>(
            `SELECT height, attempts, last_error FROM missing_blocks`
          )
          .get()
      ).toMatchObject({ height: 42, attempts: 1, last_error: 'HTTP 503' });
    });

    it('increments the attempt count on each failure', () => {
      writer.writeFailures([{ height: 42, error: 'a' }]);
      writer.writeFailures([{ height: 42, error: 'b' }]);

      expect(
        db.prepare<[], { attempts: number }>(`SELECT attempts FROM missing_blocks`).get()!.attempts
      ).toBe(2);
    });

    it('backs off further with each attempt', () => {
      const now = Math.floor(Date.now() / 1000);
      const delay = (): number =>
        db.prepare<[], { r: number }>(`SELECT next_retry_at AS r FROM missing_blocks`).get()!.r -
        now;

      writer.writeFailures([{ height: 1, error: 'a' }]);
      const first = delay();

      writer.writeFailures([{ height: 1, error: 'b' }]);
      const second = delay();

      // 1 min, then 2 min. A height that keeps failing must be retried after a longer
      // wait, never abandoned.
      expect(first).toBeLessThanOrEqual(60);
      expect(second).toBeGreaterThan(first);
    });

    it('caps the backoff at an hour', () => {
      for (let i = 0; i < 30; i++) writer.writeFailures([{ height: 1, error: 'x' }]);

      const now = Math.floor(Date.now() / 1000);
      const retryAt = db
        .prepare<[], { r: number }>(`SELECT next_retry_at AS r FROM missing_blocks`)
        .get()!.r;

      expect(retryAt - now).toBeLessThanOrEqual(3_600);
    });

    it('truncates a huge error message', () => {
      writer.writeFailures([{ height: 1, error: 'x'.repeat(5_000) }]);

      expect(
        db.prepare<[], { n: number }>(`SELECT LENGTH(last_error) AS n FROM missing_blocks`).get()!.n
      ).toBeLessThanOrEqual(300);
    });

    it('does nothing for an empty list', () => {
      writer.writeFailures([]);

      expect(count('blocks')).toBe(0);
    });
  });

  describe('setState', () => {
    it('round-trips a value', () => {
      writer.setState('backfill_next_height', 1234);

      expect(
        db
          .prepare<[string], { value: string }>(`SELECT value FROM sync_state WHERE key = ?`)
          .get('backfill_next_height')!.value
      ).toBe('1234');
    });

    it('overwrites rather than duplicating', () => {
      writer.setState('k', 1);
      writer.setState('k', 2);

      expect(
        db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM sync_state WHERE key = 'k'`).get()!
          .n
      ).toBe(1);
    });
  });

  describe('rollbackFrom', () => {
    it('removes a height and everything derived from it', () => {
      writer.writeBatch(derive(transferBlock(1), transferBlock(2), coinbaseBlock(3)));

      writer.rollbackFrom(2);

      // Only block 1 survives, and with it exactly the rows derived from block 1.
      expect(count('blocks')).toBe(1);
      expect(count('flows')).toBe(1);
      expect(count('tx_deltas')).toBe(2);
      expect(count('node_rewards')).toBe(0);
    });

    it('leaves nothing orphaned in any derived table', () => {
      writer.writeBatch(derive(transferBlock(1), transferBlock(2)));
      writer.rollbackFrom(1);

      for (const table of ['tx_deltas', 'flows', 'node_rewards'] as const) {
        expect(count(table)).toBe(0);
      }
      expect(count('blocks')).toBe(0);
    });

    it('does nothing when there is nothing at or after the height', () => {
      writer.writeBatch(derive(transferBlock(1)));

      writer.rollbackFrom(99);

      expect(count('blocks')).toBe(1);
    });
  });

  describe('pruneBefore', () => {
    it('removes raw data below the floor and keeps the rest', () => {
      writer.writeBatch(
        derive(transferBlock(1), transferBlock(2), transferBlock(3), transferBlock(4))
      );

      const result = writer.pruneBefore(3);

      expect(result.blocks).toBe(2);
      expect(count('blocks')).toBe(2);
      expect(
        db.prepare<[], { min: number }>(`SELECT MIN(height) AS min FROM blocks`).get()!.min
      ).toBe(3);
    });

    it('removes the derived rows of pruned blocks too', () => {
      writer.writeBatch(derive(transferBlock(1), transferBlock(2)));

      writer.pruneBefore(2);

      // Block 1 goes, block 2 and its rows stay.
      expect(count('blocks')).toBe(1);
      expect(count('flows')).toBe(1);
    });

    it('deletes strictly below the floor, never the floor itself', () => {
      writer.writeBatch(derive(transferBlock(1), transferBlock(2), transferBlock(3)));

      writer.pruneBefore(2);

      // The argument is the oldest height to KEEP. Deleting at-or-above it would wipe all
      // the live data and keep only the stale data retention exists to reclaim.
      expect(
        db
          .prepare<[], { min: number; max: number }>(
            `SELECT MIN(height) AS min, MAX(height) AS max FROM blocks`
          )
          .get()
      ).toEqual({ min: 2, max: 3 });
    });

    it('reclaims space, so the file does not grow without bound', () => {
      for (let height = 1; height <= 200; height++) {
        writer.writeBatch(derive(transferBlock(height)));
      }

      const before = db.pragma('page_count', { simple: true }) as number;
      writer.pruneBefore(150);
      const after = db.pragma('page_count', { simple: true }) as number;

      expect(after).toBeLessThan(before);
    });

    it('prunes node rewards and missing heights below the floor too', () => {
      writer.writeBatch(derive(coinbaseBlock(1), coinbaseBlock(2), coinbaseBlock(3)));
      writer.writeFailures([
        { height: 1, error: 'old' },
        { height: 5, error: 'live' }
      ]);

      writer.pruneBefore(3);

      // Rewards are keyed by height precisely so retention can prune them, and a missing
      // height below the floor would otherwise be retried - and re-written - forever.
      expect(db.prepare<[], { height: number }>(`SELECT height FROM node_rewards`).all()).toEqual([
        { height: 3 }
      ]);
      expect(db.prepare<[], { height: number }>(`SELECT height FROM missing_blocks`).all()).toEqual(
        [{ height: 5 }]
      );
    });

    it('does not rewrite the whole database for a small prune', () => {
      for (let height = 1; height <= 20; height++) {
        writer.writeBatch(derive(transferBlock(height)));
      }

      const statements: string[] = [];
      const exec = db.exec.bind(db);
      db.exec = ((sql: string) => {
        statements.push(sql);
        return exec(sql);
      }) as typeof db.exec;

      writer.pruneBefore(10);

      // A full VACUUM copies every page of a multi-GB file while blocking the event loop.
      expect(statements.some((sql) => /^\s*VACUUM\b/i.test(sql))).toBe(false);
    });

    it('is a no-op when everything is inside the window', () => {
      writer.writeBatch(derive(transferBlock(10)));

      expect(writer.pruneBefore(1).blocks).toBe(0);
      expect(count('blocks')).toBe(1);
    });
  });
});
