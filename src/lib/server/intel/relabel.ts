/**
 * Re-derive flows after a label change (#18).
 *
 * A flow's kinds, its exchange and even which funder it is attributed to depend on labels.
 * When an address's effective label changes, every transfer it took part in is re-derived
 * from the immutable `tx_deltas` with the current labels, and its flows are replaced. The
 * rollup triggers (migrations 2 and 3) move the amounts between kinds in the same
 * transaction, so totals follow the label exactly and never drift from the raw rows.
 *
 * Work is bounded: a batch handles at most `maxTxs` transactions in one write transaction,
 * and {@link Relabeler.run} stops once its time budget is spent, so the event loop is never
 * held for long and the API stays responsive while a big relabel (a newly accepted exchange
 * hot wallet, a fresh node list) works through the backlog.
 */

import type { Logger } from 'pino';
import type { Db } from '../db/database.js';
import { DATA_VERSION_KEY } from '../db/migrations.js';
import { flowsFromDeltas, type FlowRow } from '../ingest/derive.js';
import type { LabelLookup } from '../labels.js';

export interface RelabelOptions {
  /** Transactions per write transaction. */
  readonly maxTxs?: number;
  /** Stop starting new batches after this long. */
  readonly budgetMs?: number;
}

export interface RelabelResult {
  readonly addresses: number;
  readonly txs: number;
  readonly changedTxs: number;
  readonly remaining: number;
  readonly ms: number;
}

const DEFAULT_MAX_TXS = 200;
const DEFAULT_BUDGET_MS = 50;

export class Relabeler {
  /** Per-address progress: the last txid re-derived. Lost on restart, which only repeats work. */
  private readonly cursors = new Map<string, { txid: string; queuedAt: number }>();

  private readonly statements;

  constructor(
    private readonly db: Db,
    private readonly labels: LabelLookup,
    private readonly log: Logger
  ) {
    this.statements = {
      next: db.prepare<[], { address: string; queued_at: number }>(
        `SELECT address, queued_at FROM relabel_queue ORDER BY queued_at, address LIMIT 1`
      ),
      count: db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM relabel_queue`),
      done: db.prepare(`DELETE FROM relabel_queue WHERE address = ? AND queued_at = ?`),
      // Transfers only: a coinbase has no funder, so it can never produce a flow, and a node
      // payout address takes part in thousands of them.
      txids: db.prepare<[string, string, number], { txid: string }>(
        `SELECT DISTINCT d.txid FROM tx_deltas d
         WHERE d.address = ? AND d.txid > ?
           AND EXISTS (SELECT 1 FROM tx_deltas x WHERE x.txid = d.txid AND x.sat_in > 0)
         ORDER BY d.txid
         LIMIT ?`
      ),
      deltas: db.prepare<
        [string],
        { address: string; height: number; time: number; satIn: number; satOut: number }
      >(
        `SELECT address, height, time, sat_in AS satIn, sat_out AS satOut
         FROM tx_deltas WHERE txid = ?`
      ),
      existing: db.prepare<[string], FlowRow & { vout: number }>(
        `SELECT txid, vout, height, time, from_address AS fromAddress, from_kind AS fromKind,
                to_address AS toAddress, to_kind AS toKind, exchange, flow_type AS flowType, sat
         FROM flows WHERE txid = ? ORDER BY vout`
      ),
      remove: db.prepare(`DELETE FROM flows WHERE txid = ?`),
      insert: db.prepare(
        `INSERT INTO flows
           (txid, vout, height, time, from_address, from_kind, to_address, to_kind,
            exchange, flow_type, sat)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      bump: db.prepare(
        `INSERT INTO sync_state (key, value) VALUES ('${DATA_VERSION_KEY}', '1')
         ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`
      )
    };
  }

  /** Addresses still waiting. */
  pending(): number {
    return this.statements.count.get()!.n;
  }

  /**
   * Work through the queue until it is empty or the budget is spent.
   *
   * Synchronous by design: callers run it inside the sync loop's exclusive section, so a
   * relabel batch and a sync batch never interleave their writes.
   */
  run(options: RelabelOptions = {}): RelabelResult {
    const maxTxs = options.maxTxs ?? DEFAULT_MAX_TXS;
    const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
    const started = Date.now();

    let addresses = 0;
    let txs = 0;
    let changedTxs = 0;

    // At least one batch per call, however small the budget, so progress is guaranteed.
    do {
      const next = this.statements.next.get();
      if (!next) break;

      const cursor = this.cursors.get(next.address);
      // Queued again since we started: labels changed mid-way, so start over.
      const after = cursor && cursor.queuedAt === next.queued_at ? cursor.txid : '';
      const batch = this.statements.txids.all(next.address, after, maxTxs).map((row) => row.txid);

      const changed = this.rederive(batch);
      txs += batch.length;
      changedTxs += changed;

      if (batch.length < maxTxs) {
        this.statements.done.run(next.address, next.queued_at);
        this.cursors.delete(next.address);
        addresses++;
      } else {
        this.cursors.set(next.address, { txid: batch.at(-1)!, queuedAt: next.queued_at });
      }
    } while (Date.now() - started < budgetMs);

    const result = {
      addresses,
      txs,
      changedTxs,
      remaining: this.pending(),
      ms: Date.now() - started
    };

    if (changedTxs > 0) this.log.info(result, 'flows re-derived after label changes');
    return result;
  }

  /** Replace the flows of these transactions; @returns how many actually changed. */
  private rederive(txids: readonly string[]): number {
    if (txids.length === 0) return 0;

    let changed = 0;

    this.db.transaction(() => {
      for (const txid of txids) {
        const deltas = this.statements.deltas.all(txid);
        if (deltas.length === 0) continue;

        const { height, time } = deltas[0]!;
        const next = flowsFromDeltas(txid, height, time, deltas, this.labels);
        const current = this.statements.existing.all(txid);

        if (sameFlows(current, next)) continue;

        this.statements.remove.run(txid);
        for (const flow of next) {
          this.statements.insert.run(
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
        changed++;
      }

      // Insert and delete on flows do not bump the data version by themselves (only block
      // writes do), so cached API answers are invalidated here.
      if (changed > 0) this.statements.bump.run();
    })();

    return changed;
  }
}

function sameFlows(current: readonly FlowRow[], next: readonly FlowRow[]): boolean {
  if (current.length !== next.length) return false;

  return current.every((row, index) => {
    const other = next[index]!;
    return (
      row.vout === other.vout &&
      row.fromAddress === other.fromAddress &&
      row.fromKind === other.fromKind &&
      row.toAddress === other.toAddress &&
      row.toKind === other.toKind &&
      row.exchange === other.exchange &&
      row.flowType === other.flowType &&
      row.sat === other.sat &&
      row.height === other.height
    );
  });
}
