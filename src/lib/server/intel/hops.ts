/**
 * Exchange hops (#20): a withdrawal and a re-deposit by the same wallet.
 *
 * The PoC found `t1LGZFS…` withdrawing 7,866 FLUX from Coinex and depositing 7,866 FLUX into
 * Kucoin 13 blocks later. That is one movement between exchanges — arbitrage, or moving a
 * balance — but it shows up as a "buy" and a "sell" of the same coins, inflating both sides.
 *
 * A hop is a `buying` flow to wallet W followed, within `maxBlocks`, by a `selling` flow from
 * W of between `minRatio` and 100% of the withdrawn amount (the difference is fees or a small
 * remainder kept). Each leg belongs to at most one hop, matched earliest-first. Hops are
 * stored, not subtracted: the API reports totals with and without them.
 */

import type { Db } from '../db/database.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';

export interface HopOptions {
  /** How long the coins may sit in the wallet. 240 blocks ≈ 2 hours. */
  readonly maxBlocks?: number;
  /** The deposit must be at least this share of the withdrawal. */
  readonly minRatio?: number;
}

export const DEFAULT_HOP_OPTIONS = { maxBlocks: 240, minRatio: 0.97 } as const;

interface Pair {
  buyTxid: string;
  buyVout: number;
  sellTxid: string;
  sellVout: number;
  address: string;
  fromExchange: string;
  toExchange: string;
  buySat: number;
  sellSat: number;
  buyHeight: number;
  sellHeight: number;
  buyTime: number;
  sellTime: number;
}

/**
 * Re-detect hops whose withdrawal is at or after `sinceHeight`.
 *
 * Incremental: the caller passes the lowest height that can have changed (the last tip minus
 * `maxBlocks`); everything from there is recomputed. A full rebuild is `sinceHeight = 0`.
 */
