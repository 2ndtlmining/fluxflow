import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import {
  createTestDb,
  seedFlows,
  SATS,
  startTestServer,
  type Db,
  type SeedFlow
} from '../testkit.js';
import { BlockWriter } from '../ingest/writer.js';
import { openDatabase } from '../db/database.js';
import { MIGRATIONS, migrate } from '../db/migrations.js';
import { createTestConfig } from '../testkit.js';
import { ResponseCache } from './cache.js';
import { dataVersion, resolvePeriod, summariseFlow } from './queries.js';

const HOUR = 3_600;
/** Hour-aligned, so offsets read as "minutes into the hour". */
const BASE = 1_756_000_800 - (1_756_000_800 % HOUR);

const KINDS = ['unknown', 'node_operator', 'foundation'] as const;
const EXCHANGES = ['Kucoin', 'Coinex', 'GateIO', null] as const;

/** A deterministic pseudo-random sequence, so a failure reproduces. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

function randomFlows(count: number, seed = 1, secondsPerBlock = 30): SeedFlow[] {
  const next = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;

  return Array.from({ length: count }, (_, i) => {
    const flowType = pick(['buying', 'selling', 'p2p'] as const);
    const height = 1 + Math.floor(i / 3);
    return {
      txid: `tx-${i}`,
      vout: 0,
      height,
      // Several flows per 30-second block, spread over many hours.
      time: BASE + height * secondsPerBlock,
      fromAddress: `t1from${i % 17}`,
      fromKind: flowType === 'buying' ? 'exchange' : pick(KINDS),
      toAddress: `t1to${i % 13}`,
      toKind: flowType === 'selling' ? 'exchange' : pick(KINDS),
      flowType,
      exchange: flowType === 'p2p' ? null : pick(EXCHANGES),
      amountFlux: Math.round(next() * 10_000) / 100
    };
  });
}

/** Rollup totals vs raw totals, per (type, counterparty, exchange). Must be identical. */
function mismatches(db: Db): unknown[] {
  return ['rollup_hourly', 'rollup_daily'].flatMap((table) => mismatchesIn(db, table));
}

function mismatchesIn(db: Db, table: string): unknown[] {
  return db
    .prepare(
      `WITH raw AS (
         SELECT flow_type, CASE flow_type WHEN 'buying' THEN to_kind ELSE from_kind END AS kind,
                COALESCE(exchange, '') AS exchange, SUM(sat) AS sat, COUNT(*) AS count
         FROM flows GROUP BY 1, 2, 3
       ), roll AS (
         SELECT flow_type, counterparty_kind AS kind, exchange,
                SUM(sat) AS sat, SUM(count) AS count
         FROM ${table} GROUP BY 1, 2, 3
       )
       SELECT * FROM raw FULL OUTER JOIN roll USING (flow_type, kind, exchange)
       WHERE raw.sat IS NOT roll.sat OR raw.count IS NOT roll.count`
    )
    .all();
}

/** The exact answer, straight from raw rows: what the rollup path must reproduce. */
function rawTotal(db: Db, flowType: string, fromTime: number): number {
  const row = db
    .prepare<[string, number], { sat: number | null }>(
      `SELECT SUM(sat) AS sat FROM flows WHERE flow_type = ? AND time >= ?`
    )
    .get(flowType, fromTime);

  return (row?.sat ?? 0) / SATS;
}

