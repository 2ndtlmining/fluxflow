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
import { decompose, type RangePiece } from './ranges.js';

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

/** A window in seconds, `[fromTime, toTime)`. Open windows end at the newest stored data. */
export interface TimeRange {
  readonly fromTime: number;
  readonly toTime: number;
  readonly open: boolean;
}

/** The oldest stored block time: raw rows exist from here on (rollups may go further back). */
export function rawCoverageFrom(db: Db): number {
  return (
    db.prepare<[], { time: number | null }>(`SELECT MIN(time) AS time FROM blocks`).get()?.time ?? 0
  );
}

/** The open range a period window describes: from its start to the newest block, inclusive. */
export function openRange(window: PeriodWindow): TimeRange {
  return { fromTime: window.fromTime, toTime: window.toTime + 1, open: true };
}

/** The equally long window immediately before `range`, for "vs previous period" deltas. */
export function previousRange(range: TimeRange): TimeRange {
  const length = range.toTime - range.fromTime;
  return { fromTime: range.fromTime - length, toTime: range.fromTime, open: false };
}

export interface UnionSource {
  /** One table per decomposition level, finest first. */
  readonly tables: readonly string[];
  /**
   * An index to force on each table (`INDEXED BY`), parallel to `tables`. For a narrow
   * `rollupWhere` such as a few addresses: SQLite otherwise prefers the primary key's bucket
   * range and reads every row of the window to keep a handful.
   */
  readonly indexes?: readonly (string | undefined)[];
  /** Columns selected from a rollup table. */
  readonly rollupColumns: string;
  /** The same columns, from raw `flows`. */
  readonly rawColumns: string;
  /** Extra `AND …` conditions, with their parameters. */
  readonly rollupWhere?: { sql: string; params: readonly (string | number)[] };
  readonly rawWhere?: { sql: string; params: readonly (string | number)[] };
}

/**
 * Build one `UNION ALL` over the pieces of a decomposed window.
 *
 * Every piece filters on `flow_type`; rollup pieces on a bucket range of their level's table,
 * raw pieces on `time` (served by `idx_flows_type_time`).
 */
export function unionOver(
  pieces: readonly RangePiece[],
  flowType: string,
  source: UnionSource
): { sql: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];

  for (const piece of pieces) {
    if (piece.level === 'raw') {
      parts.push(
        `SELECT ${source.rawColumns} FROM flows
         WHERE flow_type = ? AND time >= ? AND time < ? ${source.rawWhere?.sql ?? ''}`
      );
      params.push(flowType, piece.fromTime, piece.toTime, ...(source.rawWhere?.params ?? []));
    } else {
      const index = source.indexes?.[piece.level];
      parts.push(
        `SELECT ${source.rollupColumns}
         FROM ${source.tables[piece.level]} ${index ? `INDEXED BY ${index}` : ''}
         WHERE flow_type = ? AND bucket BETWEEN ? AND ? ${source.rollupWhere?.sql ?? ''}`
      );
      params.push(
        flowType,
        piece.fromBucket,
        piece.toBucket,
        ...(source.rollupWhere?.params ?? [])
      );
    }
  }

  return { sql: parts.join('\nUNION ALL\n'), params };
}

/**
 * Totals for one direction (buying or selling) inside a window.
 *
 * The window is decomposed (`ranges.ts`) into daily rollups for whole days, hourly rollups
 * towards the edges and raw `flows` only for the partial hour at each end. The cost is
 * O(days in the period), not O(events): a 6-month summary reads ~180 daily buckets per
 * combination instead of grouping millions of flows (#2, #4).
 *
 * Rollups outlive the raw retention window. Where a window reaches back before the oldest
 * raw block, a partial hour cannot be read exactly and is rounded to the nearest whole hour —
 * at most 30 minutes out on a period of months.
 */
export function summariseFlow(
  db: Db,
  window: PeriodWindow,
  flowType: 'buying' | 'selling'
): FlowSummary {
  return summariseFlowRange(db, openRange(window), flowType);
}