export function detectHops(
  db: Db,
  sinceHeight: number,
  options: HopOptions = {}
): { hops: number; sinceHeight: number } {
  const maxBlocks = options.maxBlocks ?? DEFAULT_HOP_OPTIONS.maxBlocks;
  const minRatio = options.minRatio ?? DEFAULT_HOP_OPTIONS.minRatio;

  const pairs = db
    .prepare<[number, number, number], Pair>(
      `SELECT b.txid AS buyTxid, b.vout AS buyVout, s.txid AS sellTxid, s.vout AS sellVout,
              b.to_address AS address, b.exchange AS fromExchange, s.exchange AS toExchange,
              b.sat AS buySat, s.sat AS sellSat, b.height AS buyHeight, s.height AS sellHeight,
              b.time AS buyTime, s.time AS sellTime
       FROM flows b
       JOIN flows s
         ON s.from_address = b.to_address
        AND s.flow_type = 'selling'
        AND s.height BETWEEN b.height AND b.height + ?
        AND s.txid <> b.txid
        AND s.sat <= b.sat
        AND s.sat >= b.sat * ?
       WHERE b.flow_type = 'buying' AND b.height >= ?
         AND b.exchange IS NOT NULL AND s.exchange IS NOT NULL
       ORDER BY b.height, b.txid, b.vout, s.height, s.txid, s.vout`
    )
    .all(maxBlocks, minRatio, sinceHeight);

  const usedBuys = new Set<string>();
  const usedSells = new Set<string>();
  const hops: Pair[] = [];

  for (const pair of pairs) {
    const buy = `${pair.buyTxid}:${pair.buyVout}`;
    const sell = `${pair.sellTxid}:${pair.sellVout}`;
    if (usedBuys.has(buy) || usedSells.has(sell)) continue;
    usedBuys.add(buy);
    usedSells.add(sell);
    hops.push(pair);
  }

  db.transaction(() => {
    db.prepare(`DELETE FROM exchange_hops WHERE buy_height >= ?`).run(sinceHeight);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO exchange_hops
         (buy_txid, buy_vout, sell_txid, sell_vout, address, from_exchange, to_exchange,
          buy_sat, sell_sat, buy_height, sell_height, buy_time, sell_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // A sell leg already claimed by an earlier hop (before sinceHeight) stays with it.
    const claimed = db.prepare<[string, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM exchange_hops WHERE sell_txid = ? AND sell_vout = ?`
    );
    for (const hop of hops) {
      if (claimed.get(hop.sellTxid, hop.sellVout)!.n > 0) continue;

      insert.run(
        hop.buyTxid,
        hop.buyVout,
        hop.sellTxid,
        hop.sellVout,
        hop.address,
        hop.fromExchange,
        hop.toExchange,
        hop.buySat,
        hop.sellSat,
        hop.buyHeight,
        hop.sellHeight,
        hop.buyTime,
        hop.sellTime
      );
    }
  })();

  return { hops: hops.length, sinceHeight };
}

export interface HopSummary {
  readonly count: number;
  /** FLUX of withdrawals in the window that were hops. */
  readonly buyingExcluded: number;
  /** FLUX of deposits in the window that were hops. */
  readonly sellingExcluded: number;
}

/** Hop legs inside a time window. Legs are counted by their own time, like the flows. */
export function summariseHops(db: Db, fromTime: number, toTime: number): HopSummary {
  const row = db
    .prepare<
      [number, number, number, number, number, number],
      { count: number; buy: number | null; sell: number | null }
    >(
      `SELECT
         (SELECT COUNT(*) FROM exchange_hops WHERE sell_time BETWEEN ? AND ?) AS count,
         (SELECT SUM(buy_sat) FROM exchange_hops WHERE buy_time BETWEEN ? AND ?) AS buy,
         (SELECT SUM(sell_sat) FROM exchange_hops WHERE sell_time BETWEEN ? AND ?) AS sell`
    )
    .get(fromTime, toTime, fromTime, toTime, fromTime, toTime)!;

  return {
    count: row.count,
    buyingExcluded: (row.buy ?? 0) / SATS_PER_FLUX,
    sellingExcluded: (row.sell ?? 0) / SATS_PER_FLUX
  };
}

export interface HopEvent {
  readonly address: string;
  readonly fromExchange: string;
  readonly toExchange: string;
  readonly amount: number;
  readonly withdrawn: number;
  readonly blocksApart: number;
  readonly buyTxid: string;
  readonly sellTxid: string;
  readonly sellHeight: number;
  readonly sellTime: number;
}

export function listHops(db: Db, fromTime: number, toTime: number, limit = 50): HopEvent[] {
  return db
    .prepare<
      [number, number, number],
      {
        address: string;
        fromExchange: string;
        toExchange: string;
        buySat: number;
        sellSat: number;
        buyHeight: number;
        sellHeight: number;
        buyTxid: string;
        sellTxid: string;
        sellTime: number;
      }
    >(
      `SELECT address, from_exchange AS fromExchange, to_exchange AS toExchange,
              buy_sat AS buySat, sell_sat AS sellSat, buy_height AS buyHeight,
              sell_height AS sellHeight, buy_txid AS buyTxid, sell_txid AS sellTxid,
              sell_time AS sellTime
       FROM exchange_hops
       WHERE sell_time BETWEEN ? AND ?
       ORDER BY sell_time DESC
       LIMIT ?`
    )
    .all(fromTime, toTime, Math.min(Math.max(1, limit), 200))
    .map((row) => ({
      address: row.address,
      fromExchange: row.fromExchange,
      toExchange: row.toExchange,
      amount: row.sellSat / SATS_PER_FLUX,
      withdrawn: row.buySat / SATS_PER_FLUX,
      blocksApart: row.sellHeight - row.buyHeight,
      buyTxid: row.buyTxid,
      sellTxid: row.sellTxid,
      sellHeight: row.sellHeight,
      sellTime: row.sellTime
    }));
}
