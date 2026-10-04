/**
 * The Flux Foundation's wallets (#31), from local data.
 *
 * Every movement is netted per transaction across *all* Foundation wallets, so moving money
 * between its own wallets nets to (minus) the fee and is reported as internal rather than as
 * an outflow followed by an inflow. Balances come from your own node's address index when
 * one is configured (`FLUX_NODE_URL`); history is then reconstructed backwards from the
 * current balance using the stored deltas, so it covers the raw retention window.
 */

import type { Db } from '../db/database.js';
import { httpJson, type HttpRequestOptions } from '../http.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import type { LabelLookup } from '../labels.js';

/** A Foundation-wide net below this (in absolute value) is an internal move plus fee. */
const INTERNAL_TOLERANCE_SAT = 0.01 * SATS_PER_FLUX;
const DAY = 86_400;

export interface FoundationWallet {
  readonly address: string;
  readonly name: string | null;
  readonly subLabel: string | null;
  /** Current balance in FLUX, when a node with an address index is configured. */
  readonly balance: number | null;
  readonly inflow: number;
  readonly outflow: number;
  readonly net: number;
}

export interface FoundationMovement {
  readonly txid: string;
  readonly height: number;
  readonly time: number;
  /** Positive: into the Foundation. Negative: out of it. */
  readonly amount: number;
  readonly counterparty: string | null;
  readonly counterpartyName: string | null;
  readonly counterpartyKind: string;
  readonly wallets: string[];
}

export interface FoundationReport {
  readonly wallets: FoundationWallet[];
  readonly totals: {
    readonly balance: number | null;
    readonly inflow: number;
    readonly outflow: number;
    readonly net: number;
    readonly internalTransfers: number;
    readonly internalVolume: number;
  };
  /** Daily net and, when the current balance is known, the end-of-day balance. */
  readonly series: { time: number; net: number; balance: number | null }[];
  readonly recent: FoundationMovement[];
  readonly balancesAsOf: number | null;
}

/** Balances by address, refreshed by the intelligence service off the request path. */
export type BalanceSnapshot = { readonly at: number; readonly sat: ReadonlyMap<string, number> };

/** Read balances through FluxOS's `getaddressbalance` (needs the address index). */
export async function fetchBalances(
  baseUrl: string,
  addresses: readonly string[],
  http: Partial<HttpRequestOptions> = {}
): Promise<BalanceSnapshot | null> {
  const sat = new Map<string, number>();
  const base = baseUrl.replace(/\/+$/, '');

  for (const address of addresses) {
    try {
      const reply = await httpJson<{ status: string; data?: { balance?: number } }>(
        `${base}/daemon/getaddressbalance/${encodeURIComponent(address)}`,
        { timeoutMs: 10_000, retries: 1, ...http }
      );
      if (reply.status === 'success' && typeof reply.data?.balance === 'number') {
        sat.set(address, reply.data.balance);
      }
    } catch {
      // Leave it unknown rather than fail the whole report.
    }
  }

  return sat.size > 0 ? { at: Date.now(), sat } : null;
}

