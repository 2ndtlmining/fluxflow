/**
 * Read queries.
 *
 * Every query here is bounded: no `SELECT *` over a whole table, no `OFFSET` pagination,
 * and no `json_extract` per row. Where a window function can replace a full scan, it does.
 *
 * Most of these are groundwork for the rollup tables (#4); until those exist they aggregate
 * directly, which is fine at the current row counts and is the shape the rollups will use.
 */

import type { Db } from '../db/database.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import { DATA_VERSION_KEY, ROLLUP_LEVELS } from '../db/migrations.js';

export interface PeriodWindow {
  readonly fromHeight: number;
  readonly toHeight: number;
  readonly fromTime: number;
  readonly toTime: number;
}

/**
 * Resolve a period to a block range.
 *
 * Filtering on `block_time` rather than counting back from the tip is what makes
 * "Today" actually mean today: block times are not guaranteed to stay at exactly 30
 * seconds, and a height-derived window silently drifts.
 */
export function resolvePeriod(db: Db, fromTime: number): PeriodWindow {
  // COALESCE matters: on an empty table MIN/MAX return a row of NULLs, not no row, so a
  // plain `??` fallback would never fire and `fromHeight` would be null.
  const bounds = db
    .prepare<[], { minHeight: number; minTime: number; maxHeight: number; maxTime: number }>(
      `SELECT COALESCE(MIN(height), 0) AS minHeight,
                COALESCE(MIN(time), 0)   AS minTime,
                COALESCE(MAX(height), 0) AS maxHeight,
                COALESCE(MAX(time), 0)   AS maxTime
         FROM blocks`
    )
    .get() ?? { minHeight: 0, minTime: 0, maxHeight: 0, maxTime: 0 };

  const fromHeight =
    db
      .prepare<[number], { height: number }>(
        `SELECT height FROM blocks WHERE time >= ? ORDER BY height ASC LIMIT 1`
      )
      .get(fromTime)?.height ?? bounds.minHeight;

  return {
    fromHeight,
    toHeight: bounds.maxHeight,
    fromTime,
    toTime: bounds.maxTime
  };
}

export interface FlowSummary {
  readonly totalSat: number;
  readonly count: number;
  readonly byKind: Record<string, number>;
  readonly byExchange: { name: string; totalSat: number; count: number }[];
}

/**
 * Totals for one direction (buying or selling) inside a window.
 *
 * Read from three pieces, so the cost is O(days in the period), not O(events) (#2, #4):
 *
 *   raw `flows`        the partial first hour, from the window's start to the next hour
 *   `rollup_hourly`    the rest of that first day
 *   `rollup_daily`     every day after it, through the newest block
 *
 * The end needs no special case: nothing after the newest block exists yet, so the last
 * day's bucket holds exactly the data up to it. A 6-month summary reads ~180 daily buckets
 * per combination instead of grouping millions of flows.
 *
 * Rollups outlive the raw retention window. When a period reaches back before the oldest
 * raw block, the partial first hour cannot be read exactly, so that boundary is rounded to
 * the nearest hour — at most 30 minutes out on a period of months.
 */
