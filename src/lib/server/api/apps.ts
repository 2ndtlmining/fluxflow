/**
 * Who a wallet deals with, and who pays for Flux apps.
 *
 * Both answer "where did this money come from?" — the question the exchange views leave
 * open, because most FLUX that matters moves wallet to wallet before it reaches an exchange
 * or an app.
 *
 * - {@link walletCounterparties}: a wallet's biggest senders and recipients, and the first
 *   wallet that funded it, within the stored window.
 * - {@link appPayments}: transfers into the `app_hosting` addresses (where Flux app hosting
 *   fees are paid) over a period, the wallets that paid them, and how those wallets were
 *   themselves funded, two hops up.
 *
 * Everything reads raw `flows` through the `to_address` / `from_address` indexes (both
 * `(address, height)`), so a period is a height range on one index and nothing scans the
 * whole table.
 */

import type { Db } from '../db/database.js';
import type { AddressKind } from '../ingest/datasource/types.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import type { LabelLookup } from '../labels.js';

const flux = (sat: number) => sat / SATS_PER_FLUX;

export interface Party {
  readonly address: string;
  readonly kind: AddressKind;
  readonly name: string | null;
  readonly total: number;
  readonly count: number;
  /** Fraction of everything this wallet received (incoming) or sent (outgoing). */
  readonly share: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
}

export interface CounterpartySide {
  readonly total: number;
  readonly count: number;
  /** Distinct counterparties on this side; `parties` lists the largest. */
  readonly distinct: number;
  readonly parties: Party[];
}

export interface WalletCounterparties {
  readonly address: string;
  readonly incoming: CounterpartySide;
  readonly outgoing: CounterpartySide;
  /** The earliest stored transfer into this wallet: the closest thing to "funded by". */
  readonly firstFunder: {
    readonly address: string;
    readonly kind: AddressKind;
    readonly name: string | null;
    readonly txid: string;
    readonly time: number;
    readonly amount: number;
  } | null;
  /** What this wallet paid in Flux app hosting fees. */
  readonly appPayments: { readonly total: number; readonly count: number };
}

type Column = 'from_address' | 'to_address';
const OTHER: Record<Column, Column> = { from_address: 'to_address', to_address: 'from_address' };

/** One side of a wallet's flows: `to_address = wallet` (incoming) or `from_address = wallet`. */
function side(
  db: Db,
  labels: LabelLookup,
  address: string,
  column: Column,
  limit: number
): CounterpartySide {
  const other = OTHER[column];
  const totals = db
    .prepare<[string], { sat: number | null; count: number; parties: number }>(
      `SELECT SUM(sat) AS sat, COUNT(*) AS count, COUNT(DISTINCT ${other}) AS parties
       FROM flows WHERE ${column} = ?`
    )
    .get(address) ?? { sat: 0, count: 0, parties: 0 };

  const rows = db
    .prepare<
      [string, number],
      { address: string; sat: number; count: number; first: number; last: number }
    >(
      `SELECT ${other} AS address, SUM(sat) AS sat, COUNT(*) AS count,
              MIN(time) AS first, MAX(time) AS last
       FROM flows WHERE ${column} = ?
       GROUP BY ${other}
       ORDER BY sat DESC, address
       LIMIT ?`
    )
    .all(address, limit);

  const total = totals.sat ?? 0;
  return {
    total: flux(total),
    count: totals.count,
    distinct: totals.parties,
    parties: rows.map((row) => ({
      address: row.address,
      kind: labels.kindOf(row.address),
      name: labels.nameOf(row.address),
      total: flux(row.sat),
      count: row.count,
      share: total > 0 ? row.sat / total : 0,
      firstSeen: row.first,
      lastSeen: row.last
    }))
  };
}

/**
 * A wallet's largest senders and recipients over the stored window.
 *
 * Totals are what flows record: each sender's proportional share of a transfer (see
 * `splitByFunder`), so a counterparty's figures add up to the wallet's own.
 */
