/**
 * The single writer.
 *
 * Everything ingestion writes goes through here, inside one transaction per batch. That is
 * the fix for #14: v1 wrote the `blocks` row first, then fetched transactions over the
 * network, then wrote flow events at the *end* of the whole 500-block batch. A crash, a
 * container stop, or a single failed transaction fetch left up to 500 heights marked synced
 * with no flow events, and because the block row is what marks a height as done, they were
 * never revisited.
 *
 * Here the order is: derive everything in memory, then commit the block rows, deltas, flows,
 * rewards and missing-height bookkeeping together. Either all of a batch lands or none of
 * it does.
 */

import type { Logger } from 'pino';
import type { Db } from '../db/database.js';
import type { DerivedBlock } from './derive.js';

/**
 * Below this many pruned blocks, a database not yet on incremental auto-vacuum keeps its
 * free pages for reuse rather than running a full VACUUM. A week of blocks; the steady-state
 * prune is a few hundred, and rewriting a multi-GB file for that blocks the event loop.
 */
const FULL_VACUUM_MIN_BLOCKS = 7 * 2_880;

/** `PRAGMA auto_vacuum` reports 2 for INCREMENTAL. */
const AUTO_VACUUM_INCREMENTAL = 2;

const SQL = {
  upsertBlock: `
    INSERT INTO blocks (height, hash, prev_hash, time, tx_count, source)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (height) DO UPDATE SET
      hash = excluded.hash,
      prev_hash = excluded.prev_hash,
      time = excluded.time,
      tx_count = excluded.tx_count,
      source = excluded.source,
      ingested_at = CAST(strftime('%s','now') AS INTEGER)
  `,

  /*
   * `INSERT OR IGNORE`, never `INSERT OR REPLACE`.
   *
   * v1 used REPLACE on flow_events, which deletes the existing row and inserts a new one —
   * wiping every enhancement result and handing the row a new id. Deltas are immutable
   * facts, so a conflict means the same fact was already recorded (#16).
   */
  insertDelta: `
    INSERT OR IGNORE INTO tx_deltas (txid, address, height, time, sat_in, sat_out)
    VALUES (?, ?, ?, ?, ?, ?)
  `,

  /*
   * Flows ARE replaced, because they are derived: relabelling an exchange has to change
   * them. The natural key is (txid, vout), so a re-derivation updates in place and never
   * renumbers anything the API might be pointing at.
   */
  upsertFlow: `
    INSERT INTO flows
      (txid, vout, height, time, from_address, from_kind, to_address, to_kind,
       exchange, flow_type, sat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (txid, vout) DO UPDATE SET
      height = excluded.height,
      from_address = excluded.from_address,
      from_kind = excluded.from_kind,
      to_address = excluded.to_address,
      to_kind = excluded.to_kind,
      exchange = excluded.exchange,
      flow_type = excluded.flow_type,
      sat = excluded.sat
  `,

  /*
   * Node rewards are keyed by (address, height) and written ABSOLUTELY, not additively.
   *
   * Re-syncing a block — which happens on every gap repair and after every reorg — must
   * leave the same value, not a doubled one.
   */
  upsertNodeReward: `
    INSERT INTO node_rewards (address, height, day, reward_count, sat)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (address, height) DO UPDATE SET
      day = excluded.day,
      reward_count = excluded.reward_count,
      sat = excluded.sat
  `,

  markMissing: `
    INSERT INTO missing_blocks (height, attempts, last_error, next_retry_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (height) DO UPDATE SET
      attempts = excluded.attempts,
      last_error = excluded.last_error,
      next_retry_at = excluded.next_retry_at
  `,

  clearMissing: `DELETE FROM missing_blocks WHERE height = ?`,

  setState: `
    INSERT INTO sync_state (key, value, updated_at)
    VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER))
    ON CONFLICT (key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `,

  /*
   * Two deletes that look alike and are not:
   *
   *   deleteFrom   - at or ABOVE a height. For reorg rollback, where the fork point and
   *                  everything after it must go.
   *   deleteBefore - strictly BELOW a height. For retention, where the argument is the
   *                  floor to KEEP.
   *
   * Using `deleteFrom` for retention would delete everything from the floor onwards: all
   * the live data, and none of the old data it was supposed to reclaim.
   */
  deleteFrom: (table: 'blocks' | 'tx_deltas' | 'flows' | 'node_rewards') =>
    `DELETE FROM ${table} WHERE height >= ?`,

  deleteBefore: (table: 'blocks' | 'tx_deltas' | 'flows' | 'node_rewards' | 'missing_blocks') =>
    `DELETE FROM ${table} WHERE height < ?`
};