export function summariseFlow(
  db: Db,
  window: PeriodWindow,
  flowType: 'buying' | 'selling'
): FlowSummary {
  const HOUR = ROLLUP_LEVELS.rollup_hourly;
  const DAY = ROLLUP_LEVELS.rollup_daily;
  const hoursPerDay = DAY / HOUR;

  const firstHour = Math.floor(window.fromTime / HOUR);
  const firstDay = Math.floor(window.fromTime / DAY);
  const lastDay = Math.floor(window.toTime / DAY);

  const rawFrom =
    db.prepare<[], { time: number | null }>(`SELECT MIN(time) AS time FROM blocks`).get()?.time ??
    0;

  // Exact when raw data covers the window's start; otherwise round to the nearest hour.
  const exactEdge = window.fromTime >= rawFrom;
  const hourlyFrom = exactEdge || window.fromTime % HOUR >= HOUR / 2 ? firstHour + 1 : firstHour;
  const rawTo = exactEdge ? (firstHour + 1) * HOUR : window.fromTime; // empty when inexact
  const hourlyTo = (firstDay + 1) * hoursPerDay - 1;

  const counterpartyKind = flowType === 'buying' ? 'to_kind' : 'from_kind';

  const rows = db
    .prepare<
      [string, number, number, string, number, number, string, number, number],
      { kind: string; exchange: string; totalSat: number; count: number }
    >(
      `SELECT kind, exchange, SUM(sat) AS totalSat, SUM(count) AS count
       FROM (
         SELECT counterparty_kind AS kind, exchange, sat, count
         FROM rollup_daily
         WHERE flow_type = ? AND bucket BETWEEN ? AND ?
         UNION ALL
         SELECT counterparty_kind AS kind, exchange, sat, count
         FROM rollup_hourly
         WHERE flow_type = ? AND bucket BETWEEN ? AND ?
         UNION ALL
         SELECT ${counterpartyKind} AS kind, COALESCE(exchange, '') AS exchange, sat, 1 AS count
         FROM flows
         WHERE flow_type = ? AND time >= ? AND time < ?
       )
       GROUP BY kind, exchange`
    )
    .all(
      flowType,
      firstDay + 1,
      lastDay,
      flowType,
      hourlyFrom,
      hourlyTo,
      flowType,
      window.fromTime,
      rawTo
    );

  const byKind: Record<string, number> = {};
  const exchanges = new Map<string, { totalSat: number; count: number }>();
  let totalSat = 0;
  let count = 0;

  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + row.totalSat;
    totalSat += row.totalSat;
    count += row.count;

    if (row.exchange !== '') {
      const entry = exchanges.get(row.exchange) ?? { totalSat: 0, count: 0 };
      entry.totalSat += row.totalSat;
      entry.count += row.count;
      exchanges.set(row.exchange, entry);
    }
  }

  return {
    totalSat: totalSat / SATS_PER_FLUX,
    count,
    byKind: Object.fromEntries(
      Object.entries(byKind).map(([kind, sat]) => [kind, sat / SATS_PER_FLUX])
    ),
    byExchange: [...exchanges.entries()]
      .sort((a, b) => b[1].totalSat - a[1].totalSat)
      .slice(0, 25)
      .map(([name, entry]) => ({
        name,
        totalSat: entry.totalSat / SATS_PER_FLUX,
        count: entry.count
      }))
  };
}

export interface Counterparty {
  readonly address: string;
  readonly kind: string;
  readonly total: number;
  readonly count: number;
  readonly exchanges: string[];
}

/**
 * Top buyers (received from exchanges) or sellers (sent to exchanges).
 *
 * `GROUP BY address` in SQL with a `LIMIT`, rather than aggregating a whole period in JS.
 */
export function topCounterparties(
  db: Db,
  window: PeriodWindow,
  flowType: 'buying' | 'selling',
  limit: number
): Counterparty[] {
  const capped = Math.min(Math.max(1, limit), 100);

  const rows = db
    .prepare<
      [string, number, number, number],
      { address: string; kind: string; totalSat: number; count: number; exchanges: string }
    >(
      `SELECT
         CASE WHEN flow_type = 'buying' THEN to_address ELSE from_address END AS address,
         CASE WHEN flow_type = 'buying' THEN to_kind    ELSE from_kind    END AS kind,
         SUM(sat)  AS totalSat,
         COUNT(*)  AS count,
         GROUP_CONCAT(DISTINCT exchange) AS exchanges
       FROM flows
       WHERE flow_type = ? AND height BETWEEN ? AND ? AND exchange IS NOT NULL
       GROUP BY address, kind
       ORDER BY totalSat DESC
       LIMIT ?`
    )
    .all(flowType, window.fromHeight, window.toHeight, capped);

  return rows.map((row) => ({
    address: row.address,
    kind: row.kind,
    total: row.totalSat / SATS_PER_FLUX,
    count: row.count,
    exchanges: row.exchanges ? row.exchanges.split(',').filter(Boolean) : []
  }));
}

export interface FlowEvent {
  readonly txid: string;
  readonly vout: number;
  readonly height: number;
  readonly time: number;
  readonly fromAddress: string;
  readonly fromKind: string;
  readonly toAddress: string;
  readonly toKind: string;
  readonly exchange: string | null;
  readonly flowType: string;
  readonly amount: number;
}

/**
 * A page of flow events.
 *
 * Keyset pagination on `(height, txid, vout)` rather than `OFFSET`: `OFFSET n` makes
 * SQLite walk and discard n rows, so page 500 costs far more than page 1.
 */
