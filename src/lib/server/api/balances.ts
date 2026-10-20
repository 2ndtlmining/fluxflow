/**
 * What a wallet (or an entity's wallets) holds, and held over time (#67).
 *
 * The current balance comes from your own node's address index (`FLUX_NODE_URL`), the same
 * call the Foundation report uses. History is rebuilt **backwards** from it: each day's
 * closing balance is the next day's minus that day's net change in `tx_deltas`. Anchoring
 * on today means pruned history does not matter. The line simply starts where raw
 * retention does, at whatever the wallet held then.
 *
 * Without a node there is no anchor, so the series is the running net change since the
 * first stored day (`balance` is null and `change` is what is drawn).
 *
 * Every delta counts: coinbase rewards, transfers that produced no flow, and the fee on a
 * self-transfer. That is what makes the line exact, and what lets `consistent` catch a gap.
 * A history that would dip below zero means a block or transaction is missing (or the node
 * is ahead of the stored tip), and the page says so instead of drawing a negative balance.
 */

import type { Db } from '../db/database.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import type { BalanceSnapshot } from '../intel/foundation.js';

const DAY = 86_400;
/** Below this, a back-computed balance is rounding or fees, not a gap. */
const NEGATIVE_TOLERANCE_SAT = 0.01 * SATS_PER_FLUX;

export interface BalancePoint {
  /** Day start, unix seconds. */
  readonly time: number;
  /** Net change on the day, FLUX. */
  readonly net: number;
  /** Running net change from the first stored day, FLUX. */
  readonly change: number;
  /** Closing balance, when the current balance is known. */
  readonly balance: number | null;
}

export interface BalanceHistory {
  /** Current balance in FLUX, or null when no node answered. */
  readonly balance: number | null;
  /** When `balance` was read (ms), or null. */
  readonly asOf: number | null;
  /** What it held before the first stored day, when `balance` is known. */
  readonly opening: number | null;
  /** Days with activity only, oldest first. */
  readonly series: BalancePoint[];
  /** False when the back-computed history dips below zero: something is missing. */
  readonly consistent: boolean;
  /** Newest stored block, to compare against the node's view. */
  readonly tipHeight: number | null;
}

/**
 * Balance history for one or more addresses, anchored on their combined current balance.
 *
 * `balances` must cover every address for the line to be anchored; a partial snapshot would
 * understate the total, so it is treated as unknown.
 */
export function balanceHistory(
  db: Db,
  addresses: readonly string[],
  balances: BalanceSnapshot | null
): BalanceHistory {
  const marks = addresses.map(() => '?').join(', ');
  const rows =
    addresses.length === 0
      ? []
      : db
          .prepare<string[], { day: number; net: number }>(
            `SELECT time / ${DAY} AS day, SUM(sat_out - sat_in) AS net
             FROM tx_deltas INDEXED BY idx_tx_deltas_address
             WHERE address IN (${marks})
             GROUP BY day
             ORDER BY day`
          )
          .all(...addresses);

  const known =
    balances !== null && addresses.length > 0 && addresses.every((a) => balances.sat.has(a));
  const current = known ? addresses.reduce((sum, a) => sum + balances.sat.get(a)!, 0) : null;

  // Closing balances, newest first: today's is the current balance.
  const closing: (number | null)[] = new Array<number | null>(rows.length).fill(null);
  let running = current;
  for (let index = rows.length - 1; index >= 0; index--) {
    closing[index] = running;
    if (running !== null) running -= rows[index]!.net;
  }
  const opening = running;

  let change = 0;
  const series = rows.map((row, index) => {
    change += row.net;
    const close = closing[index]!;
    return {
      time: row.day * DAY,
      net: row.net / SATS_PER_FLUX,
      change: change / SATS_PER_FLUX,
      balance: close === null ? null : close / SATS_PER_FLUX
    };
  });

  const lowest =
    opening === null ? null : Math.min(opening, ...closing.map((value) => value ?? opening));

  return {
    balance: current === null ? null : current / SATS_PER_FLUX,
    asOf: known ? balances.at : null,
    opening: opening === null ? null : opening / SATS_PER_FLUX,
    series,
    consistent: lowest === null || lowest >= -NEGATIVE_TOLERANCE_SAT,
    tipHeight:
      db.prepare<[], { height: number | null }>(`SELECT MAX(height) AS height FROM blocks`).get()
        ?.height ?? null
  };
}

/** Reads balances for a set of addresses; resolves to whichever it could read. */
export type BalanceFetcher = (addresses: readonly string[]) => Promise<BalanceSnapshot | null>;

/**
 * Per-address balances from the node, cached so a page view is one node call at most, and
 * repeat views (or several tabs) none.
 *
 * Concurrent requests for the same address share one call. Entries expire after `ttlMs`; the
 * cache holds at most `maxEntries` addresses, least recently read evicted first.
 */
export class BalanceCache {
  private readonly entries = new Map<string, { sat: number; at: number }>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly fetch: BalanceFetcher,
    private readonly options: { ttlMs?: number; maxEntries?: number; maxPerRequest?: number } = {}
  ) {}

  /** The most addresses one request may ask the node about; more is left unknown. */
  get maxPerRequest(): number {
    return this.options.maxPerRequest ?? 50;
  }

  async get(addresses: readonly string[], now = Date.now()): Promise<BalanceSnapshot | null> {
    const ttl = this.options.ttlMs ?? 5 * 60_000;
    const fresh = (address: string) => {
      const entry = this.entries.get(address);
      return entry !== undefined && now - entry.at < ttl;
    };

    const missing = addresses.filter((address) => !fresh(address) && !this.pending.has(address));
    if (missing.length > 0 && missing.length <= this.maxPerRequest) {
      const call = this.fetch(missing).then((snapshot) => {
        for (const [address, sat] of snapshot?.sat ?? []) this.store(address, sat, snapshot!.at);
      });
      const shared = call
        .catch(() => undefined)
        .finally(() => {
          for (const address of missing) this.pending.delete(address);
        });
      for (const address of missing) this.pending.set(address, shared);
    }
    await Promise.all(addresses.map((address) => this.pending.get(address)));

    const sat = new Map<string, number>();
    let at = Infinity;
    for (const address of addresses) {
      const entry = this.entries.get(address);
      if (!entry) continue;
      sat.set(address, entry.sat);
      at = Math.min(at, entry.at);
    }
    return sat.size > 0 ? { at, sat } : null;
  }

  private store(address: string, sat: number, at: number): void {
    this.entries.delete(address);
    this.entries.set(address, { sat, at });
    const max = this.options.maxEntries ?? 2_000;
    while (this.entries.size > max) this.entries.delete(this.entries.keys().next().value!);
  }
}