export interface WriteResult {
  readonly blocks: number;
  readonly deltas: number;
  readonly flows: number;
  readonly nodeRewards: number;
  readonly ms: number;
}

/**
 * A prepared statement, typed only by the parameters it accepts.
 *
 * The statements are compiled once here and reused for every row of every batch; v1 called
 * `db.prepare()` inside `saveBlock`/`saveTransaction`, so it compiled a statement per row.
 * better-sqlite3's generic overloads do not survive being stored in a field, so the bind
 * parameters are widened to their actual runtime type rather than re-declared per call.
 */
interface Runnable {
  run(...params: (string | number | null)[]): { changes: number };
}

type Stmt = Runnable;

export class BlockWriter {
  private readonly statements: {
    upsertBlock: Stmt;
    insertDelta: Stmt;
    upsertFlow: Stmt;
    upsertNodeReward: Stmt;
    markMissing: Stmt;
    clearMissing: Stmt;
    setState: Stmt;
    deleteFrom: Record<'blocks' | 'tx_deltas' | 'flows' | 'node_rewards', Stmt>;
    deleteBefore: Record<
      'blocks' | 'tx_deltas' | 'flows' | 'node_rewards' | 'missing_blocks',
      Stmt
    >;
    commitBatch: (blocks: DerivedBlock[]) => void;
    commitMissing: (
      failures: { height: number; error: string; attempts: number; retryAt: number }[]
    ) => void;
  };

  constructor(private readonly db: Db) {
    // Bind parameters are left open on purpose: the tuples are fixed by the SQL constants
    // above, and re-declaring them at every call site adds nothing but noise.
    const prepare = (sql: string): Stmt => db.prepare(sql) as unknown as Stmt;

    this.statements = {
      upsertBlock: prepare(SQL.upsertBlock),
      insertDelta: prepare(SQL.insertDelta),
      upsertFlow: prepare(SQL.upsertFlow),
      upsertNodeReward: prepare(SQL.upsertNodeReward),
      markMissing: prepare(SQL.markMissing),
      clearMissing: prepare(SQL.clearMissing),
      setState: prepare(SQL.setState),
      deleteFrom: {
        blocks: prepare(SQL.deleteFrom('blocks')),
        tx_deltas: prepare(SQL.deleteFrom('tx_deltas')),
        flows: prepare(SQL.deleteFrom('flows')),
        node_rewards: prepare(SQL.deleteFrom('node_rewards'))
      },
      deleteBefore: {
        blocks: prepare(SQL.deleteBefore('blocks')),
        tx_deltas: prepare(SQL.deleteBefore('tx_deltas')),
        flows: prepare(SQL.deleteBefore('flows')),
        node_rewards: prepare(SQL.deleteBefore('node_rewards')),
        missing_blocks: prepare(SQL.deleteBefore('missing_blocks'))
      },
      commitBatch: db.transaction((blocks: DerivedBlock[]) => {
        for (const block of blocks) {
          this.statements.upsertBlock.run(
            block.height,
            block.hash,
            block.prevHash,
            block.time,
            block.txCount,
            block.source
          );

          for (const delta of block.deltas) {
            this.statements.insertDelta.run(
              delta.txid,
              delta.address,
              delta.height,
              delta.time,
              delta.satIn,
              delta.satOut
            );
          }

          for (const flow of block.flows) {
            this.statements.upsertFlow.run(
              flow.txid,
              flow.vout,
              flow.height,
              flow.time,
              flow.fromAddress,
              flow.fromKind,
              flow.toAddress,
              flow.toKind,
              flow.exchange,
              flow.flowType,
              flow.sat
            );
          }

          for (const reward of block.nodeRewards) {
            this.statements.upsertNodeReward.run(
              reward.address,
              reward.height,
              reward.day,
              reward.rewardCount,
              reward.sat
            );
          }

          // Committed, so the height is no longer missing.
          this.statements.clearMissing.run(block.height);
        }
      }),
      commitMissing: db.transaction(
        (failures: { height: number; error: string; attempts: number; retryAt: number }[]) => {
          for (const failure of failures) {
            this.statements.markMissing.run(
              failure.height,
              failure.attempts,
              failure.error,
              failure.retryAt
            );
          }
        }
      )
    };
  }

