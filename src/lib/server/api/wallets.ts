/**
 * Wallet-level reads: leaderboards (#28), wallet profiles and search (#30).
 *
 * Everything here is served from the per-wallet rollups of migration 3 (`wallet_daily`,
 * `wallet_monthly`), with raw `flows` only for the partial day at a window's edges, and
 * the `from_address` / `to_address` indexes for one wallet's own rows. Nothing groups the
 * whole flows table.
 */

import type { Db } from '../db/database.js';
import { WALLET_LEVELS } from '../db/migrations.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import { decompose } from './ranges.js';
import {
  previousRange,
  rawCoverageFrom,
  summariseFlowRange,
  unionOver,
  type FlowEvent,
  type TimeRange
} from './queries.js';

type Direction = 'buying' | 'selling';

/** The wallet side of a flow, as SQL over raw `flows`: who withdrew, or who deposited. */
const ADDRESS = `CASE flow_type WHEN 'buying' THEN to_address ELSE from_address END`;
const KIND = `CASE flow_type WHEN 'buying' THEN to_kind ELSE from_kind END`;

/** Counterparty kinds a leaderboard may be filtered by. */
export const LEADERBOARD_KINDS = ['unknown', 'node_operator', 'foundation'] as const;
export type LeaderboardKind = (typeof LEADERBOARD_KINDS)[number];

/**
 * A FLUX transparent address: `t1` (P2PKH) or `t3` (P2SH), base58, 35 characters.
 *
 * Checked before any address reaches a query, so a malformed or hostile value is a 400, not
 * a scan (#21).
 */
export const ADDRESS_PATTERN = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;

export interface ExchangeShare {
  readonly name: string;
  readonly total: number;
  readonly count: number;
}

export interface Leader {
  readonly rank: number;
  readonly address: string;
  readonly kind: string;
  readonly total: number;
  readonly count: number;
  /** Fraction of the period's whole volume in this direction. */
  readonly share: number;
  readonly exchanges: ExchangeShare[];
  /** Unix seconds of this wallet's most recent stored flow, if raw data still has one. */
  readonly lastSeen: number | null;
  /** The same wallet, same direction, over the equally long window before this one. */
  readonly previousTotal: number;
  readonly change: number;
}

export interface Leaderboard {
  readonly flowType: Direction;
  readonly total: number;
  readonly leaders: Leader[];
}

/**
 * Top wallets by volume in one direction over a window.
 *
 * The ranking reads `wallet_monthly` for whole 30-day buckets, `wallet_daily` towards the
 * edges and raw flows for the partial day at each end — exact, at a cost of distinct
 * wallets per bucket rather than flows. Breakdowns and previous-period totals are then read
 * for the leaders only, through the address index.
 */
export function leaderboard(
  db: Db,
  range: TimeRange,
  flowType: Direction,
  options: { limit?: number; kind?: LeaderboardKind } = {}
): Leaderboard {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 10) || 1), 100);
  const rawFrom = rawCoverageFrom(db);

  const kindFilter = options.kind
    ? {
        rollupWhere: { sql: 'AND kind = ?', params: [options.kind] },
        rawWhere: { sql: `AND ${KIND} = ?`, params: [options.kind] }
      }
    : {};

  const union = unionOver(
    decompose(range.fromTime, range.toTime, {
      levels: [WALLET_LEVELS.wallet_daily, WALLET_LEVELS.wallet_monthly],
      rawFrom,
      open: range.open
    }),
    flowType,
    {
      tables: ['wallet_daily', 'wallet_monthly'],
      rollupColumns: 'address, kind, sat, count',
      rawColumns: `${ADDRESS} AS address, ${KIND} AS kind, sat, 1 AS count`,
      ...kindFilter
    }
  );

  const top = union.sql
    ? db
        .prepare<
          (string | number)[],
          { address: string; kind: string; sat: number; count: number }
        >(
          `SELECT address, kind, SUM(sat) AS sat, SUM(count) AS count
           FROM (${union.sql})
           GROUP BY address, kind
           ORDER BY sat DESC, address
           LIMIT ?`
        )
        .all(...union.params, limit)
    : [];

  const total = summariseFlowRange(db, range, flowType).totalSat;
  const addresses = top.map((row) => row.address);
  const current = walletBreakdown(db, addresses, range, flowType, rawFrom);
  const previous = walletBreakdown(db, addresses, previousRange(range), flowType, rawFrom);

  return {
    flowType,
    total,
    leaders: top.map((row, index) => {
      const sat = row.sat / SATS_PER_FLUX;
      const previousTotal = (previous.get(row.address) ?? []).reduce(
        (sum, entry) => sum + entry.total,
        0
      );

      return {
        rank: index + 1,
        address: row.address,
        kind: row.kind,
        total: sat,
        count: row.count,
        share: total > 0 ? sat / total : 0,
        exchanges: current.get(row.address) ?? [],
        lastSeen: lastSeen(db, row.address),
        previousTotal,
        change: sat - previousTotal
      };
    })
  };
}