export function walletCounterparties(
  db: Db,
  labels: LabelLookup,
  address: string,
  options: { limit?: number } = {}
): WalletCounterparties {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 15) || 1), 100);

  const first = db
    .prepare<[string], { address: string; txid: string; time: number; sat: number }>(
      `SELECT from_address AS address, txid, time, sat FROM flows
       WHERE to_address = ?
       ORDER BY height ASC, sat DESC
       LIMIT 1`
    )
    .get(address);

  // By address, not the stored `to_kind`: that only follows a new label once the relabel
  // worker has re-derived the flows, and a wallet page must not read zero until then.
  const hosting = labels.addressesOf('app_hosting');
  const apps =
    hosting.length === 0
      ? null
      : db
          .prepare<string[], { sat: number | null; count: number }>(
            `SELECT SUM(sat) AS sat, COUNT(*) AS count FROM flows
             WHERE from_address = ? AND to_address IN (${hosting.map(() => '?').join(', ')})`
          )
          .get(address, ...hosting);

  return {
    address,
    incoming: side(db, labels, address, 'to_address', limit),
    outgoing: side(db, labels, address, 'from_address', limit),
    firstFunder: first
      ? {
          address: first.address,
          kind: labels.kindOf(first.address),
          name: labels.nameOf(first.address),
          txid: first.txid,
          time: first.time,
          amount: flux(first.sat)
        }
      : null,
    appPayments: { total: flux(apps?.sat ?? 0), count: apps?.count ?? 0 }
  };
}

// ── App payments ──────────────────────────────────────────────────────────────

/** A period as stored heights, inclusive. */
export interface HeightWindow {
  readonly fromHeight: number;
  readonly toHeight: number;
}

/** Where a wallet's money came from, by the kind that sent it, in FLUX. */
export type SourceMix = Partial<Record<AddressKind, number>>;

export interface AppPayer {
  readonly address: string;
  readonly kind: AddressKind;
  readonly name: string | null;
  readonly total: number;
  readonly count: number;
  readonly share: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  /**
   * Everything this wallet received in the stored window up to the period's end, by the kind
   * of wallet it came from. An unlabelled sender is followed one hop further and its own mix
   * applied in proportion; what is still unlabelled after that stays `unknown`.
   */
  readonly fundedBy: { readonly received: number; readonly mix: SourceMix };
  /** Its largest direct senders, for following the trail by hand. */
  readonly topFunders: { address: string; kind: AddressKind; name: string | null; total: number }[];
}

export interface AppPayments {
  /** The `app_hosting` addresses the payments were counted into. */
  readonly hosting: { address: string; name: string | null }[];
  readonly total: number;
  readonly count: number;
  readonly payers: number;
  /** Payments by the kind of wallet that paid them. */
  readonly byPayerKind: SourceMix;
  /** Daily totals: day start (unix seconds) and FLUX. */
  readonly series: { time: number; total: number; count: number }[];
  readonly topPayers: AppPayer[];
  /**
   * The top payers' funding mixes, weighted by what each paid for apps: of the FLUX those
   * wallets spent on apps, how much traces back to each kind. Fractions summing to 1.
   */
  readonly fundingOfPayments: SourceMix;
  /** Where the hosting addresses sent their money in the period. */
  readonly outflows: { total: number; recipients: Party[] };
}

/** Limits for the funding trace; it runs per request, so it is kept small. */
export const SOURCE_LIMITS = {
  /** Direct senders read per wallet. Anything beyond them counts as `unknown`. */
  funders: 25,
  /** Unlabelled senders followed one hop further, per wallet. */
  followed: 5
} as const;

const DAY = 86_400;

/**
 * App hosting fees paid in a window, who paid them and how those payers were funded.
 *
 * "Funded by" is an approximation and is labelled as one in the UI: it apportions a wallet's
 * inflows by amount, ignoring order and balances, and only sees the stored window. It is
 * what makes a pattern like "most app fees are paid from Foundation money" visible at all.
 */