export function foundationReport(
  db: Db,
  labels: LabelLookup,
  window: { fromTime: number; toTime: number },
  balances: BalanceSnapshot | null = null
): FoundationReport {
  const addresses = labels.addressesOf('foundation');
  const empty: FoundationReport = {
    wallets: [],
    totals: {
      balance: null,
      inflow: 0,
      outflow: 0,
      net: 0,
      internalTransfers: 0,
      internalVolume: 0
    },
    series: [],
    recent: [],
    balancesAsOf: null
  };
  if (addresses.length === 0) return empty;

  return db.transaction(() => {
    db.prepare(`CREATE TEMP TABLE IF NOT EXISTS foundation_set (address TEXT PRIMARY KEY)`).run();
    db.prepare(`DELETE FROM foundation_set`).run();
    const insert = db.prepare(`INSERT OR IGNORE INTO foundation_set (address) VALUES (?)`);
    for (const address of addresses) insert.run(address);

    // Per transaction: the Foundation-wide net, and how much moved between its own wallets.
    const txs = db
      .prepare<
        [number, number],
        { txid: string; height: number; time: number; net: number; moved: number; wallets: string }
      >(
        `SELECT d.txid, d.height, d.time, SUM(d.sat_out - d.sat_in) AS net,
                SUM(d.sat_in) AS moved, GROUP_CONCAT(d.address) AS wallets
         FROM tx_deltas d JOIN foundation_set f ON f.address = d.address
         WHERE d.time BETWEEN ? AND ?
         GROUP BY d.txid
         ORDER BY d.height DESC`
      )
      .all(window.fromTime, window.toTime);

    let inflow = 0;
    let outflow = 0;
    let internalTransfers = 0;
    let internalVolume = 0;
    const external: typeof txs = [];
    const internal = new Set<string>();
    const daily = new Map<number, number>();

    for (const tx of txs) {
      if (Math.abs(tx.net) <= INTERNAL_TOLERANCE_SAT && tx.moved > 0) {
        internal.add(tx.txid);
        internalTransfers++;
        internalVolume += tx.moved;
        continue;
      }
      if (tx.net > 0) inflow += tx.net;
      else outflow -= tx.net;
      external.push(tx);
      const day = Math.floor(tx.time / DAY) * DAY;
      daily.set(day, (daily.get(day) ?? 0) + tx.net);
    }

    // Per wallet, excluding internal transactions.
    const perWallet = db
      .prepare<[number, number], { address: string; txid: string; delta: number }>(
        `SELECT d.address, d.txid, d.sat_out - d.sat_in AS delta
         FROM tx_deltas d JOIN foundation_set f ON f.address = d.address
         WHERE d.time BETWEEN ? AND ?`
      )
      .all(window.fromTime, window.toTime);

    const walletTotals = new Map<string, { inflow: number; outflow: number }>();
    for (const row of perWallet) {
      if (internal.has(row.txid)) continue;
      const totals = walletTotals.get(row.address) ?? { inflow: 0, outflow: 0 };
      if (row.delta > 0) totals.inflow += row.delta;
      else totals.outflow -= row.delta;
      walletTotals.set(row.address, totals);
    }

    const wallets: FoundationWallet[] = addresses
      .map((address) => {
        const label = labels.labelOf(address);
        const totals = walletTotals.get(address) ?? { inflow: 0, outflow: 0 };
        const balance = balances?.sat.get(address);
        return {
          address,
          name: label?.name ?? null,
          subLabel: label?.subLabel ?? null,
          balance: balance === undefined ? null : balance / SATS_PER_FLUX,
          inflow: totals.inflow / SATS_PER_FLUX,
          outflow: totals.outflow / SATS_PER_FLUX,
          net: (totals.inflow - totals.outflow) / SATS_PER_FLUX
        };
      })
      .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0) || b.outflow - a.outflow);

    const knownBalance =
      balances && addresses.every((address) => balances.sat.has(address))
        ? addresses.reduce((sum, address) => sum + balances.sat.get(address)!, 0)
        : null;

    // Walk back from today's balance: each day's closing balance is the next day's minus
    // that day's net. Only possible when every wallet's balance is known.
    const days = [...daily.keys()].sort((a, b) => a - b);
    let running = knownBalance;
    const closing = new Map<number, number | null>();
    for (let index = days.length - 1; index >= 0; index--) {
      const day = days[index]!;
      closing.set(day, running);
      if (running !== null) running -= daily.get(day)!;
    }

    const counterparty = db.prepare<[string], { address: string; satIn: number; satOut: number }>(
      `SELECT d.address, d.sat_in AS satIn, d.sat_out AS satOut
       FROM tx_deltas d
       WHERE d.txid = ? AND d.address NOT IN (SELECT address FROM foundation_set)`
    );

    const recent: FoundationMovement[] = external.slice(0, 20).map((tx) => {
      const others = counterparty.all(tx.txid);
      // Into the Foundation: the biggest funder. Out of it: the biggest recipient.
      const pick = [...others].sort((a, b) =>
        tx.net > 0
          ? b.satIn - b.satOut - (a.satIn - a.satOut)
          : b.satOut - b.satIn - (a.satOut - a.satIn)
      )[0];
      const label = pick ? labels.labelOf(pick.address, tx.time) : null;
      return {
        txid: tx.txid,
        height: tx.height,
        time: tx.time,
        amount: tx.net / SATS_PER_FLUX,
        counterparty: pick?.address ?? null,
        counterpartyName: label?.name ?? null,
        counterpartyKind: label?.kind ?? 'unknown',
        wallets: tx.wallets.split(',')
      };
    });

    return {
      wallets,
      totals: {
        balance: knownBalance === null ? null : knownBalance / SATS_PER_FLUX,
        inflow: inflow / SATS_PER_FLUX,
        outflow: outflow / SATS_PER_FLUX,
        net: (inflow - outflow) / SATS_PER_FLUX,
        internalTransfers,
        internalVolume: internalVolume / SATS_PER_FLUX
      },
      series: days.map((day) => ({
        time: day,
        net: daily.get(day)! / SATS_PER_FLUX,
        balance: closing.get(day) === null ? null : closing.get(day)! / SATS_PER_FLUX
      })),
      recent,
      balancesAsOf: balances?.at ?? null
    };
  })();
}