/**
 * Per-exchange totals for a set of wallets over a window.
 *
 * Whole days from `wallet_daily` through its address index, raw flows for partial days.
 * `wallet_monthly` has no exchange column, so it cannot serve this; it is not needed either,
 * since the address index keeps this to the leaders' own rows.
 */
function walletBreakdown(
  db: Db,
  addresses: readonly string[],
  range: TimeRange,
  flowType: Direction,
  rawFrom: number
): Map<string, ExchangeShare[]> {
  const result = new Map<string, ExchangeShare[]>();
  if (addresses.length === 0 || range.toTime <= range.fromTime) return result;

  const marks = addresses.map(() => '?').join(', ');
  const union = unionOver(
    decompose(range.fromTime, range.toTime, {
      levels: [WALLET_LEVELS.wallet_daily],
      rawFrom,
      open: range.open
    }),
    flowType,
    {
      tables: ['wallet_daily'],
      rollupColumns: 'address, exchange, sat, count',
      rawColumns: `${ADDRESS} AS address, COALESCE(exchange, '') AS exchange, sat, 1 AS count`,
      rollupWhere: { sql: `AND address IN (${marks})`, params: addresses },
      rawWhere: { sql: `AND ${ADDRESS} IN (${marks})`, params: addresses }
    }
  );

  if (!union.sql) return result;

  const rows = db
    .prepare<
      (string | number)[],
      { address: string; exchange: string; sat: number; count: number }
    >(
      `SELECT address, exchange, SUM(sat) AS sat, SUM(count) AS count
       FROM (${union.sql})
       GROUP BY address, exchange
       ORDER BY sat DESC`
    )
    .all(...union.params);

  for (const row of rows) {
    const list = result.get(row.address) ?? [];
    list.push({ name: row.exchange, total: row.sat / SATS_PER_FLUX, count: row.count });
    result.set(row.address, list);
  }

  return result;
}

/** The time of a wallet's newest stored flow, either side, through the address indexes. */
function lastSeen(db: Db, address: string): number | null {
  const row = db
    .prepare<[string, string], { time: number | null }>(
      `SELECT MAX(time) AS time FROM (
         SELECT * FROM (SELECT time FROM flows WHERE from_address = ? ORDER BY height DESC LIMIT 1)
         UNION ALL
         SELECT * FROM (SELECT time FROM flows WHERE to_address = ? ORDER BY height DESC LIMIT 1)
       )`
    )
    .get(address, address);

  return row?.time ?? null;
}

// ── Wallet profile ────────────────────────────────────────────────────────────

export interface WalletProfile {
  readonly address: string;
  /** Every label recorded for the address, from every source. */
  readonly labels: { kind: string; name: string | null; source: string; confidence: number }[];
  readonly totals: {
    readonly bought: number;
    readonly sold: number;
    readonly net: number;
    readonly boughtCount: number;
    readonly soldCount: number;
    /** Wallet-to-wallet flows in and out, within the raw retention window. */
    readonly p2pIn: number;
    readonly p2pOut: number;
  };
  readonly byExchange: { name: string; bought: number; sold: number; count: number }[];
  readonly firstSeen: number | null;
  readonly lastSeen: number | null;
  /** Daily bought/sold (day start, unix seconds) over the `seriesDays` before the last activity. */
  readonly series: { time: number; bought: number; sold: number }[];
}

/**
 * Everything the wallet page needs except its transaction list.
 *
 * Exchange totals are all-time (rollups outlive retention); p2p totals come from raw rows
 * and so cover only the retention window.
 */