export function appPayments(
  db: Db,
  labels: LabelLookup,
  window: HeightWindow,
  options: { limit?: number } = {}
): AppPayments {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 20) || 1), 100);
  const hosting = labels.addressesOf('app_hosting').sort();

  const empty: AppPayments = {
    hosting: hosting.map((address) => ({ address, name: labels.nameOf(address) })),
    total: 0,
    count: 0,
    payers: 0,
    byPayerKind: {},
    series: [],
    topPayers: [],
    fundingOfPayments: {},
    outflows: { total: 0, recipients: [] }
  };
  if (hosting.length === 0) return empty;

  const marks = hosting.map(() => '?').join(', ');
  // A hosting address paying another (a sweep between them) is not an app payment.
  const where = `to_address IN (${marks}) AND from_address NOT IN (${marks})
                 AND height >= ? AND height <= ?`;
  const params = [...hosting, ...hosting, window.fromHeight, window.toHeight];

  const totals = db
    .prepare<(string | number)[], { sat: number | null; count: number; payers: number }>(
      `SELECT SUM(sat) AS sat, COUNT(*) AS count, COUNT(DISTINCT from_address) AS payers
       FROM flows WHERE ${where}`
    )
    .get(...params);

  if (!totals || totals.count === 0) return { ...empty, outflows: outflows() };

  const byPayerKind: SourceMix = {};
  for (const row of db
    .prepare<(string | number)[], { kind: AddressKind; sat: number }>(
      `SELECT from_kind AS kind, SUM(sat) AS sat FROM flows WHERE ${where} GROUP BY from_kind`
    )
    .all(...params)) {
    byPayerKind[row.kind] = flux(row.sat);
  }

  const series = db
    .prepare<(string | number)[], { day: number; sat: number; count: number }>(
      `SELECT time / ${DAY} AS day, SUM(sat) AS sat, COUNT(*) AS count
       FROM flows WHERE ${where} GROUP BY day ORDER BY day`
    )
    .all(...params)
    .map((row) => ({ time: row.day * DAY, total: flux(row.sat), count: row.count }));

  const payerRows = db
    .prepare<
      (string | number)[],
      { address: string; sat: number; count: number; first: number; last: number }
    >(
      `SELECT from_address AS address, SUM(sat) AS sat, COUNT(*) AS count,
              MIN(time) AS first, MAX(time) AS last
       FROM flows WHERE ${where}
       GROUP BY from_address
       ORDER BY sat DESC, address
       LIMIT ?`
    )
    .all(...params, limit);

  const trace = sourceTracer(db, labels, window.toHeight);
  const total = totals.sat ?? 0;
  const weighted: SourceMix = {};
  let weightedTotal = 0;

  const topPayers = payerRows.map((row): AppPayer => {
    const source = trace(row.address);
    if (source.received > 0) {
      for (const [kind, amount] of Object.entries(source.mix) as [AddressKind, number][]) {
        weighted[kind] = (weighted[kind] ?? 0) + (row.sat * amount) / source.received;
      }
      weightedTotal += row.sat;
    }
    return {
      address: row.address,
      kind: labels.kindOf(row.address),
      name: labels.nameOf(row.address),
      total: flux(row.sat),
      count: row.count,
      share: total > 0 ? row.sat / total : 0,
      firstSeen: row.first,
      lastSeen: row.last,
      fundedBy: { received: flux(source.received), mix: toFlux(source.mix) },
      topFunders: source.funders.slice(0, 3).map((funder) => ({
        address: funder.address,
        kind: labels.kindOf(funder.address),
        name: labels.nameOf(funder.address),
        total: flux(funder.sat)
      }))
    };
  });

  return {
    ...empty,
    total: flux(total),
    count: totals.count,
    payers: totals.payers,
    byPayerKind,
    series,
    topPayers,
    fundingOfPayments: Object.fromEntries(
      Object.entries(weighted).map(([kind, sat]) => [
        kind,
        weightedTotal > 0 ? sat / weightedTotal : 0
      ])
    ),
    outflows: outflows()
  };

  function outflows(): AppPayments['outflows'] {
    const out = `from_address IN (${marks}) AND to_address NOT IN (${marks})
                 AND height >= ? AND height <= ?`;
    const sum =
      db
        .prepare<(string | number)[], { sat: number | null }>(
          `SELECT SUM(sat) AS sat FROM flows WHERE ${out}`
        )
        .get(...params)?.sat ?? 0;

    const rows = db
      .prepare<
        (string | number)[],
        { address: string; sat: number; count: number; first: number; last: number }
      >(
        `SELECT to_address AS address, SUM(sat) AS sat, COUNT(*) AS count,
                MIN(time) AS first, MAX(time) AS last
         FROM flows WHERE ${out}
         GROUP BY to_address ORDER BY sat DESC, address LIMIT 10`
      )
      .all(...params);

    return {
      total: flux(sum),
      recipients: rows.map((row) => ({
        address: row.address,
        kind: labels.kindOf(row.address),
        name: labels.nameOf(row.address),
        total: flux(row.sat),
        count: row.count,
        share: sum > 0 ? row.sat / sum : 0,
        firstSeen: row.first,
        lastSeen: row.last
      }))
    };
  }
}