/** {@link summariseFlow} over any range, open or closed (a previous-period window). */
export function summariseFlowRange(
  db: Db,
  range: TimeRange,
  flowType: 'buying' | 'selling'
): FlowSummary {
  const pieces = decompose(range.fromTime, range.toTime, {
    levels: [ROLLUP_LEVELS.rollup_hourly, ROLLUP_LEVELS.rollup_daily],
    rawFrom: rawCoverageFrom(db),
    open: range.open
  });

  const counterpartyKind = flowType === 'buying' ? 'to_kind' : 'from_kind';
  const union = unionOver(pieces, flowType, {
    tables: ['rollup_hourly', 'rollup_daily'],
    rollupColumns: 'counterparty_kind AS kind, exchange, sat, count',
    rawColumns: `${counterpartyKind} AS kind, COALESCE(exchange, '') AS exchange, sat, 1 AS count`
  });

  const rows = union.sql
    ? db
        .prepare<
          (string | number)[],
          { kind: string; exchange: string; totalSat: number; count: number }
        >(
          `SELECT kind, exchange, SUM(sat) AS totalSat, SUM(count) AS count
           FROM (${union.sql})
           GROUP BY kind, exchange`
        )
        .all(...union.params)
    : [];

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

export interface SeriesPoint {
  /** Bucket start in seconds; the first point starts at the window's start. */
  readonly time: number;
  readonly buying: number;
  readonly selling: number;
  /** Buying minus selling: positive means FLUX left the exchanges. */
  readonly net: number;
  /** Running total of `net` from the window's start. */
  readonly cumulativeNet: number;
}

/**
 * Buying, selling and net per bucket, for the net-flow chart (#29).
 *
 * One rollup table read for both directions. The first bucket would include flows from
 * before the window, so where raw data covers it, it is read from raw rows instead.
 */
export function flowSeries(
  db: Db,
  window: PeriodWindow,
  options: { bucketSeconds: 3_600 | 86_400; exchange?: string; kind?: string }
): SeriesPoint[] {
  const size = options.bucketSeconds;
  const table = size === 3_600 ? 'rollup_hourly' : 'rollup_daily';
  const firstBucket = Math.floor(window.fromTime / size);
  const lastBucket = Math.floor(window.toTime / size);
  const exact = window.fromTime >= rawCoverageFrom(db);

  const rollupWhere: string[] = [];
  const rawWhere: string[] = [];
  const filterParams: string[] = [];

  if (options.exchange) {
    rollupWhere.push('exchange = ?');
    rawWhere.push('exchange = ?');
    filterParams.push(options.exchange);
  }
  if (options.kind) {
    rollupWhere.push('counterparty_kind = ?');
    rawWhere.push(`CASE flow_type WHEN 'buying' THEN to_kind ELSE from_kind END = ?`);
    filterParams.push(options.kind);
  }

  const and = (conditions: string[]) =>
    conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare<(string | number)[], { bucket: number; flowType: string; sat: number }>(
      `SELECT bucket, flow_type AS flowType, SUM(sat) AS sat FROM ${table}
       WHERE flow_type IN ('buying', 'selling') AND bucket BETWEEN ? AND ?${and(rollupWhere)}
       GROUP BY bucket, flow_type`
    )
    .all(exact ? firstBucket + 1 : firstBucket, lastBucket, ...filterParams);

  const byBucket = new Map<number, { buying: number; selling: number }>();
  const slot = (bucket: number) => {
    let entry = byBucket.get(bucket);
    if (!entry) byBucket.set(bucket, (entry = { buying: 0, selling: 0 }));
    return entry;
  };

  for (const row of rows) slot(row.bucket)[row.flowType as 'buying' | 'selling'] += row.sat;

  if (exact) {
    const edge = db
      .prepare<(string | number)[], { flowType: string; sat: number }>(
        `SELECT flow_type AS flowType, SUM(sat) AS sat FROM flows
         WHERE flow_type IN ('buying', 'selling') AND time >= ? AND time < ?${and(rawWhere)}
         GROUP BY flow_type`
      )
      .all(window.fromTime, (firstBucket + 1) * size, ...filterParams);
    for (const row of edge) slot(firstBucket)[row.flowType as 'buying' | 'selling'] += row.sat;
  }

  const points: SeriesPoint[] = [];
  let cumulative = 0;

  // Every bucket, including empty ones, so a chart's x-axis is evenly spaced.
  for (let bucket = firstBucket; bucket <= lastBucket; bucket++) {
    const entry = byBucket.get(bucket) ?? { buying: 0, selling: 0 };
    const net = entry.buying - entry.selling;
    cumulative += net;
    points.push({
      time: bucket === firstBucket ? window.fromTime : bucket * size,
      buying: entry.buying / SATS_PER_FLUX,
      selling: entry.selling / SATS_PER_FLUX,
      net: net / SATS_PER_FLUX,
      cumulativeNet: cumulative / SATS_PER_FLUX
    });
  }

  return points;
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
      // One subquery each: SQLite answers a lone MIN/MAX from one end of an index, but several
      // aggregates in a single SELECT scan the whole table (120 ms at 518k blocks; 0.2 ms now).
      `SELECT (SELECT COUNT(*) FROM blocks) AS count,
              (SELECT MIN(height) FROM blocks) AS minHeight,
              (SELECT MAX(height) FROM blocks) AS maxHeight,
              (SELECT MIN(time) FROM blocks) AS minTime,
              (SELECT MAX(time) FROM blocks) AS maxTime`
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