export function walletProfile(
  db: Db,
  address: string,
  options: { seriesDays?: number } = {}
): WalletProfile | null {
  const exchangeRows = db
    .prepare<
      [string],
      {
        flowType: Direction;
        exchange: string;
        sat: number;
        count: number;
        firstDay: number;
        lastDay: number;
      }
    >(
      `SELECT flow_type AS flowType, exchange, SUM(sat) AS sat, SUM(count) AS count,
              MIN(bucket) AS firstDay, MAX(bucket) AS lastDay
       FROM wallet_daily
       WHERE address = ?
       GROUP BY flow_type, exchange`
    )
    .all(address);

  const p2p = db
    .prepare<[string, string], { incoming: number | null; outgoing: number | null }>(
      `SELECT
         (SELECT SUM(sat) FROM flows WHERE to_address = ? AND flow_type = 'p2p') AS incoming,
         (SELECT SUM(sat) FROM flows WHERE from_address = ? AND flow_type = 'p2p') AS outgoing`
    )
    .get(address, address);

  const seen = db
    .prepare<[string, string, string, string], { first: number | null; last: number | null }>(
      `SELECT MIN(time) AS first, MAX(time) AS last FROM (
         SELECT * FROM (SELECT time FROM flows WHERE from_address = ? ORDER BY height ASC LIMIT 1)
         UNION ALL
         SELECT * FROM (SELECT time FROM flows WHERE to_address = ? ORDER BY height ASC LIMIT 1)
         UNION ALL
         SELECT * FROM (SELECT time FROM flows WHERE from_address = ? ORDER BY height DESC LIMIT 1)
         UNION ALL
         SELECT * FROM (SELECT time FROM flows WHERE to_address = ? ORDER BY height DESC LIMIT 1)
       )`
    )
    .get(address, address, address, address);

  const labels = db
    .prepare<[string], { kind: string; name: string | null; source: string; confidence: number }>(
      `SELECT kind, name, source, confidence FROM address_labels
       WHERE address = ? ORDER BY confidence DESC`
    )
    .all(address);

  if (exchangeRows.length === 0 && seen?.first == null && labels.length === 0) return null;

  const exchanges = new Map<string, { bought: number; sold: number; count: number }>();
  let boughtSat = 0;
  let soldSat = 0;
  let boughtCount = 0;
  let soldCount = 0;
  let firstDay: number | null = null;
  let lastDay: number | null = null;

  for (const row of exchangeRows) {
    const entry = exchanges.get(row.exchange) ?? { bought: 0, sold: 0, count: 0 };
    if (row.flowType === 'buying') {
      entry.bought += row.sat;
      boughtSat += row.sat;
      boughtCount += row.count;
    } else {
      entry.sold += row.sat;
      soldSat += row.sat;
      soldCount += row.count;
    }
    entry.count += row.count;
    exchanges.set(row.exchange, entry);
    firstDay = firstDay === null ? row.firstDay : Math.min(firstDay, row.firstDay);
    lastDay = lastDay === null ? row.lastDay : Math.max(lastDay, row.lastDay);
  }

  const day = WALLET_LEVELS.wallet_daily;
  const seriesDays = Math.min(Math.max(1, options.seriesDays ?? 180), 3_650);
  const seriesFrom = (lastDay ?? 0) - seriesDays + 1;

  const seriesRows = db
    .prepare<[string, number], { day: number; flowType: Direction; sat: number }>(
      `SELECT bucket AS day, flow_type AS flowType, SUM(sat) AS sat
       FROM wallet_daily
       WHERE address = ? AND bucket >= ?
       GROUP BY bucket, flow_type
       ORDER BY bucket`
    )
    .all(address, seriesFrom);

  const series = new Map<number, { time: number; bought: number; sold: number }>();
  for (const row of seriesRows) {
    const entry = series.get(row.day) ?? { time: row.day * day, bought: 0, sold: 0 };
    if (row.flowType === 'buying') entry.bought += row.sat / SATS_PER_FLUX;
    else entry.sold += row.sat / SATS_PER_FLUX;
    series.set(row.day, entry);
  }

  // Rollups remember days raw data has forgotten; take whichever reaches further.
  const firstSeen = minDefined(seen?.first ?? null, firstDay === null ? null : firstDay * day);
  const lastSeenAt = maxDefined(seen?.last ?? null, lastDay === null ? null : lastDay * day);

  return {
    address,
    labels,
    totals: {
      bought: boughtSat / SATS_PER_FLUX,
      sold: soldSat / SATS_PER_FLUX,
      net: (boughtSat - soldSat) / SATS_PER_FLUX,
      boughtCount,
      soldCount,
      p2pIn: (p2p?.incoming ?? 0) / SATS_PER_FLUX,
      p2pOut: (p2p?.outgoing ?? 0) / SATS_PER_FLUX
    },
    byExchange: [...exchanges.entries()]
      .map(([name, entry]) => ({
        name,
        bought: entry.bought / SATS_PER_FLUX,
        sold: entry.sold / SATS_PER_FLUX,
        count: entry.count
      }))
      .sort((a, b) => b.bought + b.sold - (a.bought + a.sold)),
    firstSeen,
    lastSeen: lastSeenAt,
    series: [...series.values()]
  };
}

const minDefined = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.min(a, b);
const maxDefined = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);

// ── Wallet events ─────────────────────────────────────────────────────────────

export interface Cursor {
  readonly height: number;
  readonly txid: string;
  readonly vout: number;
}

/**
 * A wallet's flows, newest first, keyset-paginated on `(height, txid, vout)`.
 *
 * Read as two index walks — one on `from_address`, one on `to_address` — merged here. An
 * `OR` across both columns would defeat both indexes.
 */