const toFlux = (mix: SourceMix): SourceMix =>
  Object.fromEntries(Object.entries(mix).map(([kind, sat]) => [kind, flux(sat)]));

interface Source {
  /** Satoshis received, all senders. */
  readonly received: number;
  /** Satoshis by source kind; sums to `received`. */
  readonly mix: SourceMix;
  readonly funders: { address: string; sat: number }[];
}

/**
 * A memoised two-hop funding trace up to `toHeight`.
 *
 * A labelled sender's share counts as its kind. An unlabelled one (among the largest
 * {@link SOURCE_LIMITS.followed}) has its own one-hop mix applied in proportion; the rest,
 * and senders beyond {@link SOURCE_LIMITS.funders}, count as `unknown`.
 */
function sourceTracer(db: Db, labels: LabelLookup, toHeight: number) {
  const senders = db.prepare<[string, string, number, number], { address: string; sat: number }>(
    `SELECT from_address AS address, SUM(sat) AS sat FROM flows
     WHERE to_address = ? AND from_address <> ? AND height <= ?
     GROUP BY from_address ORDER BY sat DESC, address LIMIT ?`
  );
  const received = db.prepare<[string, string, number], { sat: number | null }>(
    `SELECT SUM(sat) AS sat FROM flows WHERE to_address = ? AND from_address <> ? AND height <= ?`
  );

  const memo = new Map<string, Source>();

  const read = (address: string, depth: number): Source => {
    const key = `${depth}:${address}`;
    const cached = memo.get(key);
    if (cached) return cached;

    const total = received.get(address, address, toHeight)?.sat ?? 0;
    const funders = senders.all(address, address, toHeight, SOURCE_LIMITS.funders);
    const mix: SourceMix = {};
    const add = (kind: AddressKind, sat: number) => {
      if (sat > 0) mix[kind] = (mix[kind] ?? 0) + sat;
    };

    let listed = 0;
    let followed = 0;
    for (const funder of funders) {
      listed += funder.sat;
      const kind = labels.kindOf(funder.address);
      if (kind !== 'unknown') {
        add(kind, funder.sat);
        continue;
      }
      if (depth >= 2 || followed >= SOURCE_LIMITS.followed) {
        add('unknown', funder.sat);
        continue;
      }
      followed++;
      const upstream = read(funder.address, depth + 1);
      if (upstream.received <= 0) {
        add('unknown', funder.sat);
        continue;
      }
      for (const [upKind, sat] of Object.entries(upstream.mix) as [AddressKind, number][]) {
        add(upKind, (funder.sat * sat) / upstream.received);
      }
    }
    add('unknown', total - listed);

    const source = { received: total, mix, funders };
    memo.set(key, source);
    return source;
  };

  return (address: string) => read(address, 1);
}