const count = (db: Db, sql: string): number =>
  db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`).get()!.n;

describe('rollups (#4)', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.close());

  it('match raw sums after inserts', () => {
    seedFlows(db, randomFlows(2_000));
    expect(count(db, 'rollup_hourly')).toBeGreaterThan(0);
    expect(mismatches(db)).toEqual([]);
  });

  it('match raw sums after every flow is rewritten in place (a corrected label)', () => {
    seedFlows(db, randomFlows(500));
    // Same keys, different kinds, exchanges and amounts.
    seedFlows(db, randomFlows(500, 99));

    expect(mismatches(db)).toEqual([]);
  });

  it('match raw sums after the writer upserts the same flows again', () => {
    seedFlows(db, randomFlows(300));

    // Re-running a sync over stored heights goes through the writer's ON CONFLICT path.
    const upsert = db.prepare(
      `INSERT INTO flows (txid, vout, height, time, from_address, from_kind, to_address,
                          to_kind, exchange, flow_type, sat)
       SELECT txid, vout, height, time, from_address, 'node_operator', to_address, to_kind,
              exchange, flow_type, sat * 2
       FROM flows
       WHERE 1
       ON CONFLICT (txid, vout) DO UPDATE SET from_kind = excluded.from_kind, sat = excluded.sat`
    );
    db.transaction(() => upsert.run())();

    expect(mismatches(db)).toEqual([]);
  });

  it('match raw sums after a reorg rollback', () => {
    seedFlows(db, randomFlows(1_000));
    new BlockWriter(db).rollbackFrom(200);

    expect(count(db, 'flows WHERE height >= 200')).toBe(0);
    expect(mismatches(db)).toEqual([]);
  });

  it('outlive raw data pruned by retention', () => {
    seedFlows(db, randomFlows(1_000));
    const sum = () =>
      db
        .prepare(
          `SELECT (SELECT SUM(sat) FROM rollup_hourly) AS hourly,
                  (SELECT SUM(sat) FROM rollup_daily) AS daily`
        )
        .get();
    const before = sum();

    new BlockWriter(db).pruneBefore(200);

    // Raw rows are gone, the totals are not: a 1Y figure survives a 180-day raw window.
    expect(count(db, 'flows WHERE height < 200')).toBe(0);
    expect(sum()).toEqual(before);
    // The flag is cleared in the same transaction, so a later rollback still corrects totals.
    expect(count(db, `sync_state WHERE key = 'rollup_retain'`)).toBe(0);
  });

  it('give the exact total for windows that start mid-hour', () => {
    // Ten minutes per block: ~3.5 days, so windows cross day boundaries.
    seedFlows(db, randomFlows(1_500, 3, 600));
    const maxTime = db.prepare<[], { t: number }>(`SELECT MAX(time) AS t FROM blocks`).get()!.t;

    for (const minutesBack of [1, 37, 61, 90, 6 * 60, 25 * 60 + 13, 49 * 60 + 41, 80 * 60]) {
      const fromTime = maxTime - minutesBack * 60;
      const window = resolvePeriod(db, fromTime);

      for (const flowType of ['buying', 'selling'] as const) {
        expect(summariseFlow(db, window, flowType).totalSat).toBeCloseTo(
          rawTotal(db, flowType, fromTime),
          6
        );
      }
    }
  });
});

describe('data version', () => {
  it('changes whenever stored blocks change', () => {
    const db = createTestDb();
    const v0 = dataVersion(db);

    seedFlows(db, randomFlows(10));
    const v1 = dataVersion(db);
    expect(v1).toBeGreaterThan(v0);

    new BlockWriter(db).rollbackFrom(2);
    expect(dataVersion(db)).toBeGreaterThan(v1);

    db.close();
  });
});

describe('ResponseCache (#3, #4)', () => {
  it('answers 304 while the data is unchanged, and recomputes after a sync', async () => {
    const db = createTestDb();
    seedFlows(db, randomFlows(10));

    const cache = new ResponseCache(db);
    let computed = 0;
    const app = express();
    app.get('/x', (req, res) => cache.send(req, res, () => ({ n: ++computed })));
    const server = await startTestServer(app);

    try {
      const first = await fetch(`${server.url}/x`);
      const etag = first.headers.get('etag')!;
      expect(await first.json()).toEqual({ n: 1 });

      // Same data: revalidation costs no body and no computation.
      const again = await fetch(`${server.url}/x`, { headers: { 'If-None-Match': etag } });
      expect(again.status).toBe(304);
      // Another viewer without the ETag is served from memory.
      expect(await (await fetch(`${server.url}/x`)).json()).toEqual({ n: 1 });

      // A sync commits blocks: the old ETag no longer matches and the answer is recomputed.
      seedFlows(db, randomFlows(40, 7).slice(30));
      const after = await fetch(`${server.url}/x`, { headers: { 'If-None-Match': etag } });
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual({ n: 2 });
    } finally {
      await server.close();
      db.close();
    }
  });

  it('reuses an expensive answer across syncs within maxStaleMs, with a matching ETag', async () => {
    const db = createTestDb();
    seedFlows(db, randomFlows(10));

    const cache = new ResponseCache(db);
    let computed = 0;
    const app = express();
    app.get('/slow', (req, res) =>
      cache.send(req, res, () => ({ n: ++computed }), { maxStaleMs: 60_000 })
    );
    app.get('/live', (req, res) => cache.send(req, res, () => ({ n: ++computed })));
    const server = await startTestServer(app);

    try {
      const first = await fetch(`${server.url}/slow`);
      const etag = first.headers.get('etag')!;
      expect(await first.json()).toEqual({ n: 1 });

      seedFlows(db, randomFlows(40, 7).slice(30));

      // Within the window: the earlier answer, and an ETag that still describes it.
      const reused = await fetch(`${server.url}/slow`);
      expect(await reused.json()).toEqual({ n: 1 });
      expect(reused.headers.get('etag')).toBe(etag);
      expect(
        (await fetch(`${server.url}/slow`, { headers: { 'If-None-Match': etag } })).status
      ).toBe(304);

      // Without maxStaleMs the new data is reflected at once.
      expect(await (await fetch(`${server.url}/live`)).json()).toEqual({ n: 2 });
    } finally {
      await server.close();
      db.close();
    }
  });
});

describe('upgrading a schema-1 database (#4)', () => {
  it('backfills the rollups from flows already stored', () => {
    const db = openDatabase({
      config: createTestConfig(),
      log: { debug: () => {}, info: () => {}, error: () => {} } as never,
      inMemory: true
    });

    // A database as #42/#43 left it: schema 1, flows written, no rollup tables yet.
    db.transaction(() => {
      MIGRATIONS[0]!.up(db);
      db.pragma('user_version = 1');
    })();
    seedFlows(db, randomFlows(800));

    const result = migrate(db);

    expect(result).toMatchObject({ from: 1, to: MIGRATIONS.length });
    expect(count(db, 'rollup_daily')).toBeGreaterThan(0);
    expect(mismatches(db)).toEqual([]);
    expect(dataVersion(db)).toBeGreaterThan(0);

    db.close();
  });
});