export function listFlowEvents(
  db: Db,
  window: PeriodWindow,
  options: {
    flowType?: string;
    kind?: string;
    exchange?: string;
    minSat?: number;
    limit?: number;
    cursor?: { height: number; txid: string; vout: number };
  } = {}
): { events: FlowEvent[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(1, options.limit ?? 50), 500);

  const where: string[] = ['height BETWEEN ? AND ?'];
  const params: (string | number)[] = [window.fromHeight, window.toHeight];

  if (options.flowType) {
    where.push('flow_type = ?');
    params.push(options.flowType);
  }

  if (options.kind) {
    // Either side may be the counterparty depending on the direction, so match both.
    where.push('(to_kind = ? OR from_kind = ?)');
    params.push(options.kind, options.kind);
  }

  if (options.exchange) {
    where.push('exchange = ?');
    params.push(options.exchange);
  }

  if (options.minSat !== undefined) {
    where.push('sat >= ?');
    params.push(options.minSat * SATS_PER_FLUX);
  }

  if (options.cursor) {
    // Strictly "older than the cursor", which is what makes the walk stable while new
    // blocks are being written.
    where.push('(height < ? OR (height = ? AND (txid < ? OR (txid = ? AND vout < ?))))');
    params.push(
      options.cursor.height,
      options.cursor.height,
      options.cursor.txid,
      options.cursor.txid,
      options.cursor.vout
    );
  }

  params.push(limit + 1);

  const rows = db
    .prepare<unknown[], FlowEvent & { sat: number }>(
      `SELECT txid, vout, height, time, from_address AS fromAddress, from_kind AS fromKind,
              to_address AS toAddress, to_kind AS toKind, exchange, flow_type AS flowType, sat
       FROM flows
       WHERE ${where.join(' AND ')}
       ORDER BY height DESC, txid DESC, vout DESC
       LIMIT ?`
    )
    .all(...params);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
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
    nextCursor: hasMore && last ? `${last.height}:${last.txid}:${last.vout}` : null
  };
}

export interface DatabaseSummary {
  readonly blocks: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly minTime: number;
  readonly maxTime: number;
  readonly txDeltas: number;
  readonly flows: number;
  readonly missingBlocks: number;
  readonly dbSizeBytes: number;
}

/**
 * Cheap counts.
 *
 * v1's `getStats()` ran five full table scans and was called roughly five times per open
 * browser tab every five seconds — about 3.5 s of blocked event loop per 5 s, which
 * starved the sync loop (#3). These are the O(1) or index-only equivalents.
 */
export function summariseDatabase(db: Db): DatabaseSummary {
  const blocks = db
    .prepare<
      [],
      {
        count: number;
        minHeight: number | null;
        maxHeight: number | null;
        minTime: number | null;
        maxTime: number | null;
      }
    >(
      `SELECT COUNT(*) AS count, MIN(height) AS minHeight, MAX(height) AS maxHeight,
              MIN(time) AS minTime, MAX(time) AS maxTime
       FROM blocks`
    )
    .get()!;

  const flows = db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM flows`).get()!;
  const deltas = db
    .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM tx_deltas`)
    .get()!;
  const missing = db
    .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM missing_blocks`)
    .get()!;

  const size = db
    .prepare<[], { size: number }>(
      `SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()`
    )
    .get()!;

  return {
    blocks: blocks.count,
    minHeight: blocks.minHeight ?? 0,
    maxHeight: blocks.maxHeight ?? 0,
    minTime: blocks.minTime ?? 0,
    maxTime: blocks.maxTime ?? 0,
    txDeltas: deltas.count,
    flows: flows.count,
    missingBlocks: missing.count,
    dbSizeBytes: size?.size ?? 0
  };
}

/** Flow counts by classification level, for the "how much is still unknown" panel. */
export function summariseUnknowns(
  db: Db,
  window: PeriodWindow
): { unknownBuys: number; unknownSells: number; totalUnknowns: number } {
  const buys = db
    .prepare<[number, number], { count: number }>(
      `SELECT COUNT(*) AS count FROM flows
       WHERE flow_type = 'buying' AND to_kind = 'unknown' AND height BETWEEN ? AND ?`
    )
    .get(window.fromHeight, window.toHeight);

  const sells = db
    .prepare<[number, number], { count: number }>(
      `SELECT COUNT(*) AS count FROM flows
       WHERE flow_type = 'selling' AND from_kind = 'unknown' AND height BETWEEN ? AND ?`
    )
    .get(window.fromHeight, window.toHeight);

  const unknownBuys = buys?.count ?? 0;
  const unknownSells = sells?.count ?? 0;

  return { unknownBuys, unknownSells, totalUnknowns: unknownBuys + unknownSells };
}

/**
 * The stored data's version: bumped by trigger whenever a block is written or removed.
 *
 * A primary-key lookup, so every request can afford it. Anything derived from the chain is
 * unchanged while this is, which is what the response cache and ETags key on (#3, #4).
 */
export function dataVersion(db: Db): number {
  const row = db
    .prepare<[string], { value: string }>(`SELECT value FROM sync_state WHERE key = ?`)
    .get(DATA_VERSION_KEY);

  return row ? Number(row.value) : 0;
}
