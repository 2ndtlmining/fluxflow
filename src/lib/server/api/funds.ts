/**
 * Source of funds and destination of funds, N hops, for any wallet (#64).
 *
 * "What share of this wallet's money came from exchanges, the Foundation or node rewards?"
 * and "where did its money end up?" — the exposure view of tracing tools, computed from the
 * stored `flows` alone.
 *
 * The model is proportional exposure, the same rule /apps has used for "funded by" since
 * #61 (and /apps now calls this, so the two agree by construction):
 *
 *  - A labelled counterparty ends the trace: its share counts as its kind (and, for an
 *    exchange, its name).
 *  - An unlabelled one, among a wallet's largest {@link FUNDS_LIMITS.followed}, is followed
 *    one hop further, and its own mix is applied in proportion to what passed through it.
 *  - What is still unlabelled at the last hop, or was not followed, is `unknown`.
 *  - Backward, coinbase payouts to the wallet (`node_rewards`) are a source of their own.
 *  - Forward, a wallet that sent on less than it received kept the rest: `held`.
 *
 * It apportions by amount and ignores order and balances (FIFO is what the Foundation trace
 * does; per-request it would be far too slow for a hub wallet), and it only sees the stored
 * window. Every read goes through the `(to_address, height)` / `(from_address, height)`
 * indexes, and the number of wallets read is capped; when a cap stops it, `truncated` says so.
 */

import type { Db } from '../db/database.js';
import type { AddressKind } from '../ingest/datasource/types.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import type { LabelLookup } from '../labels.js';

export type Direction = 'in' | 'out';

/** Where money came from or went: a wallet kind, or (backward) coinbase, or (forward) kept. */
export type FundsKind = AddressKind | 'node_rewards' | 'held';

/** Amounts by kind. Satoshis inside this module, FLUX in what it returns. */
export type FundsMix = Partial<Record<FundsKind, number>>;

export const FUNDS_LIMITS = {
  /** Counterparties read per wallet, largest first. Anything beyond them is `unknown`. */
  counterparties: 25,
  /** Unlabelled counterparties followed one hop further, per wallet. */
  followed: 5,
  /** Hops a request may ask for. */
  maxHops: 4,
  /** Wallets read per trace; the step budget. */
  maxReads: 300,
  /** Labelled endpoints listed in a response. */
  endpoints: 15
} as const;

const flux = (sat: number) => Math.round(sat) / SATS_PER_FLUX;

/** One wallet's exposure, in satoshis. */
export interface Exposure {
  /** Everything it received (`in`) or sent (`out`). */
  readonly total: number;
  /** Sums to `total`. */
  readonly mix: FundsMix;
  readonly byExchange: ReadonlyMap<string, number>;
  /** Labelled wallets the money reached, keyed by address. */
  readonly endpoints: ReadonlyMap<string, { sat: number; hop: number }>;
  /** Its direct counterparties, largest first (up to {@link FUNDS_LIMITS.counterparties}). */
  readonly direct: readonly { address: string; sat: number }[];
}

/**
 * A memoised exposure tracer over the stored flows up to `toHeight`.
 *
 * Calls share the memo and the step budget, so tracing many wallets that share funders (the
 * /apps payers) reads each funder once. `truncated()` reports whether the budget ran out.
 */