export function walletEvents(
  db: Db,
  address: string,
  options: { limit?: number; cursor?: Cursor; flowType?: string } = {}
): { events: FlowEvent[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 50) || 1), 200);

  const side = (column: 'from_address' | 'to_address') => {
    const where = [`${column} = ?`];
    const params: (string | number)[] = [address];

    if (options.flowType) {
      where.push('flow_type = ?');
      params.push(options.flowType);
    }
    if (options.cursor) {
      where.push('(height < ? OR (height = ? AND (txid < ? OR (txid = ? AND vout < ?))))');
      params.push(
        options.cursor.height,
        options.cursor.height,
        options.cursor.txid,
        options.cursor.txid,
        options.cursor.vout
      );
    }

    return db
      .prepare<(string | number)[], FlowEvent & { sat: number }>(
        `SELECT txid, vout, height, time, from_address AS fromAddress, from_kind AS fromKind,
                to_address AS toAddress, to_kind AS toKind, exchange, flow_type AS flowType, sat
         FROM flows
         WHERE ${where.join(' AND ')}
         ORDER BY height DESC, txid DESC, vout DESC
         LIMIT ?`
      )
      .all(...params, limit + 1);
  };

  const merged = [...side('from_address'), ...side('to_address')].sort(
    (a, b) => b.height - a.height || (a.txid < b.txid ? 1 : a.txid > b.txid ? -1 : b.vout - a.vout)
  );

  // The same row can only appear once: a flow never has the same address on both sides.
  const page = merged.slice(0, limit);
  const last = page.at(-1);

  return {
    events: page.map((row) => ({
      txid: row.txid,
      vout: row.vout,
      height: row.height,
      time: row.time,
      fromAddress: row.fromAddress,
      fromKind: row.fromKind,
      toAddress: row.toAddress,
      toKind: row.toKind,
      exchange: row.exchange,
      flowType: row.flowType,
      amount: row.sat / SATS_PER_FLUX
    })),
    nextCursor: merged.length > limit && last ? `${last.height}:${last.txid}:${last.vout}` : null
  };
}

// ── Search ────────────────────────────────────────────────────────────────────

export type SearchResult =
  | { readonly type: 'wallet'; readonly address: string; readonly name: string | null }
  | { readonly type: 'tx'; readonly txid: string; readonly height: number };

/** Every base58 character sorts below `{`, so `[q, q + '{')` is exactly "starts with q". */
const PREFIX_END = '{';

/**
 * Find wallets by address prefix or label name, or a transaction by txid.
 *
 * Address prefixes are range scans on primary keys and indexes; names are a `LIKE` over the
 * small `address_labels` table. Both are capped.
 */
export function search(db: Db, rawQuery: string, limit = 10): SearchResult[] {
  const q = rawQuery.trim();
  const capped = Math.min(Math.max(1, limit), 25);

  if (/^[0-9a-f]{64}$/i.test(q)) {
    const tx = db
      .prepare<[string], { txid: string; height: number }>(
        `SELECT txid, height FROM flows WHERE txid = ? LIMIT 1`
      )
      .get(q.toLowerCase());
    return tx ? [{ type: 'tx', txid: tx.txid, height: tx.height }] : [];
  }

  const results = new Map<string, SearchResult>();
  const add = (address: string, name: string | null) => {
    if (results.size < capped && !results.has(address)) {
      results.set(address, { type: 'wallet', address, name });
    }
  };

  if (/^t[13][1-9A-HJ-NP-Za-km-z]{1,33}$/.test(q)) {
    const upper = q + PREFIX_END;

    for (const row of db
      .prepare<[string, string, number], { address: string; name: string | null }>(
        `SELECT address, MAX(name) AS name FROM address_labels
         WHERE address >= ? AND address < ? GROUP BY address LIMIT ?`
      )
      .all(q, upper, capped)) {
      add(row.address, row.name);
    }

    for (const row of db
      .prepare<[string, string, number], { address: string }>(
        `SELECT DISTINCT address FROM wallet_daily
         WHERE address >= ? AND address < ? LIMIT ?`
      )
      .all(q, upper, capped)) {
      add(row.address, null);
    }

    for (const column of ['to_address', 'from_address'] as const) {
      for (const row of db
        .prepare<[string, string, number], { address: string }>(
          `SELECT DISTINCT ${column} AS address FROM flows
           WHERE ${column} >= ? AND ${column} < ? LIMIT ?`
        )
        .all(q, upper, capped)) {
        add(row.address, null);
      }
    }

    return [...results.values()];
  }

  if (q.length >= 2) {
    const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    for (const row of db
      .prepare<[string, number], { address: string; name: string | null }>(
        `SELECT address, MAX(name) AS name FROM address_labels
         WHERE name LIKE ? ESCAPE '\\'
         GROUP BY address
         ORDER BY MAX(confidence) DESC
         LIMIT ?`
      )
      .all(pattern, capped)) {
      add(row.address, row.name);
    }
  }

  return [...results.values()];
}