  /**
   * Commit a batch of derived blocks atomically.
   *
   * @throws whatever better-sqlite3 throws; the caller records the heights as missing so
   * they are retried rather than lost.
   */
  writeBatch(blocks: DerivedBlock[]): WriteResult {
    const startedAt = Date.now();

    this.statements.commitBatch(blocks);

    return {
      blocks: blocks.length,
      deltas: blocks.reduce((sum, block) => sum + block.deltas.length, 0),
      flows: blocks.reduce((sum, block) => sum + block.flows.length, 0),
      nodeRewards: blocks.reduce((sum, block) => sum + block.nodeRewards.length, 0),
      ms: Date.now() - startedAt
    };
  }

  /**
   * Record heights that could not be fetched, with exponential backoff.
   *
   * The delay is computed from the attempt count **already in the table**, not from a count
   * passed in by the caller: a caller that passed its own attempt number would restart the
   * delay at 60s on every retry, so a permanently failing height would be hammered every
   * minute for as long as the service ran.
   */
  writeFailures(failures: { height: number; error: string }[]): void {
    if (failures.length === 0) return;

    const now = Math.floor(Date.now() / 1000);
    const selectAttempts = this.db.prepare<[number], { attempts: number }>(
      `SELECT attempts FROM missing_blocks WHERE height = ?`
    );

    this.statements.commitMissing(
      failures.map((failure) => {
        const previous = selectAttempts.get(failure.height)?.attempts ?? 0;

        return {
          height: failure.height,
          error: failure.error.slice(0, 300),
          attempts: previous + 1,
          // 1m, 2m, 4m ... capped at an hour. Retried indefinitely: a height that fails
          // once must never be silently dropped (#13).
          retryAt: now + Math.min(60 * 2 ** Math.min(previous, 6), 3_600)
        };
      })
    );
  }

  /** Persist a cursor so a restart resumes instead of re-deriving where it was. */
  setState(key: string, value: unknown): void {
    this.statements.setState.run(key, JSON.stringify(value));
  }

  /**
   * Delete a height and everything derived from it, for reorg rollback (#13).
   *
   * Order matters: derived rows first, then the block row, so a crash mid-rollback leaves
   * orphan rows rather than a block claiming heights that have no data.
   */
  rollbackFrom(height: number): void {
    const run = this.db.transaction(() => {
      this.statements.deleteFrom.tx_deltas.run(height);
      this.statements.deleteFrom.flows.run(height);
      this.statements.deleteFrom.node_rewards.run(height);
      this.statements.deleteFrom.blocks.run(height);
    });

    run();
  }

  /**
   * Prune raw data older than the retention window (#17).
   *
   * @param floor the oldest height to **keep**; everything below it is deleted.
   */
  pruneBefore(floor: number): {
    blocks: number;
    deltas: number;
    flows: number;
    nodeRewards: number;
    missing: number;
  } {
    const run = this.db.transaction(() => ({
      deltas: this.statements.deleteBefore.tx_deltas.run(floor).changes,
      flows: this.statements.deleteBefore.flows.run(floor).changes,
      // Rewards are keyed by height precisely so they can be pruned with their block.
      nodeRewards: this.statements.deleteBefore.node_rewards.run(floor).changes,
      // A missing height below the floor is no longer wanted. Left in place it would be
      // retried forever, re-written on success, and pruned again on the next pass.
      missing: this.statements.deleteBefore.missing_blocks.run(floor).changes,
      blocks: this.statements.deleteBefore.blocks.run(floor).changes
    }));

    const result = run();

    if (result.blocks > 0) this.reclaim(result.blocks);

    return result;
  }

  /**
   * Hand freed pages back to the OS without rewriting the database.
   *
   * On incremental auto-vacuum (every database created by this version) that costs time in
   * proportion to the pages freed, not to the size of the file. An older file is only
   * VACUUMed after a large prune, which also switches it to incremental mode for good;
   * after a small one its free pages are simply reused by the next inserts.
   */
  private reclaim(prunedBlocks: number): void {
    if (this.db.pragma('auto_vacuum', { simple: true }) === AUTO_VACUUM_INCREMENTAL) {
      this.db.pragma('incremental_vacuum');
      return;
    }

    if (prunedBlocks < FULL_VACUUM_MIN_BLOCKS) return;

    // VACUUM cannot run inside a transaction and cannot run while WAL is being written.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');
  }
}

/** Log a block that derived with warnings, without treating it as a failure. */
export function logWarnings(log: Logger, warnings: string[], height: number): void {
  if (warnings.length === 0) return;

  // Deduplicate: one 200-transfer block can produce the same conservation warning dozens of
  // times, and a wall of identical lines hides the one that matters.
  const unique = [...new Set(warnings)];

  log.warn(
    { height, warnings: unique.slice(0, 5), total: unique.length },
    'block derived with warnings'
  );
}