export function fundsTracer(
  db: Db,
  labels: LabelLookup,
  direction: Direction,
  options: { maxHops: number; toHeight?: number; maxReads?: number }
) {
  const toHeight = options.toHeight ?? Number.MAX_SAFE_INTEGER;
  const maxReads = options.maxReads ?? FUNDS_LIMITS.maxReads;
  const self = direction === 'in' ? 'to_address' : 'from_address';
  const other = direction === 'in' ? 'from_address' : 'to_address';

  const parties = db.prepare<[string, string, number, number], { address: string; sat: number }>(
    `SELECT ${other} AS address, SUM(sat) AS sat FROM flows
     WHERE ${self} = ? AND ${other} <> ? AND height <= ?
     GROUP BY ${other} ORDER BY sat DESC, address LIMIT ?`
  );
  const totalOf = db.prepare<[string, string, number], { sat: number | null }>(
    `SELECT SUM(sat) AS sat FROM flows WHERE ${self} = ? AND ${other} <> ? AND height <= ?`
  );
  // Forward only: what reached the wallet, to tell what it kept from what it passed on.
  const receivedOf = db.prepare<[string, string, number], { sat: number | null }>(
    `SELECT SUM(sat) AS sat FROM flows WHERE to_address = ? AND from_address <> ? AND height <= ?`
  );
  const rewardsOf = db.prepare<[string, number], { sat: number | null }>(
    `SELECT SUM(sat) AS sat FROM node_rewards WHERE address = ? AND height <= ?`
  );

  const memo = new Map<string, Exposure>();
  let reads = 0;
  let truncated = false;

  const read = (address: string, depth: number): Exposure => {
    const key = `${depth}:${address}`;
    const cached = memo.get(key);
    if (cached) return cached;
    reads++;

    const rewards = direction === 'in' ? (rewardsOf.get(address, toHeight)?.sat ?? 0) : 0;
    const moved = totalOf.get(address, address, toHeight)?.sat ?? 0;
    const direct = parties.all(address, address, toHeight, FUNDS_LIMITS.counterparties);

    const mix: FundsMix = {};
    const byExchange = new Map<string, number>();
    const endpoints = new Map<string, { sat: number; hop: number }>();
    const add = (kind: FundsKind, sat: number) => {
      if (sat > 0) mix[kind] = (mix[kind] ?? 0) + sat;
    };
    const reach = (address: string, sat: number, hop: number) => {
      if (sat <= 0) return;
      const seen = endpoints.get(address);
      endpoints.set(address, { sat: (seen?.sat ?? 0) + sat, hop: Math.min(seen?.hop ?? hop, hop) });
    };

    let listed = 0;
    let followed = 0;
    for (const party of direct) {
      listed += party.sat;
      const kind = labels.kindOf(party.address);
      if (kind !== 'unknown') {
        add(kind, party.sat);
        if (kind === 'exchange') {
          const name = labels.nameOf(party.address) ?? 'Exchange';
          byExchange.set(name, (byExchange.get(name) ?? 0) + party.sat);
        }
        reach(party.address, party.sat, depth);
        continue;
      }
      if (depth >= options.maxHops || followed >= FUNDS_LIMITS.followed) {
        add('unknown', party.sat);
        continue;
      }
      if (reads >= maxReads && !memo.has(`${depth + 1}:${party.address}`)) {
        truncated = true;
        add('unknown', party.sat);
        continue;
      }
      followed++;
      const next = read(party.address, depth + 1);
      // Backward, a funder's mix is over what it received. Forward, over what reached it or
      // what it sent, whichever is larger: the rest of what reached it, it kept.
      const base =
        direction === 'in'
          ? next.total
          : Math.max(next.total, receivedOf.get(party.address, party.address, toHeight)?.sat ?? 0);
      if (base <= 0) {
        add('unknown', party.sat);
        continue;
      }
      const share = party.sat / base;
      for (const [kind, sat] of Object.entries(next.mix) as [FundsKind, number][]) {
        add(kind, sat * share);
      }
      add('held', (base - next.total) * share);
      for (const [name, sat] of next.byExchange) {
        byExchange.set(name, (byExchange.get(name) ?? 0) + sat * share);
      }
      for (const [end, value] of next.endpoints) reach(end, value.sat * share, value.hop);
    }
    add('unknown', moved - listed);
    add('node_rewards', rewards);

    const exposure: Exposure = { total: moved + rewards, mix, byExchange, endpoints, direct };
    memo.set(key, exposure);
    return exposure;
  };

  return {
    trace: (address: string) => read(address, 1),
    truncated: () => truncated
  };
}

export interface FundsEndpoint {
  readonly address: string;
  readonly kind: AddressKind;
  readonly name: string | null;
  readonly amount: number;
  /** The fewest hops at which the money reached it: 1 is a direct counterparty. */
  readonly hop: number;
}

export interface WalletFunds {
  readonly address: string;
  readonly direction: Direction;
  readonly hops: number;
  /** FLUX received (`in`, including node rewards) or sent (`out`) in the stored window. */
  readonly total: number;
  readonly byKind: FundsMix;
  readonly byExchange: Record<string, number>;
  /** The largest labelled wallets the money came from or reached. */
  readonly endpoints: FundsEndpoint[];
  /** FLUX that could not be attributed: `byKind.unknown`. */
  readonly untraced: number;
  /** The step budget ran out; what it stopped is in `untraced`. */
  readonly truncated: boolean;
}

/** Where a wallet's money came from (`in`) or went (`out`), up to `hops` wallets away. */
export function walletFunds(
  db: Db,
  labels: LabelLookup,
  address: string,
  direction: Direction,
  hops: number
): WalletFunds {
  const maxHops = Math.min(Math.max(1, Math.trunc(hops) || 1), FUNDS_LIMITS.maxHops);
  const tracer = fundsTracer(db, labels, direction, { maxHops });
  const exposure = tracer.trace(address);

  const byKind = toFlux(exposure.mix);
  return {
    address,
    direction,
    hops: maxHops,
    total: flux(exposure.total),
    byKind,
    byExchange: Object.fromEntries(
      [...exposure.byExchange].sort((a, b) => b[1] - a[1]).map(([name, sat]) => [name, flux(sat)])
    ),
    endpoints: [...exposure.endpoints]
      .sort((a, b) => b[1].sat - a[1].sat || a[0].localeCompare(b[0]))
      .slice(0, FUNDS_LIMITS.endpoints)
      .map(([end, value]) => ({
        address: end,
        kind: labels.kindOf(end),
        name: labels.nameOf(end),
        amount: flux(value.sat),
        hop: value.hop
      })),
    untraced: byKind.unknown ?? 0,
    truncated: tracer.truncated()
  };
}

export const toFlux = (mix: FundsMix): FundsMix =>
  Object.fromEntries(Object.entries(mix).map(([kind, sat]) => [kind, flux(sat)]));
